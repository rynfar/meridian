// Versioned E72 proof helpers. They consume public wire/tool data in memory;
// none opens a task output file or exports a path, handle or model response.
export function backgroundLaunchOutput(text) {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) return
  const ids = [...text.matchAll(/^agentId:[ \t]*([A-Za-z0-9_-]{1,128})(?:[ \t].*)?$/gm)]
  const paths = [...text.matchAll(/^output_file:[ \t]+([^\s]+)(?:[ \t]+\([^\n]*\))?$/gm)]
  if (ids.length !== 1 || paths.length !== 1) return
  const path = paths[0][1]
  if (!path.startsWith('/') || path.length > 4096 || /[\x00-\x1f]/.test(path)) return
  return { id: ids[0][1], path }
}

function numberedFile(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), content = []
  let index = 0
  for (; index < lines.length; index++) {
    const match = /^[ \t]*(\d+)[\t:]([^\r]*)$/.exec(lines[index])
    if (!match) break
    if (Number(match[1]) !== content.length + 1) return
    content.push(match[2])
  }
  if (!content.length) return
  const tail = lines.slice(index).join('\n').trim()
  // This is the CLI Read tool's fixed warning trailer, not arbitrary file text.
  if (tail && !/^<system-reminder>\nWhenever you read a file,[\s\S]*\n<\/system-reminder>$/.test(tail)) return
  return content.join('\n')
}

function finalText(value) {
  if (value?.type !== 'assistant' || value.message?.role !== 'assistant' || !Array.isArray(value.message.content)) return
  if (!value.message.content.length || value.message.content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return
  return value.message.content.map(block => block.text).join('')
}

export function backgroundReadReport(text, expected, executionIds = []) {
  const result = { matched: false, format: 'unknown' }
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024 || typeof expected !== 'string' || !expected.length) return result
  const file = numberedFile(text)
  if (file === undefined) return result
  // A completed native output may be the final report itself. Accept the
  // complete owned HTTP end-turn text, never a substring containing its labels.
  if (file === expected || file === `${expected}\n`) return { matched: true, format: 'numbered-final-text' }
  let rows
  try { rows = file.split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch { return result }
  if (!rows.length || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return result
  result.format = 'numbered-records'
  const substantive = rows.filter(row => ['assistant', 'user'].includes(row.type))
  const matches = substantive.filter(row => finalText(row) === expected)
  if (matches.length !== 1 || substantive.at(-1) !== matches[0]) return result
  const preceding = substantive.slice(0, -1).flatMap(row => row.type === 'user' && row.message?.role === 'user' && Array.isArray(row.message.content) ? row.message.content : []).filter(block => block?.type === 'tool_result' && block.is_error !== true)
  if (executionIds.length !== 2 || new Set(executionIds).size !== 2 || !executionIds.every(id => preceding.filter(block => block.tool_use_id === id).length === 1)) return result
  return { matched: true, format: result.format }
}

export function backgroundReadCompletion({ receipt, launch, childRequests, finalReport, executionIds }) {
  const result = { ownedPath: false, afterLaunch: false, childCompleteBeforeRead: false, matchedReport: false, format: 'unknown', accepted: false }
  if (!receipt || !launch || !Array.isArray(childRequests) || !childRequests.length) return result
  result.ownedPath = receipt.actor === 0 && receipt.paired === true && receipt.resultMatched === true && receipt.tool?.name === 'Read' && receipt.tool.privateInput?.file_path === launch.path
  result.afterLaunch = Number.isInteger(receipt.tool?.request) && Number.isInteger(launch.launch?.result?.request) && receipt.tool.request >= launch.launch.result.request
  result.childCompleteBeforeRead = Number.isInteger(receipt.startEvent) && childRequests.every(row => Number.isInteger(row.terminalEvent) && row.terminalEvent < receipt.startEvent)
  const report = backgroundReadReport(receipt.result?.text, finalReport, executionIds)
  result.matchedReport = report.matched; result.format = report.format
  result.accepted = result.ownedPath && result.afterLaunch && result.childCompleteBeforeRead && result.matchedReport
  return result
}

export function backgroundReadNativeResult(row, { sdkVersion, nativeVersion }) {
  const qualified = sdkVersion === '0.2.141' && ['2.1.284', '2.1.295'].includes(nativeVersion)
  const g = row.generations
  const complete = g?.completeGenerationIds === true && !g.overflow && g.missingGenerationIds === 0 && g.missingToolIds === 0 && g.conflictingToolOwners === 0 && g.uncorrelatedHooks === 0
  if (!qualified || !complete || !Number.isInteger(row.maxTurns) || row.maxTurns < 1 || !Number.isInteger(g.distinctGenerations) || g.distinctGenerations < 1 || g.distinctGenerations > row.maxTurns || !row.resultFlagValid || !row.sdkToolHookCustody) return false
  if (row.resultSubtype === 'success' && row.resultIsError === false) return true
  return row.resultSubtype === 'error_max_turns' && row.resultIsError === true && row.maxTurns === 1 && row.nativeTurns === 2 && row.terminalReason === 'max_turns' && g.distinctGenerations === 1 && row.canonicalHttpToolTerminal === true
}
