import { expect, it } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

const forbidden = new Set(["unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync"])
function deletionReferences(source: string): string[] {
  const file = ts.createSourceFile("input.ts", source, ts.ScriptTarget.Latest, true)
  const findings: string[] = []
  const fsNames = new Set(["fs"])
  const brands = new Set(["PrivatePath"])
  const fsModule = (text: string) => ["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(text)
  const privateModule = (text: string) => /(?:^|\/)privateNames(?:\.d)?(?:\.[cm]?[jt]s)?$/.test(text)
  const walk = (node: ts.Node, action: (child: ts.Node) => void): void => {
    action(node)
    ts.forEachChild(node, (child) => walk(child, action))
  }
  const protectedType = (node: ts.Node): boolean => {
    let protectedReference = node.getText(file).includes("PrivatePath")
    walk(node, (child) => {
      if (ts.isIdentifier(child) && brands.has(child.text)) protectedReference = true
      if (ts.isImportTypeNode(child) && ts.isLiteralTypeNode(child.argument)
        && ts.isStringLiteral(child.argument.literal) && privateModule(child.argument.literal.text)) {
        protectedReference = true
      }
    })
    return protectedReference
  }
  const fsExpression = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return fsNames.has(node.text)
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node)) return fsExpression(node.expression)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return fsExpression(node.expression)
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require"
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!) && fsModule(node.arguments[0]!.text)
  }
  // Local syntax guard, not a cross-module type/taint proof: aliases hidden behind another module/path,
  // runtime eval, computed dynamic-import specifiers, later assignments and type laundering through
  // unknown elsewhere remain outside this check. Imports and
  // privateNames consumers still require review; these restrictions cover accidental in-directory bypasses.
  let size = -1
  while (size !== fsNames.size + brands.size) {
    size = fsNames.size + brands.size
    walk(file, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause
        const bindings = clause?.namedBindings
        if (fsModule(node.moduleSpecifier.text)) {
          if (clause?.name) fsNames.add(clause.name.text)
          if (bindings && ts.isNamespaceImport(bindings)) fsNames.add(bindings.name.text)
          if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
            if (["promises", "default"].includes((item.propertyName ?? item.name).text)) fsNames.add(item.name.text)
          }
        }
        if (privateModule(node.moduleSpecifier.text) && bindings && ts.isNamedImports(bindings)) {
          for (const item of bindings.elements) if ((item.propertyName ?? item.name).text === "PrivatePath") {
            brands.add(item.name.text)
          }
        }
      }
      if (ts.isTypeAliasDeclaration(node) && protectedType(node.type)) brands.add(node.name.text)
      if (ts.isInterfaceDeclaration(node) && protectedType(node)) brands.add(node.name.text)
      if (ts.isVariableDeclaration(node) && node.initializer && fsExpression(node.initializer)) {
        if (ts.isIdentifier(node.name)) fsNames.add(node.name.text)
        if (ts.isObjectBindingPattern(node.name)) for (const item of node.name.elements) {
          if (ts.isIdentifier(item.name) && (item.propertyName?.getText(file) ?? item.name.text) === "promises") {
            fsNames.add(item.name.text)
          }
        }
      }
    })
  }
  const record = (node: ts.Node, name: string) => {
    if (forbidden.has(name)) findings.push(`${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${name}`)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) record(node, (node.propertyName ?? node.name).text)
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName)) {
      record(node, node.propertyName.text)
    }
    if (ts.isPropertyAccessExpression(node)) record(node, node.name.text)
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      record(node, node.argumentExpression.text)
    }
    if (ts.isElementAccessExpression(node) && fsExpression(node.expression)) findings.push("computed fs access")
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) record(node, node.expression.text)
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && protectedType(node.type)) {
      findings.push("PrivatePath cast outside its generator")
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node))
      && node.type && protectedType(node.type) && node.initializer) {
      walk(node.initializer, (child) => {
        if (ts.isAsExpression(child) || ts.isTypeAssertionExpression(child)) {
          findings.push("PrivatePath annotated initializer contains a cast")
        }
      })
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
      && fsModule(node.arguments[0].text)) findings.push("dynamic filesystem import")
    if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && protectedType(node)) {
      findings.push("PrivatePath type alias/interface outside its generator")
    }
    if (ts.isExportSpecifier(node) && brands.has((node.propertyName ?? node.name).text)
      && node.name.text !== "PrivatePath") findings.push("renamed PrivatePath re-export")
    ts.forEachChild(node, visit)
  }
  visit(file)
  return findings
}

it("only privateNames.ts can name destructive filesystem operations or manufacture the brand", () => {
  const directory = join(process.cwd(), "src/proxy/session/bookkeeping")
  const failures = readdirSync(directory).filter((name) => name.endsWith(".ts") && name !== "privateNames.ts")
    .flatMap((name) => deletionReferences(readFileSync(join(directory, name), "utf8"))
      .map((finding) => `${name}:${finding}`))
  expect(failures).toEqual([])
})

for (const snippet of [
  'import { unlinkSync as erase } from "node:fs"; erase(path)',
  'import * as fs from "node:fs"; fs.unlinkSync(path)',
  'const { rmdirSync: erase } = require("node:fs"); erase(path)',
  'fs["rmSync"](path)', 'unlink(path)', 'const p = path as PrivatePath',
  'const p = path as import("./privateNames").PrivatePath',
  'const p = path as import("./privateNames").SomeAlias',
  'const p = path as typeof import("./privateNames")',
  'type P = PrivatePath; const p = path as P',
  'type Q = P; type P = PrivatePath; const p = path as Q',
  'const p = <PrivatePath>path',
  'interface P { value: PrivatePath }',
  'interface P extends PrivatePath {}',
  'export { PrivatePath as P } from "./privateNames"',
  'export type { PrivatePath as P } from "./privateNames"',
  'import type { PrivatePath as P } from "./privateNames"; const p = path as P',
  'fs[name](path)', 'fs.promises[name](path)',
  'import * as disk from "node:fs"; disk[name](path)',
  'import disk from "node:fs/promises"; disk[name](path)',
  'import { promises as io } from "node:fs"; io[name](path)',
  'const io = fs.promises; io[name](path)',
  'const disk = require("node:fs"); disk[name](path)',
  'const { promises: io } = require("node:fs"); io[name](path)',
  'import { default as io } from "node:fs"; io[name](path)',
  'const io = (fs as unknown); io[name](path)',
  'import type { PrivatePath as P } from "./privateNames"; export { P as Leaked }',
  'import type { PrivatePath as P } from "./privateNames.js"; const p = path as P',
  'const p = path as import("./privateNames.js").SomeAlias',
  'const p: PrivatePath = path as any',
  'const p: PrivatePath = path as unknown as any',
  'const p: PrivatePath = <any>path',
  'function f(p: PrivatePath = path as any) {}',
  'function f(p: PrivatePath = path as unknown as any) {}',
  'class C { p: PrivatePath = path as any }',
  'class C { p: PrivatePath = path as unknown as any }',
  'import type { PrivatePath as P } from "./privateNames"; const p: P = path as any',
  'const io = await import("node:fs"); io[name](path)',
  'const io = await import("node:fs/promises"); io[name](path)',
  'const io = await import(`node:fs/promises`)',
]) it(`invariant rejects ${snippet}`, () => { expect(deletionReferences(snippet).length).toBeGreaterThan(0) })

it("private wrappers, comments and strings are not direct deletion calls", () => {
  expect(deletionReferences('unlinkPrivate(path); // unlinkSync(path)\nconst note = "rmSync(path)"')).toEqual([])
  expect(deletionReferences('const p: PrivatePath = generatePrivatePath(); unlinkPrivate(p)')).toEqual([])
})
