/**
 * The settings row and its env-override line (telemetry/settingRow.ts), plus
 * envSource (env.ts) which feeds it.
 *
 * The page ships the views via `.toString()`, so these tests evaluate that
 * serialized text rather than the TS import - what is asserted here is what
 * the page actually runs.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { envInt, envIntValue, envSource, envVarSource } from "../env"
import { envOverrideText, settingRowHtml, type SettingRowView } from "../telemetry/settingRow"
import { settingsPageHtml } from "../telemetry/settingsPage"

const overrideText = new Function(`return (${envOverrideText.toString()})`)() as typeof envOverrideText
const rowHtml = new Function(`return (${settingRowHtml.toString()})`)() as (row: SettingRowView) => string

describe("envOverrideText", () => {
  test("an overridden setting names the value in use, the variable and the ignored saved value", () => {
    expect(overrideText({ name: "MERIDIAN_TELEMETRY_RETENTION_DAYS", value: "30", secret: false }, "30 days", "14 days"))
      .toBe("In use: 30 days, from MERIDIAN_TELEMETRY_RETENTION_DAYS=30 (env); saved setting 14 days is ignored")
  })

  test("says nothing was saved when only the env var decides", () => {
    expect(overrideText({ name: "MERIDIAN_ROUTING", value: "priority", secret: false }, "priority", null))
      .toBe("In use: priority, from MERIDIAN_ROUTING=priority (env); no setting saved here")
  })

  test("a setting no env var decides has no override line", () => {
    expect(overrideText(null, "7 days", "7 days")).toBeNull()
    expect(overrideText(undefined, "7 days", null)).toBeNull()
    expect(overrideText({ value: "30" }, "30 days", null)).toBeNull()
  })

  test("a credential-like variable shows only that it is set, never its value", () => {
    const text = overrideText({ name: "MERIDIAN_API_KEY", value: null, secret: true }, null, null)
    expect(text).toBe("In use: from MERIDIAN_API_KEY (env, set; value hidden); no setting saved here")
    // Even a caller that hands over a value with the secret flag set does not leak it.
    expect(overrideText({ name: "MERIDIAN_HOOK_TOKEN", value: "s3cr3t-value", secret: true }, null, null))
      .not.toContain("s3cr3t-value")
  })

  test("an empty variable the resolver still uses is reported as empty rather than as a bare '='", () => {
    // Persist reads any set value, "" included (as off), so the saved value really is ignored.
    expect(overrideText({ name: "MERIDIAN_TELEMETRY_PERSIST", value: "", secret: false, use: "value" }, "memory", "SQLite"))
      .toBe("In use: memory, from MERIDIAN_TELEMETRY_PERSIST (env, set but empty); saved setting SQLite is ignored")
  })

  test("a variable the resolver passed over does not claim the saved setting is ignored", () => {
    expect(overrideText({ name: "MERIDIAN_TELEMETRY_RETENTION_DAYS", value: "abc", secret: false, use: "ignored" }, "14 days", "14 days"))
      .toBe("MERIDIAN_TELEMETRY_RETENTION_DAYS is set but not a valid number (abc); saved setting 14 days used")
    expect(overrideText({ name: "MERIDIAN_TELEMETRY_SIZE", value: "", secret: false, use: "ignored" }, "3,000 rows", "3,000 rows"))
      .toBe("MERIDIAN_TELEMETRY_SIZE is set but empty; saved setting 3,000 rows used")
    expect(overrideText({ name: "MERIDIAN_TELEMETRY_RETENTION_DAYS", value: "", secret: false, use: "ignored" }, "7 days", null))
      .toBe("MERIDIAN_TELEMETRY_RETENTION_DAYS is set but empty; default 7 days used")
  })

  test("an unusable variable that still outranks the saved setting says the default is in use", () => {
    expect(overrideText({ name: "MERIDIAN_TELEMETRY_SIZE", value: "lots", secret: false, use: "default" }, "1,000 rows", "3,000 rows"))
      .toBe("In use: 1,000 rows (default), from MERIDIAN_TELEMETRY_SIZE=lots (env, not a positive number); saved setting 3,000 rows is ignored")
    expect(overrideText({ name: "MERIDIAN_DIAGNOSTIC_LOG_SIZE", value: "", secret: false, use: "default" }, "500 entries", null))
      .toBe("In use: 500 entries (default), from MERIDIAN_DIAGNOSTIC_LOG_SIZE (env, set but empty); no setting saved here")
  })

  test("a variable whose value the page does not know is named without one", () => {
    expect(overrideText({ name: "MERIDIAN_CLAUDE_PATH", value: null }, "/opt/claude 9.9.3", "system"))
      .toBe("In use: /opt/claude 9.9.3, from MERIDIAN_CLAUDE_PATH (env); saved setting system is ignored")
  })
})

describe("settingRowHtml", () => {
  test("the control shares the header line with the label; the description and status lines sit below it", () => {
    const html = rowHtml({
      label: "Retention",
      forId: "tel-retention",
      controlHtml: '<input id="tel-retention">',
      desc: "How long rows are kept",
      statusHtml: ["now: 30d"],
      envText: "In use: 30 days, from X=30 (env); saved setting 14 days is ignored",
    })
    const head = html.slice(html.indexOf('<div class="setting-head">'), html.indexOf('<div class="setting-desc">'))
    expect(head).toContain('<label class="setting-label" for="tel-retention">Retention</label>')
    expect(head).toContain('<div class="setting-control"><input id="tel-retention"></div>')
    expect(html.indexOf("setting-desc")).toBeLessThan(html.indexOf("setting-status"))
    expect(html.indexOf("setting-status")).toBeLessThan(html.indexOf("setting-env"))
  })

  test("escapes the label, description and override text, and omits empty parts", () => {
    const html = rowHtml({ label: "<b>x</b>", controlHtml: "", desc: "a & b", envText: '"quoted" <tag>' })
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;")
    expect(html).toContain("a &amp; b")
    expect(html).toContain("&quot;quoted&quot; &lt;tag&gt;")
    expect(rowHtml({ label: "L", controlHtml: "" })).not.toMatch(/setting-(desc|status|env)/)
  })

  test("the settings page ships both views and no longer the old side-by-side rows", () => {
    expect(settingsPageHtml).toContain("var envOverrideText = ")
    expect(settingsPageHtml).toContain("var settingRowHtml = ")
    expect(settingsPageHtml).not.toContain("env override active")
    expect(settingsPageHtml).not.toContain("feature-info")
  })

  test("the page names the update and executable variables itself, not from a response field", () => {
    expect(settingsPageHtml).not.toMatch(/cfg\.envSource\b/)
    expect(settingsPageHtml).toContain("name: 'MERIDIAN_NO_UPDATE_CHECK'")
    expect(settingsPageHtml).toContain("name: 'MERIDIAN_CLAUDE_PATH'")
  })
})

describe("envSource", () => {
  const touched = ["MERIDIAN_TEST_SETTING", "CLAUDE_PROXY_TEST_SETTING", "MERIDIAN_TEST_TOKEN", "MERIDIAN_TEST_INT"]
  const saved = Object.fromEntries(touched.map(name => [name, process.env[name]]))
  afterEach(() => {
    for (const name of touched) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  test("reports the variable env() reads, MERIDIAN_ before CLAUDE_PROXY_", () => {
    delete process.env.MERIDIAN_TEST_SETTING
    delete process.env.CLAUDE_PROXY_TEST_SETTING
    expect(envSource("TEST_SETTING")).toBeNull()
    process.env.CLAUDE_PROXY_TEST_SETTING = "legacy"
    expect(envSource("TEST_SETTING")).toEqual({ name: "CLAUDE_PROXY_TEST_SETTING", value: "legacy", secret: false })
    process.env.MERIDIAN_TEST_SETTING = "new"
    expect(envSource("TEST_SETTING")).toEqual({ name: "MERIDIAN_TEST_SETTING", value: "new", secret: false })
  })

  test("envIntValue is the parse envInt applies: undefined exactly where envInt falls back", () => {
    for (const [raw, parsed] of [[undefined, undefined], ["", undefined], ["abc", undefined], ["30", 30], ["-5", -5], ["12days", 12]] as const) {
      if (raw === undefined) delete process.env.MERIDIAN_TEST_INT
      else process.env.MERIDIAN_TEST_INT = raw
      expect(envIntValue("TEST_INT")).toBe(parsed)
      expect(envInt("TEST_INT", 99)).toBe(parsed ?? 99)
    }
  })

  test("a credential-like name reports presence only", () => {
    process.env.MERIDIAN_TEST_TOKEN = "do-not-print"
    expect(envVarSource("MERIDIAN_TEST_TOKEN")).toEqual({ name: "MERIDIAN_TEST_TOKEN", value: null, secret: true })
  })
})
