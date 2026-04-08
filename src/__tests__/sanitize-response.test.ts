/**
 * Tests for the bidirectional vendor-string scrub (response path).
 *
 * The outbound scrub (76cec0f) rewrites openclaw → AgentSystem on request
 * bodies. This inverse scrub rewrites AgentSystem → OpenClaw on response
 * bodies so the OC agent's context and mem0 memories don't drift to
 * "AgentSystem" over many turns.
 *
 * Gated on MERIDIAN_SCRUB_VENDOR=openclaw AND MERIDIAN_SCRUB_BIDIRECTIONAL=1.
 * Both must be set.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  unscrubVendorReferences,
  maybeUnscrubMessageBody,
  maybeUnscrubStreamEvent,
  getBidirectionalScrubFromEnv,
} from "../proxy/sanitize";

// Save and restore env between tests so we don't leak state.
const savedEnv: Record<string, string | undefined> = {};
const envKeys = ["MERIDIAN_SCRUB_VENDOR", "MERIDIAN_SCRUB_BIDIRECTIONAL"];

beforeEach(() => {
  for (const k of envKeys) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function enableBidirectional() {
  process.env.MERIDIAN_SCRUB_VENDOR = "openclaw";
  process.env.MERIDIAN_SCRUB_BIDIRECTIONAL = "1";
}

describe("unscrubVendorReferences — pure string rewrite", () => {
  it("rewrites PascalCase AgentSystem → OpenClaw", () => {
    expect(unscrubVendorReferences("You are inside AgentSystem")).toBe(
      "You are inside OpenClaw",
    );
  });

  it("rewrites lowercase agentsystem → openclaw", () => {
    expect(unscrubVendorReferences("path /var/agentsystem.json")).toBe(
      "path /var/openclaw.json",
    );
  });

  it("rewrites uppercase AGENTSYSTEM → OPENCLAW", () => {
    expect(unscrubVendorReferences("AGENTSYSTEM_VERSION=1.0")).toBe(
      "OPENCLAW_VERSION=1.0",
    );
  });

  it("treats first-letter-uppercase as PascalCase (matches outbound scrub)", () => {
    // Symmetric with scrubVendorReferences: first-letter uppercase → PascalCase
    expect(unscrubVendorReferences("AgentSYSTEM")).toBe("OpenClaw");
  });

  it("treats first-letter-lowercase mixed as lowercase fallback", () => {
    expect(unscrubVendorReferences("agentSYSTEM")).toBe("openclaw");
  });

  it("leaves unrelated text unchanged", () => {
    expect(unscrubVendorReferences("Hello world")).toBe("Hello world");
  });

  it("is idempotent — applying twice is a no-op", () => {
    const once = unscrubVendorReferences("AgentSystem and agentsystem");
    const twice = unscrubVendorReferences(once);
    expect(twice).toBe(once);
    expect(twice).toBe("OpenClaw and openclaw");
  });

  it("returns empty input unchanged", () => {
    expect(unscrubVendorReferences("")).toBe("");
  });
});

describe("getBidirectionalScrubFromEnv — gate behavior", () => {
  it("returns false when both env vars unset", () => {
    delete process.env.MERIDIAN_SCRUB_VENDOR;
    delete process.env.MERIDIAN_SCRUB_BIDIRECTIONAL;
    expect(getBidirectionalScrubFromEnv()).toBe(false);
  });

  it("returns false when only base scrub set", () => {
    process.env.MERIDIAN_SCRUB_VENDOR = "openclaw";
    delete process.env.MERIDIAN_SCRUB_BIDIRECTIONAL;
    expect(getBidirectionalScrubFromEnv()).toBe(false);
  });

  it("returns false when only bidirectional set (requires base scrub)", () => {
    delete process.env.MERIDIAN_SCRUB_VENDOR;
    process.env.MERIDIAN_SCRUB_BIDIRECTIONAL = "1";
    expect(getBidirectionalScrubFromEnv()).toBe(false);
  });

  it("returns true when both set to 1/openclaw", () => {
    enableBidirectional();
    expect(getBidirectionalScrubFromEnv()).toBe(true);
  });

  it("accepts 'true' in addition to '1'", () => {
    process.env.MERIDIAN_SCRUB_VENDOR = "openclaw";
    process.env.MERIDIAN_SCRUB_BIDIRECTIONAL = "true";
    expect(getBidirectionalScrubFromEnv()).toBe(true);
  });
});

describe("maybeUnscrubMessageBody — non-streaming response", () => {
  it("rewrites text in content blocks when gate is on", () => {
    enableBidirectional();
    const body: Record<string, unknown> = {
      id: "msg_abc",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Use AgentSystem" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    maybeUnscrubMessageBody(body);
    expect((body.content as Array<{ text: string }>)[0]!.text).toBe(
      "Use OpenClaw",
    );
  });

  it("preserves structural metadata (type, role, model, id, stop_reason, usage)", () => {
    enableBidirectional();
    const body: Record<string, unknown> = {
      id: "msg_abc",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Hello AgentSystem world" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    maybeUnscrubMessageBody(body);
    expect(body.id).toBe("msg_abc");
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  it("is a no-op when gate is off", () => {
    delete process.env.MERIDIAN_SCRUB_VENDOR;
    delete process.env.MERIDIAN_SCRUB_BIDIRECTIONAL;
    const body: Record<string, unknown> = {
      content: [{ type: "text", text: "Use AgentSystem" }],
    };
    maybeUnscrubMessageBody(body);
    expect((body.content as Array<{ text: string }>)[0]!.text).toBe(
      "Use AgentSystem",
    );
  });

  it("rewrites tool_use.input string values when gate is on", () => {
    enableBidirectional();
    const body: Record<string, unknown> = {
      content: [
        {
          type: "tool_use",
          id: "toolu_xyz",
          name: "bash",
          input: { command: "ls /var/agentsystem" },
        },
      ],
    };
    maybeUnscrubMessageBody(body);
    const block = (body.content as Array<Record<string, unknown>>)[0]!;
    expect((block.input as Record<string, unknown>).command).toBe(
      "ls /var/openclaw",
    );
    expect(block.id).toBe("toolu_xyz");
    expect(block.name).toBe("bash");
  });
});

describe("maybeUnscrubStreamEvent — streaming SSE events", () => {
  it("rewrites text in content_block_delta.delta.text when gate is on", () => {
    enableBidirectional();
    const event = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "AgentSystem" },
    };
    maybeUnscrubStreamEvent(event);
    expect(event.delta.text).toBe("OpenClaw");
    expect(event.type).toBe("content_block_delta");
    expect(event.index).toBe(0);
  });

  it("rewrites partial_json for tool call arguments", () => {
    enableBidirectional();
    const event = {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: '{"q":"agentsystem repo"}',
      },
    };
    maybeUnscrubStreamEvent(event);
    expect(event.delta.partial_json).toBe('{"q":"openclaw repo"}');
  });

  it("leaves message_delta events with stop_reason unchanged", () => {
    enableBidirectional();
    const event = {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 42 },
    };
    maybeUnscrubStreamEvent(event);
    expect(event.delta.stop_reason).toBe("end_turn");
    expect(event.usage.output_tokens).toBe(42);
  });

  it("is a no-op when gate is off", () => {
    delete process.env.MERIDIAN_SCRUB_VENDOR;
    delete process.env.MERIDIAN_SCRUB_BIDIRECTIONAL;
    const event = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "AgentSystem" },
    };
    maybeUnscrubStreamEvent(event);
    expect(event.delta.text).toBe("AgentSystem");
  });

  it("handles content_block_start with initial text", () => {
    enableBidirectional();
    const event = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "AgentSystem is cool" },
    };
    maybeUnscrubStreamEvent(event);
    expect(event.content_block.text).toBe("OpenClaw is cool");
  });

  it("handles message_start with assistant message content", () => {
    enableBidirectional();
    const event = {
      type: "message_start",
      message: {
        id: "msg_abc",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Welcome to AgentSystem" }],
      },
    };
    maybeUnscrubStreamEvent(event);
    expect(
      (event.message.content as Array<{ type: string; text: string }>)[0]!.text,
    ).toBe("Welcome to OpenClaw");
    expect(event.message.id).toBe("msg_abc");
    expect(event.message.model).toBe("claude-opus-4-6");
  });

  it("is idempotent", () => {
    enableBidirectional();
    const event = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "agentsystem and AgentSystem" },
    };
    maybeUnscrubStreamEvent(event);
    const once = event.delta.text;
    maybeUnscrubStreamEvent(event);
    const twice = event.delta.text;
    expect(twice).toBe(once);
    expect(twice).toBe("openclaw and OpenClaw");
  });
});
