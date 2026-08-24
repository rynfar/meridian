/**
 * Naming the restart command for a restart-scoped setting.
 *
 * Every cgroup string below was copied from a real /proc/self/cgroup on this
 * machine or from a documented systemd layout — the point of the module is to
 * be right about the actual format, so invented input would test nothing.
 */
import { describe, expect, it } from "bun:test"
import { parseSupervision } from "../proxy/supervision"

describe("parseSupervision", () => {
  it("names a user unit and addresses the right systemd manager", () => {
    const s = parseSupervision("0::/user.slice/user-1000.slice/user@1000.service/app.slice/meridian.service\n")

    expect(s.kind).toBe("systemd-user")
    expect(s.unit).toBe("meridian.service")
    // Without --user this restarts nothing, or something else entirely.
    expect(s.restartCommand).toBe("systemctl --user restart meridian.service")
  })

  it("asks for sudo on a system unit and not on a user one", () => {
    const s = parseSupervision("0::/system.slice/meridian.service\n")

    expect(s.kind).toBe("systemd-system")
    expect(s.restartCommand).toBe("sudo systemctl restart meridian.service")
  })

  it("reports no unit for a process started by hand in a terminal", () => {
    // A scope is how systemd accounts for a process it did not launch, so this
    // is what running `meridian` yourself looks like. Printing
    // `systemctl restart …scope` here would be a command that fails.
    const s = parseSupervision(
      "0::/user.slice/user-1000.slice/user@1000.service/tmux-spawn-f5fb9ecd-b4a8-4886-a76d-a2a86df15cde.scope\n",
    )

    expect(s.kind).toBe("unknown")
    expect(s.unit).toBeNull()
    expect(s.restartCommand).toBeNull()
  })

  it("reads the legacy multi-line cgroup v1 layout too", () => {
    const s = parseSupervision([
      "12:pids:/system.slice/meridian.service",
      "5:cpu,cpuacct:/system.slice/meridian.service",
      "0::/system.slice/meridian.service",
    ].join("\n"))

    expect(s.unit).toBe("meridian.service")
  })

  it("never mistakes the user manager itself for the unit", () => {
    // Every user service nests under user@<uid>.service, so a naive "last
    // .service component" would answer this for all of them.
    const s = parseSupervision("0::/user.slice/user-1000.slice/user@1000.service/meridian-dev.service")

    expect(s.unit).toBe("meridian-dev.service")
  })

  it("says unknown rather than guessing outside systemd", () => {
    for (const cgroup of ["", "0::/", "0::/docker/3f2a9c1b", "garbage"]) {
      const s = parseSupervision(cgroup)
      expect(s.kind).toBe("unknown")
      expect(s.restartCommand).toBeNull()
    }
  })
})
