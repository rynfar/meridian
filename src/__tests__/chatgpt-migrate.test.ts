/**
 * `meridian chatgpt-migrate` against synthetic HOMEs, a synthetic /proc and an
 * in-memory keychain. Nothing here reads the real home, the real /proc or the
 * OS keychain.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { KeychainBackend } from "../proxy/chatgpt/migrate/keychain"
import { ACCOUNTS_FILE_NAME, FLAGGED_ACCOUNTS_FILE_NAME, type MigrationEnvironment } from "../proxy/chatgpt/migrate/layout"
import { parseMigrateArgs, MigrateUsageError } from "../proxy/chatgpt/migrate/cli"
import { acquirePluginLock, PluginLockHeldError } from "../proxy/chatgpt/migrate/files"
import { printableUrl, runMigration, type ChatGptStoreAdapter, type ImportAccount, type MigrationOptions } from "../proxy/chatgpt/migrate/migrate"
import {
  contextFor,
  matchPluginSpec,
  packageNameOf,
  pointProviderAtMeridian,
  removePluginEntries,
  resolvePlugins,
} from "../proxy/chatgpt/migrate/opencodeConfig"
import { isOpencodeCommand, roleOf, scanOpencodeProcesses, unitFromCgroup } from "../proxy/chatgpt/migrate/processes"
import { discoverCredentials, planAccounts } from "../proxy/chatgpt/migrate/sources"
import { createOwnedStoreAdapter, MeridianOwnsStoreError } from "../proxy/chatgpt/migrate/ownedStore"
import { createChatGptCredentialStore } from "../proxy/chatgpt/credentials"
import { acquireWriterLease } from "../proxy/chatgpt/lease"
import { chatGptLockPath } from "../proxy/chatgpt/paths"
import {
  CHANGED_SINCE_DISCOVERY,
  executeStrip,
  ownershipBlockers,
  planStrip,
  SEAT_NOT_IMPORTED,
  SEAT_REFRESHED_SINCE,
  stripAccountsText,
  type MeridianHeldAccount,
} from "../proxy/chatgpt/migrate/strip"

let root: string
let home: string
let env: MigrationEnvironment

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`
}

function accessToken(seat: string, workspace: string, iat: number): string {
  return jwt({ iat, "https://api.openai.com/auth": { chatgpt_account_user_id: seat, chatgpt_account_id: workspace } })
}

function account(seat: string, refresh: string, rotatedAt: number, extra: Record<string, unknown> = {}) {
  return {
    accountId: `ws-${seat}-000abc`,
    accountUserId: seat,
    email: `${seat}@example.test`,
    refreshToken: refresh,
    accessToken: accessToken(seat, `ws-${seat}-000abc`, Math.floor(rotatedAt / 1000)),
    expiresAt: rotatedAt + 3_600_000,
    tokenRotatedAt: rotatedAt,
    addedAt: 1,
    lastUsed: 1,
    ...extra,
  }
}

function held(seat: string, refresh: string, rotatedAt: number): MeridianHeldAccount {
  return { accountUserId: seat, refreshToken: refresh, accessToken: null, tokenRotatedAt: rotatedAt, expiresAt: null }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function store(accounts: unknown[]) {
  return { version: 3, activeIndex: 0, accounts }
}

class MemoryKeychain implements KeychainBackend {
  readonly entries = new Map<string, string>()
  async get(service: string, account: string) { return this.entries.get(`${service}/${account}`) ?? null }
  async set(service: string, account: string, secret: string) { this.entries.set(`${service}/${account}`, secret) }
}

class MemoryStore implements ChatGptStoreAdapter {
  readonly storePath: string
  held: MeridianHeldAccount[] = []
  constructor(path: string) { this.storePath = path }
  readHeld() { return this.held }
  async importAccounts(accounts: readonly ImportAccount[]) {
    for (const incoming of accounts) {
      this.held = this.held.filter(existing => existing.accountUserId !== incoming.accountUserId)
      this.held.push({
        accountUserId: incoming.accountUserId,
        refreshToken: incoming.refreshToken,
        accessToken: incoming.accessToken,
        tokenRotatedAt: incoming.tokenRotatedAt,
        expiresAt: incoming.expiresAt,
      })
    }
  }
  async validateSeat(accountUserId: string) { return { ok: true, detail: `seat ${accountUserId} resolves` } }
}

/** Every file under `dir` with its bytes, so a dry run can prove it wrote nothing. */
function snapshotTree(dir: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.set(path, readFileSync(path, "utf8"))
    }
  }
  walk(dir)
  return files
}

beforeEach(() => {
  const base = process.env.TMPDIR || tmpdir()
  mkdirSync(base, { recursive: true })
  root = mkdtempSync(join(base, "chatgpt-migrate-"))
  home = join(root, "home")
  mkdirSync(home, { recursive: true })
  env = { home, managedConfigDir: join(root, "managed") }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("credential discovery", () => {
  it("finds every source and keeps only the freshest token per seat", async () => {
    const pluginDir = join(home, ".opencode")
    writeJson(join(pluginDir, ACCOUNTS_FILE_NAME), store([account("alice", "rt-SECRET-alice-2", 2_000_000), account("bob", "rt-SECRET-bob-1", 1_000_000)]))
    writeJson(join(pluginDir, "projects", "proj-abc123", ACCOUNTS_FILE_NAME), store([account("alice", "rt-SECRET-alice-3", 3_000_000)]))
    writeJson(join(pluginDir, FLAGGED_ACCOUNTS_FILE_NAME), { version: 1, accounts: [account("carol", "rt-SECRET-carol-1", 1_000_000, { flaggedAt: 5 })] })
    writeJson(join(pluginDir, "backups", "codex-credential-snapshot-1.json"), store([account("alice", "rt-SECRET-alice-1", 1_000_000), account("dave", "rt-SECRET-dave-1", 1_000_000)]))
    writeJson(join(home, ".local", "share", "opencode", "auth.json"), {
      openai: { type: "oauth", refresh: "rt-SECRET-bob-1", access: accessToken("bob", "ws-bob-000abc", 1000), expires: 1_003_600_000 },
    })
    const keychain = new MemoryKeychain()
    await keychain.set("oc-codex-multi-auth", "accounts:global", JSON.stringify(store([account("erin", "rt-SECRET-erin-1", 1_000_000)])))

    const discovery = await discoverCredentials({ env, keychain })
    const plans = planAccounts(discovery.candidates)
    const bySeat = new Map(plans.map(plan => [plan.accountUserId, plan]))

    expect([...bySeat.keys()].sort()).toEqual(["alice", "bob", "carol", "dave", "erin"])
    const alice = bySeat.get("alice")!
    expect(alice.winner.refreshToken).toBe("rt-SECRET-alice-3")
    expect(alice.winner.source.projectKey).toBe("proj-abc123")
    expect(alice.distinctTokens).toBe(3)
    expect(alice.copies.map(copy => copy.relation).sort()).toEqual(["older-token", "older-token"])
    // auth.json carries no seat id; it is read from the access token and matches the pool's copy.
    expect(bySeat.get("bob")!.copies).toEqual([expect.objectContaining({ relation: "same-token" })])
    expect(bySeat.get("carol")!.winner.source.kind).toBe("flagged")
    expect(bySeat.get("dave")!.onlyInBackups).toBe(true)
    expect(bySeat.get("erin")!.winner.source.kind).toBe("keychain")
  })

  it("reports records it cannot place and documents it cannot read", async () => {
    const pluginDir = join(home, ".opencode")
    writeJson(join(pluginDir, ACCOUNTS_FILE_NAME), store([{ refreshToken: "rt-SECRET-anon", email: "anon@example.test", addedAt: 1, lastUsed: 1 }]))
    mkdirSync(join(pluginDir, "backups"), { recursive: true })
    writeFileSync(join(pluginDir, "backups", "broken.json"), "{ rt-SECRET-broken")

    const discovery = await discoverCredentials({ env })
    expect(discovery.candidates).toHaveLength(0)
    expect(discovery.unplaced).toEqual([expect.objectContaining({ email: "anon@example.test" })])
    expect(discovery.problems).toEqual([expect.objectContaining({ kind: "backup", detail: "it is not valid JSON" })])
    expect(JSON.stringify(discovery.problems)).not.toContain("SECRET")
  })

  it("reports stray copies and unlistable directories instead of failing", async () => {
    const pluginDir = join(home, ".opencode")
    writeJson(join(pluginDir, `${ACCOUNTS_FILE_NAME}.copy`), store([account("alice", "rt-SECRET-alice-1", 1)]))
    writeFileSync(join(pluginDir, `${ACCOUNTS_FILE_NAME}.lock`), "{}")
    mkdirSync(join(pluginDir, "projects"), { recursive: true, mode: 0o000 })
    try {
      const discovery = await discoverCredentials({ env })
      expect(discovery.candidates).toHaveLength(0)
      expect(discovery.problems.map(problem => problem.location).sort()).toEqual(
        process.getuid?.() === 0
          ? [join(pluginDir, `${ACCOUNTS_FILE_NAME}.copy`)]
          : [join(pluginDir, `${ACCOUNTS_FILE_NAME}.copy`), join(pluginDir, "projects")],
      )
    } finally {
      chmodSync(join(pluginDir, "projects"), 0o700)
    }
  })
})

describe("opencode config resolution", () => {
  const configDir = () => join(home, ".config", "opencode")

  it("treats a global plugin list replaced by a later file as inert", () => {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(join(configDir(), "opencode.json"), JSON.stringify({ plugin: ["oc-codex-multi-auth@1.0.0"] }))
    writeFileSync(join(configDir(), "opencode.jsonc"), `{\n  // mine\n  "plugin": ["some-other-plugin", "oc-codex-multi-auth"],\n}\n`)
    const resolution = resolvePlugins(env, null)
    const matched = resolution.entries.filter(entry => entry.match)
    expect(matched.map(entry => [entry.layer.path.endsWith("opencode.jsonc"), entry.effective])).toEqual([[false, false], [true, true]])
  })

  it("accumulates project configs and recognises a renamed checkout by its package.json", () => {
    const pluginCheckout = join(root, "forks", "renamed-worktree")
    writeJson(join(pluginCheckout, "package.json"), { name: "oc-codex-multi-auth" })
    mkdirSync(join(pluginCheckout, "dist"), { recursive: true })
    writeFileSync(join(pluginCheckout, "dist", "index.js"), "")
    const project = join(root, "project")
    mkdirSync(join(project, ".git"), { recursive: true })
    mkdirSync(join(project, "sub"), { recursive: true })
    writeFileSync(join(project, "opencode.json"), JSON.stringify({ plugin: [`file://${pluginCheckout}/dist/index.js`] }))
    writeFileSync(join(project, "sub", "opencode.jsonc"), JSON.stringify({ plugin: [[`../../forks/renamed-worktree`, { apiKey: "SECRET-option" }]] }))

    const resolution = resolvePlugins(env, contextFor(join(project, "sub")))
    const matched = resolution.entries.filter(entry => entry.match)
    expect(matched.map(entry => entry.match)).toEqual(["package-json", "package-json"])
    expect(matched.every(entry => entry.effective)).toBe(true)
    expect(JSON.stringify(resolution.entries)).not.toContain("SECRET-option")
  })

  it("flags plugin files opencode loads without a config entry", () => {
    mkdirSync(join(configDir(), "plugin"), { recursive: true })
    writeFileSync(join(configDir(), "plugin", "codex.ts"), `export { default } from "oc-codex-multi-auth"\n`)
    expect(resolvePlugins(env, null).autoloaded).toEqual([{ path: join(configDir(), "plugin", "codex.ts"), reason: "imports-plugin" }])
  })

  it("parses package specifiers", () => {
    expect(packageNameOf("oc-codex-multi-auth@6.1.0")).toBe("oc-codex-multi-auth")
    expect(packageNameOf("npm:oc-codex-multi-auth@latest")).toBe("oc-codex-multi-auth")
    expect(packageNameOf("@scope/pkg@1")).toBe("@scope/pkg")
    expect(matchPluginSpec("oc-codex-multi-auth-fork", null)).toBeNull()
    expect(matchPluginSpec(join(root, "gone", "oc-codex-multi-auth", "dist", "index.js"), null)).toBe("path-name")
  })

  it("matches a vanished plugin checkout by name even inside another package", () => {
    const workspace = join(root, "workspace")
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "enclosing-project" }))
    expect(matchPluginSpec(join(workspace, "gone", "oc-codex-multi-auth", "dist", "index.js"), null)).toBe("path-name")

    const otherCheckout = join(root, "forks", "oc-codex-multi-auth-fork")
    mkdirSync(otherCheckout, { recursive: true })
    writeFileSync(join(otherCheckout, "package.json"), JSON.stringify({ name: "something-else" }))
    expect(matchPluginSpec(join(otherCheckout, "dist", "index.js"), null)).toBeNull()
  })

  it("removes plugin entries and points the provider without disturbing comments", () => {
    const text = `{\n    // keep me\n    "plugin": [\n        "a",\n        "oc-codex-multi-auth@1", // pinned\n        "b",\n    ],\n    "provider": { "openai": { "options": { "apiKey": "{env:X}" } } },\n}\n`
    const removed = removePluginEntries(text, "opencode.jsonc")
    expect(removed.removed).toEqual(["oc-codex-multi-auth@1"])
    expect(removed.text).toContain("// keep me")
    expect(removed.text).not.toContain("oc-codex-multi-auth")

    const pointed = pointProviderAtMeridian(removed.text, "opencode.jsonc", { providerId: "openai", baseURL: "http://127.0.0.1:3459/v1", apiKey: "meridian" })
    expect(pointed.existingApiKeyKept).toBe(true)
    expect(pointed.apiKeyAdded).toBe(false)
    expect(pointed.text).toContain(`"baseURL": "http://127.0.0.1:3459/v1"`)
    expect(pointed.text).toContain("// keep me")
    expect(pointProviderAtMeridian(pointed.text, "opencode.jsonc", { providerId: "openai", baseURL: "http://127.0.0.1:3459/v1", apiKey: "meridian" }).changed).toBe(false)
  })
})

describe("process detection", () => {
  function fakeProcess(procRoot: string, pid: number, fields: { exe: string; argv: string[]; cwd: string; cgroup?: string; environ?: string[] }) {
    const dir = join(procRoot, String(pid))
    mkdirSync(dir, { recursive: true })
    symlinkSync(fields.exe, join(dir, "exe"))
    symlinkSync(fields.cwd, join(dir, "cwd"))
    writeFileSync(join(dir, "cmdline"), `${fields.argv.join("\0")}\0`)
    writeFileSync(join(dir, "cgroup"), fields.cgroup ?? "0::/user.slice/user-1000.slice/session-1.scope\n")
    if (fields.environ) writeFileSync(join(dir, "environ"), `${fields.environ.join("\0")}\0`)
    writeFileSync(join(dir, "stat"), `${pid} (${fields.argv[0]}) S 1 ${Array.from({ length: 17 }, () => "0").join(" ")} 100 0 0\n`)
  }

  it("finds opencode processes, their systemd units and whether they load the plugin", () => {
    const procRoot = join(root, "proc")
    mkdirSync(procRoot, { recursive: true })
    writeFileSync(join(procRoot, "stat"), "cpu 0\nbtime 1700000000\n")
    const withPlugin = join(root, "with-plugin")
    mkdirSync(join(withPlugin, ".git"), { recursive: true })
    writeFileSync(join(withPlugin, "opencode.json"), JSON.stringify({ plugin: ["oc-codex-multi-auth"] }))
    const plain = join(root, "plain")
    mkdirSync(plain, { recursive: true })

    fakeProcess(procRoot, 101, {
      exe: "/usr/bin/opencode", argv: ["opencode", "serve", "--port", "4096"], cwd: withPlugin,
      cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/opencode-serve.service\n",
      environ: [`HOME=${home}`, "OPENAI_API_KEY=SECRET-env"],
    })
    fakeProcess(procRoot, 102, { exe: "/opt/build/opencode.prev-17 (deleted)", argv: ["opencode.prev-17"], cwd: plain })
    fakeProcess(procRoot, 103, { exe: "/usr/bin/bash", argv: ["bash"], cwd: plain })

    const scan = scanOpencodeProcesses({ procRoot, selfPid: 1, fallbackEnvironment: env })
    expect(scan.supported).toBe(true)
    expect(scan.processes.map(candidate => [candidate.pid, candidate.role, candidate.loadsPlugin])).toEqual([[101, "serve", true], [102, "tui", false]])
    expect(scan.processes[0]!.unit).toEqual({ name: "opencode-serve.service", scope: "user" })
    expect(scan.processes[0]!.command).toBe("opencode serve")
    expect(scan.processes[0]!.startedAt).toBe(1_700_000_001_000)
    expect(scan.processes[1]!.exe).toBe("/opt/build/opencode.prev-17")
    expect(JSON.stringify(scan.processes)).not.toContain("SECRET-env")
  })

  it("classifies commands and cgroups", () => {
    expect(isOpencodeCommand("/usr/bin/bun", ["bun", "run", "/src/opencode/packages/opencode/src/index.ts"])).toBe(true)
    expect(isOpencodeCommand("/usr/bin/node", ["node", "/usr/lib/node_modules/opencode-ai/bin/opencode"])).toBe(true)
    expect(isOpencodeCommand("/usr/bin/opencode-stuck-detector", ["opencode-stuck-detector"])).toBe(false)
    expect(roleOf(["opencode", "--print-logs", "run", "hi"])).toBe("run")
    expect(unitFromCgroup("0::/system.slice/opencode.service\n")).toEqual({ name: "opencode.service", scope: "system" })
    expect(unitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1.scope\n")).toBeNull()
  })
})

describe("stripping refresh authority", () => {
  it("keeps the original, strips every refresh token and moves backups aside", async () => {
    const pluginDir = join(home, ".opencode")
    const storePath = join(pluginDir, ACCOUNTS_FILE_NAME)
    writeJson(storePath, store([account("alice", "rt-SECRET-alice-1", 1_000_000)]))
    writeJson(join(pluginDir, "backups", "codex-credential-snapshot-1.json"), store([account("alice", "rt-SECRET-alice-0", 500_000)]))
    const authPath = join(home, ".local", "share", "opencode", "auth.json")
    writeJson(authPath, { openai: { type: "oauth", refresh: "rt-SECRET-alice-1", access: accessToken("alice", "ws", 1000), expires: 1 }, other: { type: "api", key: "k" } })
    const keychain = new MemoryKeychain()
    await keychain.set("oc-codex-multi-auth", "accounts:global", JSON.stringify(store([account("alice", "rt-SECRET-alice-1", 1_000_000)])))

    const discovery = await discoverCredentials({ env, keychain })
    const items = planStrip(discovery, env, ownershipBlockers(discovery.candidates, [held("alice", "rt-SECRET-alice-1", 1_000_000)]))
    expect(items.every(item => item.blockers.length === 0)).toBe(true)

    const outcomes = await executeStrip(items, { now: new Date("2026-09-27T20:00:00Z"), keychain })
    expect(outcomes.map(outcome => outcome.status)).toEqual(["stripped", "stripped", "stripped", "stripped"])

    expect(readFileSync(storePath, "utf8")).not.toContain("rt-SECRET")
    expect(JSON.parse(readFileSync(storePath, "utf8")).accounts[0].email).toBe("alice@example.test")
    expect(statSync(`${storePath}.meridian-backup`).mode & 0o777).toBe(0o600)
    expect(readFileSync(`${storePath}.meridian-backup`, "utf8")).toContain("rt-SECRET-alice-1")
    expect(existsSync(join(pluginDir, "backups"))).toBe(false)
    expect(existsSync(join(pluginDir, "backups.meridian-backup", "codex-credential-snapshot-1.json"))).toBe(true)
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({ other: { type: "api", key: "k" } })
    expect(await keychain.get("oc-codex-multi-auth", "accounts:global")).not.toContain("rt-SECRET")
    expect(await keychain.get("oc-codex-multi-auth", "accounts:global.meridian-backup")).toContain("rt-SECRET-alice-1")
    expect(existsSync(`${storePath}.transaction.lock`)).toBe(false)
    expect(existsSync(`${storePath}.refresh.lock`)).toBe(false)
  })

  it("refuses seats Meridian does not hold or holds an older token for", async () => {
    writeJson(join(home, ".opencode", ACCOUNTS_FILE_NAME), store([account("alice", "rt-SECRET-alice-2", 2_000_000), account("bob", "rt-SECRET-bob-1", 1_000_000)]))
    const discovery = await discoverCredentials({ env })
    const blockers = ownershipBlockers(discovery.candidates, [held("alice", "rt-SECRET-alice-1", 1_000_000)])
    const reasons = new Map([...blockers].map(([candidate, reason]) => [candidate.accountUserId, reason]))
    expect(reasons).toEqual(new Map([["alice", SEAT_REFRESHED_SINCE], ["bob", SEAT_NOT_IMPORTED]]))
    expect(planStrip(discovery, env, blockers)[0]!.blockers).toEqual([`1 seat(s) ${SEAT_REFRESHED_SINCE}`, `1 seat(s) ${SEAT_NOT_IMPORTED}`])
    expect(ownershipBlockers(discovery.candidates, null).size).toBe(2)
  })

  it("waits out a live plugin lock and reclaims an abandoned one", () => {
    const lockPath = join(root, "store.json.transaction.lock")
    mkdirSync(lockPath)
    expect(() => acquirePluginLock(lockPath, { staleMs: 10_000, waitMs: 150, pollMs: 50 })).toThrow(PluginLockHeldError)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)
    const lock = acquirePluginLock(lockPath, { staleMs: 10_000, waitMs: 0 })
    lock.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it("skips a store whose lock a live writer holds", async () => {
    const storePath = join(home, ".opencode", ACCOUNTS_FILE_NAME)
    writeJson(storePath, store([account("alice", "rt-SECRET-alice-1", 1_000_000)]))
    mkdirSync(`${storePath}.transaction.lock`)
    const discovery = await discoverCredentials({ env })
    const outcomes = await executeStrip(planStrip(discovery, env, new Map()), {
      now: new Date(), transactionLock: { waitMs: 100, pollMs: 20 }, refreshLock: { waitMs: 100, pollMs: 20 },
    })
    expect(outcomes[0]!.status).toBe("skipped")
    expect(readFileSync(storePath, "utf8")).toContain("rt-SECRET-alice-1")
    expect(existsSync(`${storePath}.meridian-backup`)).toBe(false)
  })

  it("leaves a source alone when the plugin refreshed it after discovery", async () => {
    const storePath = join(home, ".opencode", ACCOUNTS_FILE_NAME)
    writeJson(storePath, store([account("alice", "rt-SECRET-alice-1", 1_000_000)]))
    const discovery = await discoverCredentials({ env })
    const items = planStrip(discovery, env, ownershipBlockers(discovery.candidates, [held("alice", "rt-SECRET-alice-1", 1_000_000)]))
    writeJson(storePath, store([account("alice", "rt-SECRET-alice-2", 2_000_000)]))

    const outcomes = await executeStrip(items, { now: new Date() })
    expect(outcomes[0]).toEqual(expect.objectContaining({ status: "skipped", detail: CHANGED_SINCE_DISCOVERY }))
    expect(readFileSync(storePath, "utf8")).toContain("rt-SECRET-alice-2")
    expect(existsSync(`${storePath}.meridian-backup`)).toBe(false)
  })

  it("strips only accounts documents", () => {
    expect(stripAccountsText("not json")).toBeNull()
    expect(stripAccountsText(JSON.stringify({ version: 3, accounts: [{ email: "x" }] }))!.removed).toBe(0)
  })
})

describe("runMigration", () => {
  function fixture() {
    const pluginDir = join(home, ".opencode")
    writeJson(join(pluginDir, ACCOUNTS_FILE_NAME), store([account("alice", "rt-SECRET-alice-2", 2_000_000), account("bob", "rt-SECRET-bob-1", 1_000_000, { enabled: false })]))
    writeJson(join(pluginDir, "backups", "codex-credential-snapshot-1.json"), store([account("alice", "rt-SECRET-alice-1", 1_000_000), account("dave", "rt-SECRET-dave-1", 1_000_000)]))
    const configDir = join(home, ".config", "opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "opencode.jsonc"), `{\n  // operator notes\n  "plugin": ["oc-codex-multi-auth@6"],\n  "provider": { "openai2": { "options": { "apiKey": "{env:OPENAI_API_KEY}" } } }\n}\n`)
    const procRoot = join(root, "proc")
    mkdirSync(procRoot, { recursive: true })
    return { procRoot, configPath: join(configDir, "opencode.jsonc") }
  }

  function options(overrides: Partial<MigrationOptions>, lines: string[]): MigrationOptions {
    return {
      env, steps: ["processes", "import", "strip", "plugin", "provider", "validate"], dryRun: false, force: false,
      providerId: "openai", baseURL: "http://127.0.0.1:3459/v1", apiKey: "meridian", projectDirs: [],
      opencodeDatabasePath: null, includeBackupOnly: false, testPrompt: false, store: null, keychain: null,
      now: () => new Date("2026-09-27T20:00:00Z"), log: line => lines.push(line), ...overrides,
    }
  }

  it("dry run writes nothing and prints no token", async () => {
    const { procRoot } = fixture()
    const before = snapshotTree(root)
    const lines: string[] = []
    const memory = new MemoryStore(join(root, "meridian", "chatgpt-accounts.json"))
    const result = await runMigration(options({ dryRun: true, procRoot, store: memory }, lines))
    const output = lines.join("\n")

    expect(snapshotTree(root)).toEqual(before)
    expect(memory.held).toEqual([])
    expect(output).not.toContain("rt-SECRET")
    expect(output).not.toContain("eyJ")
    expect(output).toContain("would import alice@example.test (alice)")
    expect(output).toContain("skip dave@example.test (dave): only in backups")
    expect(output).toContain("would remove oc-codex-multi-auth@6 from")
    expect(output).toContain("would set provider.openai.options.baseURL to http://127.0.0.1:3459/v1")
    // Strip is planned against a store that holds nothing yet, so a real run would refuse it.
    expect(output).toContain(`BLOCKED: 2 seat(s) ${SEAT_NOT_IMPORTED}`)
    expect(result.exitCode).toBe(1)
  })

  it("migrates end to end and leaves the plugin nothing to refresh", async () => {
    const { procRoot, configPath } = fixture()
    const lines: string[] = []
    const memory = new MemoryStore(join(root, "meridian", "chatgpt-accounts.json"))
    const result = await runMigration(options({ procRoot, store: memory }, lines))
    const output = lines.join("\n")

    expect(output).not.toContain("rt-SECRET")
    expect(memory.held.map(held => [held.accountUserId, held.refreshToken]).sort()).toEqual([["alice", "rt-SECRET-alice-2"], ["bob", "rt-SECRET-bob-1"]])
    expect(readFileSync(join(home, ".opencode", ACCOUNTS_FILE_NAME), "utf8")).not.toContain("rt-SECRET")
    const config = readFileSync(configPath, "utf8")
    expect(config).toContain("// operator notes")
    expect(config).not.toContain("oc-codex-multi-auth")
    expect(config).toContain(`"baseURL": "http://127.0.0.1:3459/v1"`)
    expect(config).toContain(`"apiKey": "{env:OPENAI_API_KEY}"`)
    expect(existsSync(`${configPath}.meridian-backup`)).toBe(true)
    expect(output).toContain("ok alice: seat alice resolves")
    expect(result.exitCode).toBe(0)

    // A second run finds everything done.
    const again: string[] = []
    expect((await runMigration(options({ procRoot, store: memory }, again))).exitCode).toBe(0)
    expect(again.join("\n")).toContain("No opencode config lists oc-codex-multi-auth.")
  })

  it("refuses import and strip while a plugin-loading process runs", async () => {
    const { procRoot } = fixture()
    writeFileSync(join(procRoot, "stat"), "btime 1700000000\n")
    const dir = join(procRoot, "200")
    mkdirSync(dir)
    symlinkSync("/usr/bin/opencode", join(dir, "exe"))
    symlinkSync(root, join(dir, "cwd"))
    writeFileSync(join(dir, "cmdline"), "opencode\0")
    writeFileSync(join(dir, "cgroup"), "0::/user.slice/user-1000.slice/user@1000.service/app.slice/opencode-web.service\n")
    writeFileSync(join(dir, "environ"), `HOME=${home}\0`)
    writeFileSync(join(dir, "stat"), `200 (opencode) S 1 ${Array.from({ length: 17 }, () => "0").join(" ")} 100\n`)

    const lines: string[] = []
    const memory = new MemoryStore(join(root, "meridian", "chatgpt-accounts.json"))
    const result = await runMigration(options({ procRoot, store: memory, steps: ["import", "strip"] }, lines))
    const output = lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(memory.held).toEqual([])
    expect(output).toContain("pid 200 opencode")
    expect(output).toContain("systemctl --user stop opencode-web.service")
    expect(output).toContain("Refusing the import step")
    expect(readFileSync(join(home, ".opencode", ACCOUNTS_FILE_NAME), "utf8")).toContain("rt-SECRET-alice-2")
  })
})

describe("Meridian's owned store", () => {
  function importable(seat: string, refresh: string): ImportAccount {
    return { accountUserId: seat, accountId: `ws-${seat}`, email: `${seat}@example.test`, refreshToken: refresh, accessToken: null, expiresAt: null, tokenRotatedAt: 5 }
  }

  it("imports through the store's own writer and releases the lease", async () => {
    const storePath = join(root, "meridian", "chatgpt-accounts.json")
    const adapter = createOwnedStoreAdapter({ storePath, meridianUrl: "http://127.0.0.1:1" })
    expect(adapter.readHeld()).toEqual([])
    await adapter.importAccounts([importable("alice", "rt-SECRET-alice-1"), importable("bob", "rt-SECRET-bob-1")])
    await adapter.importAccounts([importable("alice", "rt-SECRET-alice-2")])

    const stored = createChatGptCredentialStore({ path: storePath }).readAccounts()
    expect(stored.map(account => [account.accountUserId, account.refreshToken, account.exchangeStartedAt])).toEqual([
      ["alice", "rt-SECRET-alice-2", null],
      ["bob", "rt-SECRET-bob-1", null],
    ])
    expect(statSync(storePath).mode & 0o777).toBe(0o600)
    expect(existsSync(chatGptLockPath(storePath))).toBe(false)
  })

  it("refuses to import while a running Meridian holds the writer lease", async () => {
    const storePath = join(root, "meridian", "chatgpt-accounts.json")
    const lease = await acquireWriterLease({ lockPath: chatGptLockPath(storePath), waitMs: 0 })
    try {
      const adapter = createOwnedStoreAdapter({ storePath, meridianUrl: "http://127.0.0.1:1" })
      await expect(adapter.importAccounts([importable("alice", "rt-SECRET-alice-1")])).rejects.toBeInstanceOf(MeridianOwnsStoreError)
      expect(existsSync(storePath)).toBe(false)
    } finally {
      lease.release()
    }
  })

  it("validates each seat and sends the test prompt through the running Meridian", async () => {
    const storePath = join(root, "meridian", "chatgpt-accounts.json")
    const requests: Array<{ url: string; body: unknown; apiKey: string | null }> = []
    const fakeMeridian = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      requests.push({ url, body, apiKey: new Headers(init?.headers).get("x-api-key") })
      if (url.endsWith("/health")) return Response.json({ status: "healthy", chatgpt: { mode: "owned", serving: true, accounts: 2 } })
      if (url.endsWith("/providers/status")) {
        return Response.json({ fetchedAt: 1, providers: [{ id: "chatgpt", accounts: [
          { id: "alice", label: "alice@example.test · id:alice", windows: [{ type: "5h", utilization: 0.12, resetsAt: 1 }] },
          { id: "bob", label: "bob@example.test · id:bob", error: "Needs an interactive login.", windows: [] },
        ] }] })
      }
      if (body?.model === "gpt-6-luna") return Response.json({ error: { message: "model not available" } }, { status: 400 })
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] })
    }) as typeof fetch
    const adapter = createOwnedStoreAdapter({ storePath, meridianUrl: "http://127.0.0.1:3459/", apiKey: "local-key", fetchImpl: fakeMeridian })
    await adapter.importAccounts([importable("alice", "rt-SECRET-alice-1"), importable("bob", "rt-SECRET-bob-1")])

    expect(await adapter.validateSeat!("alice")).toEqual({ ok: true, detail: "alice@example.test · id:alice: 5h 12% used" })
    expect(await adapter.validateSeat!("bob")).toEqual({ ok: false, detail: "Needs an interactive login." })
    expect(await adapter.testPrompt!()).toEqual({ ok: true, detail: `gpt-5.4-mini answered "OK"` })
    expect(requests.filter(request => request.url.endsWith("/health"))).toHaveLength(1)
    expect(requests.map(request => request.url)).toContain("http://127.0.0.1:3459/v1/responses")
    expect(requests.every(request => request.apiKey === "local-key")).toBe(true)
  })

  it("tells apart seats that share an email by their seat id", async () => {
    const storePath = join(root, "meridian", "chatgpt-accounts.json")
    // Listed in the opposite order to the store: the seat id decides, not the position.
    const listed = [
      { id: "seat-b", label: "shared@example.test · id:seat-b", error: "Needs an interactive login.", windows: [] },
      { id: "seat-a", label: "shared@example.test · id:seat-a", windows: [{ type: "5h", utilization: 0.1, resetsAt: 1 }] },
    ]
    const fakeMeridian = (async (input: string | URL | Request) => String(input).endsWith("/health")
      ? Response.json({ chatgpt: { mode: "owned" } })
      : Response.json({ providers: [{ id: "chatgpt", accounts: listed }] })) as typeof fetch
    const adapter = createOwnedStoreAdapter({ storePath, meridianUrl: "http://127.0.0.1:3459", fetchImpl: fakeMeridian })
    await adapter.importAccounts([
      { ...importable("seat-a", "rt-SECRET-a"), email: "shared@example.test" },
      { ...importable("seat-b", "rt-SECRET-b"), email: "shared@example.test" },
    ])
    expect(await adapter.validateSeat!("seat-a")).toEqual({ ok: true, detail: "shared@example.test · id:seat-a: 5h 10% used" })
    expect(await adapter.validateSeat!("seat-b")).toEqual({ ok: false, detail: "Needs an interactive login." })

    listed.shift()
    const stale = createOwnedStoreAdapter({ storePath, meridianUrl: "http://127.0.0.1:3459", fetchImpl: fakeMeridian })
    expect((await stale.validateSeat!("seat-b")).detail).toContain("Meridian does not list shared@example.test · id:seat-b")
  })

  it("reports a Meridian still following the plugin store", async () => {
    const adapter = createOwnedStoreAdapter({
      storePath: join(root, "store.json"),
      meridianUrl: "http://127.0.0.1:3459",
      fetchImpl: (async () => Response.json({ chatgpt: { mode: "follow-external" } })) as unknown as typeof fetch,
    })
    const result = await adapter.validateSeat!("alice")
    expect(result.ok).toBe(false)
    expect(result.detail).toContain(`"follow-external" mode`)
  })

  it("feeds runMigration end to end", async () => {
    writeJson(join(home, ".opencode", ACCOUNTS_FILE_NAME), store([account("alice", "rt-SECRET-alice-2", 2_000_000)]))
    const procRoot = join(root, "proc")
    mkdirSync(procRoot, { recursive: true })
    const storePath = join(root, "meridian", "chatgpt-accounts.json")
    const lines: string[] = []
    const result = await runMigration({
      env, steps: ["import", "strip"], dryRun: false, force: false, providerId: "openai",
      baseURL: "http://127.0.0.1:3459/v1", apiKey: "meridian", projectDirs: [], opencodeDatabasePath: null,
      includeBackupOnly: false, testPrompt: false, keychain: null, procRoot,
      store: createOwnedStoreAdapter({ storePath, meridianUrl: "http://127.0.0.1:3459" }),
      log: line => lines.push(line),
    })
    expect(result.exitCode).toBe(0)
    expect(createChatGptCredentialStore({ path: storePath }).readAccounts().map(account => account.refreshToken)).toEqual(["rt-SECRET-alice-2"])
    expect(readFileSync(join(home, ".opencode", ACCOUNTS_FILE_NAME), "utf8")).not.toContain("rt-SECRET")
    expect(lines.join("\n")).not.toContain("rt-SECRET")
  })
})

describe("chatgpt-migrate arguments", () => {
  it("parses steps, provider and URLs", () => {
    const parsed = parseMigrateArgs(["--dry-run", "--step", "strip,import", "--provider", "openai-meridian", "--meridian-url", "http://127.0.0.1:3459/", "--api-key-env", "MERIDIAN_API_KEY"], {})
    expect(parsed.steps).toEqual(["strip", "import"])
    expect(parsed.baseURL).toBe("http://127.0.0.1:3459/v1")
    expect(parsed.apiKey).toBe("{env:MERIDIAN_API_KEY}")
    expect(parseMigrateArgs([], { MERIDIAN_PORT: "3457" }).baseURL).toBe("http://127.0.0.1:3457/v1")
    expect(parseMigrateArgs([], {}).steps).toHaveLength(6)
  })

  it("never prints the credential parts of a URL", () => {
    expect(printableUrl("https://user:SECRET@proxy.example/v1?key=SECRET")).toBe("https://proxy.example/v1")
    expect(printableUrl("not a url SECRET")).toBe("(not a URL)")
  })

  it("rejects what it does not understand", () => {
    expect(() => parseMigrateArgs(["--stepp", "import"], {})).toThrow(MigrateUsageError)
    expect(() => parseMigrateArgs(["--step", "everything"], {})).toThrow(MigrateUsageError)
    expect(() => parseMigrateArgs(["--api-key-env", "not a name"], {})).toThrow(MigrateUsageError)
  })
})
