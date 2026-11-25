import type { Options } from "@anthropic-ai/claude-agent-sdk"

export function sanitizeClaudeEgressEnv(env: Options["env"]): Options["env"] {
  const effectiveEnv = env ?? process.env
  const headerEnvKeys = process.platform === "win32"
    ? Object.keys(effectiveEnv).filter(key => key.toUpperCase() === "ANTHROPIC_CUSTOM_HEADERS")
    : ["ANTHROPIC_CUSTOM_HEADERS"]
  let filteredEnv: Options["env"]
  for (const key of headerEnvKeys) {
    const configured = effectiveEnv[key]
    if (!configured) continue
    const lines = configured.split(/\r?\n/)
    const retained = lines.filter(line => !/^\s*x-meridian-[^:]*:/i.test(line))
    if (retained.length === lines.length) continue
    filteredEnv ??= { ...effectiveEnv }
    filteredEnv[key] = retained.join("\n")
  }
  return filteredEnv ?? env
}
