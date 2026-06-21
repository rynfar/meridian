import { describe, it, expect } from "bun:test"
import {
  runTransformHook,
  createRequestContext,
  type RequestContext,
} from "../proxy/transform"
import {
  stripHermesBoilerplateTransform,
  HERMES_BOILERPLATE_ANCHOR,
  openAiTransforms,
} from "../proxy/transforms/openai"
import { getAdapterTransforms } from "../proxy/transforms/registry"

function makeCtx(systemContext: string | undefined, adapter = "openai"): RequestContext {
  return createRequestContext({
    adapter,
    body: {},
    headers: new Headers(),
    model: "opus",
    messages: [],
    systemContext,
    stream: false,
    workingDirectory: "/tmp",
  })
}

const PERSONA = "# Bob — PublicAI CPO Agent\n\nYou are Bob, PublicAI's CPO.\n\n"
const BOILERPLATE = `${HERMES_BOILERPLATE_ANCHOR} (by Nous Research). Load the hermes skill...\nYou are a CLI AI Agent.`

describe("stripHermesBoilerplateTransform", () => {
  it("truncates the system prompt at the Hermes boilerplate anchor", () => {
    const out = stripHermesBoilerplateTransform.onRequest!(makeCtx(PERSONA + BOILERPLATE))
    expect(out.systemContext).toBe(PERSONA.trimEnd())
    expect(out.systemContext).not.toContain(HERMES_BOILERPLATE_ANCHOR)
  })

  it("keeps the persona/identity that precedes the anchor", () => {
    const out = stripHermesBoilerplateTransform.onRequest!(makeCtx(PERSONA + BOILERPLATE))
    expect(out.systemContext).toContain("You are Bob")
  })

  it("is a no-op when the anchor is absent", () => {
    const sys = "# Alice\n\nYou are Alice, a personal advisor."
    const out = stripHermesBoilerplateTransform.onRequest!(makeCtx(sys))
    expect(out.systemContext).toBe(sys)
  })

  it("is a no-op when the anchor sits at the very start (no persona to keep)", () => {
    const sys = BOILERPLATE
    const out = stripHermesBoilerplateTransform.onRequest!(makeCtx(sys))
    expect(out.systemContext).toBe(sys)
  })

  it("is a no-op when systemContext is undefined", () => {
    const out = stripHermesBoilerplateTransform.onRequest!(makeCtx(undefined))
    expect(out.systemContext).toBeUndefined()
  })

  it("only runs for the openai adapter (skipped for others)", () => {
    const ctx = makeCtx(PERSONA + BOILERPLATE, "opencode")
    const out = runTransformHook([stripHermesBoilerplateTransform], "onRequest", ctx, "opencode")
    expect(out.systemContext).toBe(PERSONA + BOILERPLATE) // unchanged for opencode
  })

  it("runs via runTransformHook for the openai adapter", () => {
    const ctx = makeCtx(PERSONA + BOILERPLATE, "openai")
    const out = runTransformHook([stripHermesBoilerplateTransform], "onRequest", ctx, "openai")
    expect(out.systemContext).toBe(PERSONA.trimEnd())
  })
})

describe("openai transform registry wiring", () => {
  it("registers the stripper for the openai adapter", () => {
    const names = getAdapterTransforms("openai").map(t => t.name)
    expect(names).toContain("openai-strip-hermes-boilerplate")
  })

  it("does not add the stripper to the opencode adapter", () => {
    const names = getAdapterTransforms("opencode").map(t => t.name)
    expect(names).not.toContain("openai-strip-hermes-boilerplate")
  })

  it("openAiTransforms includes the stripper last", () => {
    expect(openAiTransforms[openAiTransforms.length - 1]).toBe(stripHermesBoilerplateTransform)
  })
})
