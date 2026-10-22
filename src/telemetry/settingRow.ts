/**
 * One settings row on /settings, and what it says when an env var outranks it.
 *
 * Every setting renders the same way: the label and its control share the
 * header line, the description runs the full width below it, and status lines
 * ("now: ...", an env override) go under the description. A long description
 * beside a wide dropdown left each a sliver of the row, so neither is allowed
 * to share the other's line.
 *
 * Both functions are serialized with `.toString()` into the settings page's
 * inline script (the buildBadge.ts pattern), so each must stay self-contained:
 * no references to anything outside its own body.
 */

/** What the settings API reports for an env var that decides a setting. */
export interface EnvSourceView {
  /** The variable actually read, e.g. MERIDIAN_TELEMETRY_RETENTION_DAYS. */
  readonly name: string
  /** Its raw value; null when the variable is credential-like and only its presence may be shown. */
  readonly value: string | null
  readonly secret?: boolean
}

/**
 * The override line: the value in use, the variable it comes from, and what
 * happens to the saved setting. `inUse` and `saved` are display strings the
 * caller formats from the API's resolved values; null when there is nothing to
 * say about them. Returns null when no env var decides the setting.
 */
export function envOverrideText(source: unknown, inUse: string | null, saved: string | null): string | null {
  if (typeof source !== "object" || source === null) return null
  const record = source as Record<string, unknown>
  if (typeof record.name !== "string" || !record.name) return null
  const value = typeof record.value === "string" ? record.value : null
  const origin = record.secret === true || value === null
    ? record.name + " (env, set; value hidden)"
    : value === ""
      ? record.name + " (env, set but empty)"
      : record.name + "=" + value + " (env)"
  const head = inUse ? "In use: " + inUse + ", from " + origin : "In use: from " + origin
  const tail = saved ? "; saved setting " + saved + " is ignored" : "; no setting saved here"
  return head + tail
}

export interface SettingRowView {
  readonly label: string
  /** The control's markup: a toggle, checkbox, select or input with its unit. */
  readonly controlHtml: string
  /** Plain text, escaped here. */
  readonly desc?: string | null
  /** Status lines' markup, each already escaped by the caller ("now: ..."). */
  readonly statusHtml?: readonly string[]
  /** Plain-text override line from envOverrideText, escaped here. */
  readonly envText?: string | null
  /** The control's id, so clicking the label focuses it. */
  readonly forId?: string
}

export function settingRowHtml(row: SettingRowView): string {
  function esc(value: unknown): string {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" } as Record<string, string>)[ch] ?? ch
    })
  }
  let html = "<div class=\"setting-row\"><div class=\"setting-head\">"
    + "<label class=\"setting-label\"" + (row.forId ? " for=\"" + esc(row.forId) + "\"" : "") + ">" + esc(row.label) + "</label>"
    + "<div class=\"setting-control\">" + row.controlHtml + "</div></div>"
  if (row.desc) html += "<div class=\"setting-desc\">" + esc(row.desc) + "</div>"
  for (const status of row.statusHtml ?? []) {
    if (status) html += "<div class=\"setting-status\">" + status + "</div>"
  }
  if (row.envText) html += "<div class=\"setting-env\">" + esc(row.envText) + "</div>"
  return html + "</div>"
}
