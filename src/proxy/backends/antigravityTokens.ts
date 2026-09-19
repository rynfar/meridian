import { blocks, renderAgPrompt, type AgBlock, type AgMessage, type AgRequest } from './antigravityProtocol'

/** Planning estimate only: agy exposes neither its tokenizer nor hidden harness context. */
export function estimateAgTokens(request: AgRequest) {
  let images = 0, unprocessedMedia = 0
  function attachment(block: Exclude<AgBlock, { type: 'tool_use' | 'tool_result' }>): { type: 'text'; text: string } {
    if (block.type === 'text') return block
    if (block.type === 'image') { images++; return { type: 'text', text: '[image attachment]' } }
    if (block.type === 'document' && block.source.media_type === 'text/plain') return { type: 'text', text: block.source.type === 'text' ? block.source.data : Buffer.from(block.source.data, 'base64').toString('utf8') }
    // No fetching, rendering or transcription in the count endpoint. Their
    // content is explicitly excluded, instead of counting binary base64 as text.
    unprocessedMedia++
    return { type: 'text', text: `[${block.type} attachment: preprocessing unavailable to token estimate]` }
  }
  const messages: AgMessage[] = request.messages.map(message => ({ ...message, content: blocks(message).map(block => {
    if (block.type === 'tool_use') return block
    if (block.type === 'tool_result') return Array.isArray(block.content) ? { ...block, content: block.content.map(attachment) } : block
    return attachment(block)
  }) }))
  return {
    input_tokens: Math.ceil(Buffer.byteLength(renderAgPrompt({ ...request, messages }), 'utf8') / 4) + images * 1568,
    estimated: true,
    estimation: { method: 'utf8-bytes-divided-by-four', image_tokens_per_attachment: 1568, includes_cli_context: false, exact_tokenizer_available: false, excluded_unprocessed_media: unprocessedMedia },
  }
}
