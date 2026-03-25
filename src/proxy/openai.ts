/**
 * OpenAI API compatibility layer.
 *
 * Transcodes OpenAI-format requests to Anthropic format, forwards them
 * to the internal /v1/messages handler, and converts responses back.
 *
 * Supported:
 *   POST /v1/chat/completions   — Chat completions (main endpoint)
 *   POST /v1/completions        — Legacy text completions
 *   POST /v1/responses          — Responses API
 *   GET  /v1/models             — List available models
 *   GET  /v1/models/:id         — Get specific model
 *
 * Unsupported (returns 501):
 *   POST /v1/embeddings, /v1/audio/*, /v1/images/*
 */

import { Hono } from "hono"
import type { Context } from "hono"

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

export interface ModelEntry {
  id: string
  aliases: string[]
  claudeModel: string
  contextWindow: number
  maxOutput: number
}

// Claude Max available models — only confirmed working models
export const MODEL_CATALOG: ModelEntry[] = [
  {
    id: "claude-opus-4-6",
    aliases: ["opus", "opus-4.6", "claude-opus-4-6-20250610"],
    claudeModel: "opus",
    contextWindow: 1000000,
    maxOutput: 16384,
  },
  {
    id: "claude-sonnet-4-6",
    aliases: ["sonnet", "sonnet-4.6", "claude-sonnet-4-6-20250514"],
    claudeModel: "sonnet",
    contextWindow: 200000,
    maxOutput: 16384,
  },
  {
    id: "claude-haiku-4-5",
    aliases: ["haiku", "haiku-4.5", "claude-haiku-4-5-20251001"],
    claudeModel: "haiku",
    contextWindow: 200000,
    maxOutput: 16384,
  },
]

function resolveModel(model: string): ModelEntry {
  const lower = model.toLowerCase()
  for (const m of MODEL_CATALOG) {
    if (m.id === lower || m.aliases.includes(lower)) return m
  }
  // Default to sonnet
  return MODEL_CATALOG[0]!
}

function toOpenAIModel(entry: ModelEntry): object {
  return {
    id: entry.id,
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
    permission: [],
    root: entry.id,
    parent: null,
  }
}

// ---------------------------------------------------------------------------
// Request transcoding: OpenAI → Anthropic
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool" | "function"
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null
  name?: string
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function transcodeRequest(body: any): { anthropicBody: any; model: string } {
  const messages: OpenAIMessage[] = body.messages || []
  const model = resolveModel(body.model || "sonnet")

  // Extract system messages
  const systemParts: string[] = []
  const anthropicMessages: any[] = []

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
          : ""
      if (text) systemParts.push(text)
      continue
    }

    if (msg.role === "tool") {
      // OpenAI tool result → Anthropic tool_result
      anthropicMessages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        }],
      })
      continue
    }

    if (msg.role === "assistant" && msg.tool_calls) {
      // Assistant with tool_calls → Anthropic tool_use blocks
      const content: any[] = []
      if (msg.content) {
        content.push({ type: "text", text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) })
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        })
      }
      anthropicMessages.push({ role: "assistant", content })
      continue
    }

    // Regular user/assistant message
    let content: any
    if (typeof msg.content === "string") {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map((block: any) => {
        if (block.type === "text") return { type: "text", text: block.text }
        if (block.type === "image_url" && block.image_url?.url) {
          // Data URL → Anthropic image block
          const url = block.image_url.url
          if (url.startsWith("data:")) {
            const match = url.match(/^data:(image\/\w+);base64,(.+)$/)
            if (match) {
              return {
                type: "image",
                source: { type: "base64", media_type: match[1], data: match[2] },
              }
            }
          }
          // URL reference — pass as-is (Anthropic supports URL images)
          return { type: "image", source: { type: "url", url } }
        }
        return { type: "text", text: JSON.stringify(block) }
      })
    } else {
      content = msg.content ?? ""
    }

    anthropicMessages.push({
      role: msg.role === "function" ? "user" : msg.role,
      content,
    })
  }

  // Build Anthropic request body
  const anthropicBody: any = {
    model: model.id,
    messages: anthropicMessages,
    stream: body.stream ?? false,
  }

  if (systemParts.length > 0) {
    anthropicBody.system = systemParts.join("\n\n")
  }

  // Map parameters
  if (body.max_tokens != null) anthropicBody.max_tokens = body.max_tokens
  if (body.max_completion_tokens != null) anthropicBody.max_tokens = body.max_completion_tokens
  if (body.temperature != null) anthropicBody.temperature = body.temperature
  if (body.top_p != null) anthropicBody.top_p = body.top_p
  if (body.stop != null) anthropicBody.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]

  // Map tools
  if (Array.isArray(body.tools)) {
    anthropicBody.tools = body.tools.map((t: any) => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || "",
      input_schema: t.function?.parameters || t.parameters || { type: "object", properties: {} },
    }))
  }

  return { anthropicBody, model: model.id }
}

// ---------------------------------------------------------------------------
// Response transcoding: Anthropic → OpenAI
// ---------------------------------------------------------------------------

function mapStopReason(reason: string | null): string {
  if (reason === "tool_use") return "tool_calls"
  if (reason === "max_tokens") return "length"
  if (reason === "end_turn" || reason === "stop") return "stop"
  return "stop"
}

function transcodeResponse(anthropicResp: any, requestModel: string): object {
  const content = anthropicResp.content || []

  // Extract text and tool_use blocks
  const textParts: string[] = []
  const toolCalls: any[] = []
  let toolIdx = 0

  for (const block of content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text)
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        index: toolIdx++,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      })
    }
  }

  const message: any = {
    role: "assistant",
    content: textParts.join("\n") || null,
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  return {
    id: `chatcmpl-${anthropicResp.id || Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: [{
      index: 0,
      message,
      finish_reason: mapStopReason(anthropicResp.stop_reason),
    }],
    usage: {
      prompt_tokens: anthropicResp.usage?.input_tokens || 0,
      completion_tokens: anthropicResp.usage?.output_tokens || 0,
      total_tokens: (anthropicResp.usage?.input_tokens || 0) + (anthropicResp.usage?.output_tokens || 0),
    },
  }
}

// ---------------------------------------------------------------------------
// Streaming transcoding: Anthropic SSE → OpenAI SSE
// ---------------------------------------------------------------------------

function transcodeStreamChunk(eventType: string, data: any, requestModel: string, chatId: string): string | null {
  const ts = Math.floor(Date.now() / 1000)

  if (eventType === "message_start") {
    // Emit initial chunk with role
    const chunk = {
      id: chatId,
      object: "chat.completion.chunk",
      created: ts,
      model: requestModel,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  if (eventType === "content_block_start") {
    const block = data.content_block
    if (block?.type === "tool_use") {
      const chunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created: ts,
        model: requestModel,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: data.index || 0,
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      }
      return `data: ${JSON.stringify(chunk)}\n\n`
    }
    return null
  }

  if (eventType === "content_block_delta") {
    const delta = data.delta
    if (delta?.type === "text_delta" && delta.text) {
      const chunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created: ts,
        model: requestModel,
        choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
      }
      return `data: ${JSON.stringify(chunk)}\n\n`
    }
    if (delta?.type === "input_json_delta" && delta.partial_json) {
      const chunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created: ts,
        model: requestModel,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: data.index || 0,
              function: { arguments: delta.partial_json },
            }],
          },
          finish_reason: null,
        }],
      }
      return `data: ${JSON.stringify(chunk)}\n\n`
    }
    return null
  }

  if (eventType === "message_delta") {
    const stopReason = data.delta?.stop_reason
    const chunk = {
      id: chatId,
      object: "chat.completion.chunk",
      created: ts,
      model: requestModel,
      choices: [{ index: 0, delta: {}, finish_reason: mapStopReason(stopReason) }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: data.usage?.output_tokens || 0,
      },
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  if (eventType === "message_stop") {
    return `data: [DONE]\n\n`
  }

  return null
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createOpenAIRoutes(internalFetch: (request: Request) => Response | Promise<Response>) {
  const routes = new Hono()

  // GET /models
  routes.get("/models", (c) => {
    return c.json({ object: "list", data: MODEL_CATALOG.map(toOpenAIModel) })
  })

  // GET /models/:id
  routes.get("/models/:id", (c) => {
    const id = c.req.param("id")
    const entry = MODEL_CATALOG.find(
      (m) => m.id === id || m.aliases.includes(id.toLowerCase())
    )
    if (!entry) {
      return c.json({ error: { message: `Model '${id}' not found`, type: "invalid_request_error" } }, 404)
    }
    return c.json(toOpenAIModel(entry))
  })

  // POST /chat/completions — main endpoint
  routes.post("/chat/completions", async (c) => {
    const body = await c.req.json()
    const { anthropicBody, model: requestModel } = transcodeRequest(body)
    const isStream = anthropicBody.stream

    // Forward auth headers from the original request
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const auth = c.req.header("authorization")
    const xApiKey = c.req.header("x-api-key")
    if (auth) headers["Authorization"] = auth
    if (xApiKey) headers["x-api-key"] = xApiKey

    // Forward OpenCode-specific headers
    const openCodeSession = c.req.header("x-opencode-session")
    if (openCodeSession) headers["x-opencode-session"] = openCodeSession

    const internalReq = new Request("http://internal/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicBody),
    })

    const resp = await internalFetch(internalReq)

    if (!isStream) {
      // Non-streaming: transcode the JSON response
      const anthropicResp = await resp.json() as any
      if (anthropicResp.error) {
        return c.json({ error: { message: anthropicResp.error.message, type: anthropicResp.error.type } }, resp.status as any)
      }
      return c.json(transcodeResponse(anthropicResp, requestModel))
    }

    // Streaming: transcode Anthropic SSE → OpenAI SSE
    const chatId = `chatcmpl-${Date.now()}`
    const encoder = new TextEncoder()

    const readable = new ReadableStream({
      async start(controller) {
        const reader = resp.body?.getReader()
        if (!reader) {
          controller.close()
          return
        }

        const decoder = new TextDecoder()
        let buffer = ""

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            // Parse SSE lines
            const lines = buffer.split("\n")
            buffer = lines.pop() || "" // keep incomplete line

            let eventType = ""
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim()
              } else if (line.startsWith("data: ") && eventType) {
                try {
                  const data = JSON.parse(line.slice(6))
                  const chunk = transcodeStreamChunk(eventType, data, requestModel, chatId)
                  if (chunk) {
                    controller.enqueue(encoder.encode(chunk))
                  }
                } catch {
                  // Skip unparseable data
                }
                eventType = ""
              } else if (line.startsWith(": ping")) {
                // Forward keepalive
                controller.enqueue(encoder.encode(": ping\n\n"))
              }
            }
          }

          // Ensure [DONE] is sent
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        } catch {
          // Stream ended
        } finally {
          try { controller.close() } catch {}
        }
      },
    })

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    })
  })

  // POST /completions — legacy text completions
  routes.post("/completions", async (c) => {
    const body = await c.req.json()
    // Convert to chat format
    const chatBody = {
      ...body,
      messages: [{ role: "user", content: body.prompt || "" }],
    }
    delete chatBody.prompt

    const { anthropicBody, model: requestModel } = transcodeRequest(chatBody)
    anthropicBody.stream = false

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const auth = c.req.header("authorization")
    const xApiKey = c.req.header("x-api-key")
    if (auth) headers["Authorization"] = auth
    if (xApiKey) headers["x-api-key"] = xApiKey

    const internalReq = new Request("http://internal/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicBody),
    })

    const resp = await internalFetch(internalReq)
    const anthropicResp = await resp.json() as any

    if (anthropicResp.error) {
      return c.json({ error: { message: anthropicResp.error.message, type: anthropicResp.error.type } }, resp.status as any)
    }

    const textParts = (anthropicResp.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)

    return c.json({
      id: `cmpl-${Date.now()}`,
      object: "text_completion",
      created: Math.floor(Date.now() / 1000),
      model: requestModel,
      choices: [{
        text: textParts.join(""),
        index: 0,
        finish_reason: mapStopReason(anthropicResp.stop_reason),
      }],
      usage: {
        prompt_tokens: anthropicResp.usage?.input_tokens || 0,
        completion_tokens: anthropicResp.usage?.output_tokens || 0,
        total_tokens: (anthropicResp.usage?.input_tokens || 0) + (anthropicResp.usage?.output_tokens || 0),
      },
    })
  })

  // POST /responses — OpenAI Responses API (simplified)
  routes.post("/responses", async (c) => {
    const body = await c.req.json()

    // Responses API accepts either `input` (string) or `messages` array
    let messages: any[]
    if (typeof body.input === "string") {
      messages = [{ role: "user", content: body.input }]
    } else if (Array.isArray(body.input)) {
      messages = body.input
    } else {
      messages = body.messages || [{ role: "user", content: "" }]
    }

    const chatBody = { ...body, messages, stream: false }

    const { anthropicBody, model: requestModel } = transcodeRequest(chatBody)

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const auth = c.req.header("authorization")
    const xApiKey = c.req.header("x-api-key")
    if (auth) headers["Authorization"] = auth
    if (xApiKey) headers["x-api-key"] = xApiKey

    const internalReq = new Request("http://internal/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicBody),
    })

    const resp = await internalFetch(internalReq)
    const anthropicResp = await resp.json() as any

    if (anthropicResp.error) {
      return c.json({ error: { message: anthropicResp.error.message, type: anthropicResp.error.type } }, resp.status as any)
    }

    // Build Responses API output format
    const output: any[] = []
    for (const block of anthropicResp.content || []) {
      if (block.type === "text") {
        output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: block.text }] })
      }
    }

    return c.json({
      id: `resp-${Date.now()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: requestModel,
      status: "completed",
      output,
      usage: {
        input_tokens: anthropicResp.usage?.input_tokens || 0,
        output_tokens: anthropicResp.usage?.output_tokens || 0,
        total_tokens: (anthropicResp.usage?.input_tokens || 0) + (anthropicResp.usage?.output_tokens || 0),
      },
    })
  })

  // --- Unsupported endpoints (return 501 with clear message) ---
  const unsupported = (name: string) => (c: Context) =>
    c.json({
      error: {
        message: `${name} is not supported. Meridian only supports text generation.`,
        type: "invalid_request_error",
        code: "unsupported_endpoint",
      },
    }, 501)

  routes.post("/embeddings", unsupported("Embeddings"))
  routes.post("/audio/transcriptions", unsupported("Audio transcription"))
  routes.post("/audio/speech", unsupported("Text-to-speech"))
  routes.post("/images/generations", unsupported("Image generation"))
  routes.post("/images/edits", unsupported("Image editing"))
  routes.post("/images/variations", unsupported("Image variations"))

  return routes
}
