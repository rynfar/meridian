import { describe, expect, it } from "bun:test"
import { isModelRequestPath, parseIdleExitSeconds, SD_LISTEN_FDS_START, socketActivationFd } from "../proxy/socketActivation"

describe("socketActivationFd", () => {
	it("returns SD_LISTEN_FDS_START (3) when LISTEN_PID matches and LISTEN_FDS >= 1", () => {
		expect(socketActivationFd({ LISTEN_PID: "1234", LISTEN_FDS: "1" }, 1234)).toBe(SD_LISTEN_FDS_START)
		expect(socketActivationFd({ LISTEN_PID: "1234", LISTEN_FDS: "3" }, 1234)).toBe(SD_LISTEN_FDS_START)
	})

	it("returns undefined when LISTEN_PID does not match the supplied pid", () => {
		expect(socketActivationFd({ LISTEN_PID: "9999", LISTEN_FDS: "1" }, 1234)).toBeUndefined()
	})

	it("returns undefined when LISTEN_PID is missing", () => {
		expect(socketActivationFd({ LISTEN_FDS: "1" }, 1234)).toBeUndefined()
	})

	it("returns undefined when LISTEN_FDS is missing", () => {
		expect(socketActivationFd({ LISTEN_PID: "1234" }, 1234)).toBeUndefined()
	})

	it("returns undefined when LISTEN_FDS is zero or non-positive", () => {
		expect(socketActivationFd({ LISTEN_PID: "1234", LISTEN_FDS: "0" }, 1234)).toBeUndefined()
		expect(socketActivationFd({ LISTEN_PID: "1234", LISTEN_FDS: "-2" }, 1234)).toBeUndefined()
	})

	it("returns undefined when the values are malformed", () => {
		expect(socketActivationFd({ LISTEN_PID: "not-a-number", LISTEN_FDS: "1" }, 1234)).toBeUndefined()
		expect(socketActivationFd({ LISTEN_PID: "1234", LISTEN_FDS: "abc" }, 1234)).toBeUndefined()
		expect(socketActivationFd({ LISTEN_PID: "1234junk", LISTEN_FDS: "1" }, 1234)).toBeUndefined()
		expect(socketActivationFd({ LISTEN_PID: "1234", LISTEN_FDS: "1junk" }, 1234)).toBeUndefined()
	})

	it("returns undefined when nothing is set", () => {
		expect(socketActivationFd({}, 1234)).toBeUndefined()
	})
})

describe("parseIdleExitSeconds", () => {
	it("parses a positive integer under MERIDIAN_IDLE_EXIT_SECONDS", () => {
		expect(parseIdleExitSeconds({ MERIDIAN_IDLE_EXIT_SECONDS: "300" })).toBe(300)
	})

	it("accepts the legacy CLAUDE_PROXY_ alias", () => {
		expect(parseIdleExitSeconds({ CLAUDE_PROXY_IDLE_EXIT_SECONDS: "120" })).toBe(120)
	})

	it("prefers MERIDIAN_ over CLAUDE_PROXY_ when both are set", () => {
		expect(
			parseIdleExitSeconds({ MERIDIAN_IDLE_EXIT_SECONDS: "600", CLAUDE_PROXY_IDLE_EXIT_SECONDS: "60" }),
		).toBe(600)
	})

	it("returns undefined when neither is set", () => {
		expect(parseIdleExitSeconds({})).toBeUndefined()
		expect(parseIdleExitSeconds({ MERIDIAN_IDLE_EXIT_SECONDS: "" })).toBeUndefined()
	})

	it("rejects non-positive and non-numeric values", () => {
		expect(parseIdleExitSeconds({ MERIDIAN_IDLE_EXIT_SECONDS: "0" })).toBeUndefined()
		expect(parseIdleExitSeconds({ MERIDIAN_IDLE_EXIT_SECONDS: "-5" })).toBeUndefined()
		expect(parseIdleExitSeconds({ MERIDIAN_IDLE_EXIT_SECONDS: "abc" })).toBeUndefined()
		expect(parseIdleExitSeconds({ MERIDIAN_IDLE_EXIT_SECONDS: "1junk" })).toBeUndefined()
		expect(parseIdleExitSeconds({ MERIDIAN_IDLE_EXIT_SECONDS: "1.5" })).toBeUndefined()
		expect(parseIdleExitSeconds({ MERIDIAN_IDLE_EXIT_SECONDS: "999999999999999999999" })).toBeUndefined()
	})
})

describe("isModelRequestPath", () => {
	it("tracks model endpoints including query strings, but not health polling", () => {
		for (const path of ["/v1/messages", "/v1/messages?foo=bar", "/v1/chat/completions", "/v1/responses"]) {
			expect(isModelRequestPath(path)).toBe(true)
		}
		for (const path of ["/health", "/v1/models", "/v1/messages-extra", "/telemetry"]) {
			expect(isModelRequestPath(path)).toBe(false)
		}
	})
})
