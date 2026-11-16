import { expect, it } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

const roots = new Set([
  "storeSession", "evictCachedSession", "claimPriorityAttempt", "releasePriorityAttempt", "blockPriorityAttempt",
  "rollbackPrioritySessionPublication", "finalizePrioritySessionPublication", "attachSharedTranscriptLocator",
  "storeSharedSession", "storeSharedSessionAndPriorityAssignment", "finalizeSharedSessionAndPriorityAssignment",
  "rollbackSharedSessionAndPriorityAssignment", "evictSharedSession", "clearSharedSessions", "clearSessionCache",
])
function source(path: string) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
}
function calls(file: ts.SourceFile): ts.CallExpression[] {
  const result: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && roots.has(node.expression.text)) result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}
function admitted(call: ts.CallExpression): boolean {
  for (let node: ts.Node = call.parent; node; node = node.parent) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ["admitSessionStoreWrite", "publishPinnedTranscript", "attachPinnedTranscript"].includes(node.expression.text)) {
      return true
    }
  }
  return false
}

it("every imported server mutation enters async admission or the joint publication callback", () => {
  const file = source("src/proxy/server.ts")
  const mutations = calls(file)
  expect(mutations.length).toBeGreaterThanOrEqual(12)
  for (const mutation of mutations) expect(admitted(mutation), mutation.getText(file)).toBe(true)
  expect(file.text).not.toContain("readSessionStoreSnapshot")
})

const durabilityFlags = new Set(["mappingExpectedGeneration", "managedForkPublished", "recoveryForkPublished", "recoveryPublishedTarget"])

function requiresJson(condition: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(condition)) return requiresJson(condition.expression)
  if (ts.isPrefixUnaryExpression(condition)) return condition.operator === ts.SyntaxKind.ExclamationToken
    && ts.isIdentifier(condition.operand) && condition.operand.text === "bookkeepingHandle"
  return ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    && (requiresJson(condition.left) || requiresJson(condition.right))
}

function nativePublicationAssignments(callback: ts.Node): string[] {
  const assignments: string[] = []
  const check = (child: ts.Node) => {
    if (ts.isIfStatement(child) && requiresJson(child.expression)) {
      // The condition still runs in SQL, including any assignment it contains.
      check(child.expression)
      if (child.elseStatement) check(child.elseStatement)
      return
    }
    if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(child.left) && durabilityFlags.has(child.left.text)) assignments.push(child.left.text)
    ts.forEachChild(child, check)
  }
  check(callback)
  return assignments
}

it("SQL publication callbacks do not assign server durability flags before their outer COMMIT", () => {
  const file = source("src/proxy/server.ts")
  let publications = 0
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "publishPinnedTranscript") {
      publications++
      const callback = node.arguments[1]
      if (!callback) throw new Error("publication callback missing")
      expect(nativePublicationAssignments(callback)).toEqual([])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(publications).toBe(4)
})

it.each([
  ["mappingExpectedGeneration = value", ["mappingExpectedGeneration"]],
  ["if (value && !bookkeepingHandle) { managedForkPublished = true }", []],
  ["if (value && bookkeepingHandle) { managedForkPublished = true }", ["managedForkPublished"]],
  ["if (value || !bookkeepingHandle) { managedForkPublished = true }", ["managedForkPublished"]],
  ["if (!bookkeepingHandle) { managedForkPublished = true } else { recoveryForkPublished = true }", ["recoveryForkPublished"]],
  ["if ((mappingExpectedGeneration = value) && !bookkeepingHandle) { managedForkPublished = true }", ["mappingExpectedGeneration"]],
] as const)("keeps native assignment checks for %s", (body, expected) => {
  const file = ts.createSourceFile("publication-control.ts", `() => { ${body} }`, ts.ScriptTarget.Latest, true)
  expect(nativePublicationAssignments(file)).toEqual([...expected])
})

it("the production mutation-root inventory extends beyond server.ts", () => {
  const paths: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && path !== "src/proxy/session/bookkeeping") walk(path)
      } else if (entry.name.endsWith(".ts")) paths.push(path)
    }
  }
  walk("src")
  walk("bin")
  const allowed = new Set(["src/proxy/server.ts", "src/proxy/session/cache.ts", "src/proxy/sessionStore.ts"])
  for (const path of paths) {
    if (!allowed.has(path)) expect(calls(source(path)), `new standalone mutation root: ${path}`).toHaveLength(0)
  }
})
