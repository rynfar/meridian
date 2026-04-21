/**
 * System Prompt Redirect
 *
 * Moves the client's system prompt into the first user message.
 * Useful for agents that need the system prompt visible in the
 * conversation history rather than as a separate API parameter.
 *
 * Drop this file (or its compiled .js output) in ~/.config/meridian/plugins/
 * to activate, or reference an absolute path from plugins.json.
 *
 * NOTE on the import path below: this example lives inside meridian's source
 * tree for dogfooding, so it uses a relative path. When authoring your own
 * plugin in a separate repository, install `@rynfar/meridian` as a peer
 * dependency and use the published package path instead:
 *
 *   import type { Transform, RequestContext } from "@rynfar/meridian"
 */

import type { Transform, RequestContext } from "../../src/proxy/transform"

export default {
  name: "system-prompt-redirect",
  version: "1.0.0",
  description: "Moves client system prompt into the first user message",

  onRequest(ctx: RequestContext): RequestContext {
    if (!ctx.systemContext) return ctx
    return {
      ...ctx,
      messages: [
        {
          role: "user",
          content: `<system-instructions>\n${ctx.systemContext}\n</system-instructions>`,
        },
        ...ctx.messages,
      ],
      systemContext: undefined,
    }
  },
} satisfies Transform
