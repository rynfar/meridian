import { expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

it("isolates feature reads, writes and cached values from the operator's settings", () => {
  const root = mkdtempSync(join(tmpdir(), "meridian-feature-isolation-"))
  const fakeHome = join(root, "operator")
  const operatorDir = join(fakeHome, ".config", "meridian")
  const first = join(root, "first")
  const second = join(root, "second")
  for (const dir of [operatorDir, first, second]) mkdirSync(dir, { recursive: true })
  const operatorFile = join(operatorDir, "sdk-features.json")
  const operatorConfig = JSON.stringify({ opencode: { codeSystemPrompt: false, thinking: "disabled" } })
  writeFileSync(operatorFile, operatorConfig)
  writeFileSync(join(first, "sdk-features.json"), JSON.stringify({ opencode: { codeSystemPrompt: true } }))
  writeFileSync(join(second, "sdk-features.json"), JSON.stringify({ opencode: { codeSystemPrompt: false } }))
  const moduleUrl = new URL("../proxy/sdkFeatures.ts", import.meta.url).href
  const script = `
    import { mock } from "bun:test";
    const os = await import("node:os");
    mock.module("node:os", () => ({ ...os, homedir: () => ${JSON.stringify(fakeHome)} }));
    const features = await import(${JSON.stringify(moduleUrl)});
    const first = features.getFeaturesForAdapter("opencode").codeSystemPrompt;
    process.env.MERIDIAN_CONFIG_DIR = ${JSON.stringify(second)};
    const second = features.getFeaturesForAdapter("opencode").codeSystemPrompt;
    features.updateAdapterFeatures("opencode", { thinking: "adaptive" });
    console.log(JSON.stringify({ first, second }));
  `
  try {
    const child = Bun.spawnSync({ cmd: [process.execPath, "-e", script], env: { ...process.env, MERIDIAN_CONFIG_DIR: first }, stdout: "pipe", stderr: "pipe" })
    expect(child.exitCode).toBe(0)
    expect(readFileSync(operatorFile, "utf8")).toBe(operatorConfig)
    expect(JSON.parse(child.stdout.toString())).toEqual({ first: true, second: false })
    expect(JSON.parse(readFileSync(join(second, "sdk-features.json"), "utf8")).opencode.thinking).toBe("adaptive")
    expect(JSON.parse(readFileSync(join(first, "sdk-features.json"), "utf8")).opencode.thinking).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
