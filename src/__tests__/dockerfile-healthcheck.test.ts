import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("Docker HEALTHCHECK", () => {
  it("probes liveness, so a logged-out account does not restart the container", () => {
    const dockerfile = readFileSync(join(import.meta.dir, "../../Dockerfile"), "utf8")
    const healthcheck = dockerfile.slice(dockerfile.indexOf("HEALTHCHECK "), dockerfile.indexOf("ENV CLAUDE_PROXY_PASSTHROUGH"))
    expect(healthcheck).toContain("http://127.0.0.1:3456/livez")
    expect(healthcheck).not.toContain("/health")
  })
})
