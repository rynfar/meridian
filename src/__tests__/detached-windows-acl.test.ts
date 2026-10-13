import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { finished } from "node:stream/promises"
import { promisify } from "node:util"
import { checkDetachedWindowsAcl, checkDetachedFileAclIfPresent } from "../cli/detachedWindowsAcl"
import { detachedPaths, publishDetachedRecord, readDetachedRecord } from "../cli/detachedStore"
import { DetachedLog } from "../cli/detachedLog"

const execute = promisify(execFile)

test("record retirement during ACL inspection is absence, while replacement or denial stays a failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "meridian-acl-retirement-"))
  const path = join(root, "record")
  const denial = new Error("ACL inspection failed")
  try {
    await writeFile(path, "owned")
    expect(await checkDetachedFileAclIfPresent(path, async target => {
      await rm(target)
      throw denial
    })).toBe(false)
    await writeFile(path, "replacement")
    await expect(checkDetachedFileAclIfPresent(path, async () => { throw denial })).rejects.toBe(denial)
    expect(await readFile(path, "utf8")).toBe("replacement")
    expect(await checkDetachedFileAclIfPresent(path, async () => undefined)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function acl(path: string, broaden = false): Promise<string> {
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:MERIDIAN_TEST_ACL_PATH
$acl = Get-Acl -LiteralPath $path
if ($env:MERIDIAN_TEST_ACL_BROADEN -eq '1') {
  $everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
  $acl = Get-Acl -LiteralPath $path
}
[Console]::WriteLine($acl.Sddl)
`], { env: { ...process.env, MERIDIAN_TEST_ACL_PATH: path, MERIDIAN_TEST_ACL_BROADEN: broaden ? "1" : "0" }, timeout: 10000 })
  return stdout.trim()
}

test.skipIf(process.platform !== "win32")("native Windows creates protected private state and refuses to repair a broadened directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "meridian-acl-"))
  try {
    // Metacharacters stay literal; they must never become PowerShell source.
    const config = join(root, "config ' [literal] $value")
    const paths = await detachedPaths(config, "127.0.0.1", 3456, true)
    expect(paths).toBeDefined()
    await checkDetachedWindowsAcl(paths!.root, "inspect-directory")
    const before = await acl(paths!.root, true)
    await expect(detachedPaths(config, "127.0.0.1", 3456, true)).rejects.toThrow("private Windows ACL")
    expect(await acl(paths!.root)).toBe(before)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)

test.skipIf(process.platform !== "win32")("native Windows refuses a public record and public historical logs without modifying them", async () => {
  const root = await mkdtemp(join(tmpdir(), "meridian-acl-files-"))
  try {
    const paths = (await detachedPaths(root, "127.0.0.1", 3456, true))!
    const record = { version: 1 as const, instanceId: "12".repeat(16), nonce: "ab".repeat(32), host: paths.host, port: paths.port, startedAt: 1000,
      owner: { version: 1 as const, pid: 999, hostId: "0".repeat(64), bootId: "11111111-1111-1111-1111-111111111111", startId: "1", startIdKind: "linux-proc-start-ticks" as const } }
    await publishDetachedRecord(paths, record)
    expect(await readDetachedRecord(paths)).toEqual(record)
    await acl(paths.record, true)
    await expect(readDetachedRecord(paths)).rejects.toThrow("private Windows ACL")
    expect(JSON.parse(await readFile(paths.record, "utf8"))).toEqual(record)
    const log = await DetachedLog.create(paths.log, 8)
    const joined = finished(log)
    log.end("123456789")
    await joined
    expect(await readFile(paths.log, "utf8")).toBe("9")
    await acl(paths.log + ".1", true)
    await expect(DetachedLog.create(paths.log, 8)).rejects.toThrow("private Windows ACL")
    expect(await readFile(paths.log + ".1", "utf8")).toBe("12345678")
    await rm(paths.log + ".1")
    await acl(paths.log, true)
    await expect(DetachedLog.create(paths.log, 8)).rejects.toThrow("private Windows ACL")
    expect(await readFile(paths.log, "utf8")).toBe("9")
  } finally { await rm(root, { recursive: true, force: true }) }
}, 120000)

test.skipIf(process.platform !== "win32")("native Windows leaves inherited existing directories untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "meridian-acl-existing-"))
  try {
    const directory = join(root, "detached")
    await mkdir(directory)
    await writeFile(join(directory, "retain"), "existing")
    const before = await acl(directory)
    await expect(detachedPaths(root, "127.0.0.1", 3456, true)).rejects.toThrow("private Windows ACL")
    expect(await acl(directory)).toBe(before)
    expect(await readFile(join(directory, "retain"), "utf8")).toBe("existing")
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)

test.skipIf(process.platform !== "win32")("native Windows missing-file ACL failure is retirement only when the record is still absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "meridian-acl-native-retirement-"))
  try {
    const paths = (await detachedPaths(root, "127.0.0.1", 3456, true))!
    await writeFile(paths.record, "owned")
    expect(await checkDetachedFileAclIfPresent(paths.record, async target => {
      await rm(target)
      // Reproduce the native failure when owner cleanup wins before Get-Acl.
      await checkDetachedWindowsAcl(target, "inspect-file")
    })).toBe(false)
    await writeFile(paths.record, "replacement")
    await acl(paths.record, true)
    await expect(checkDetachedFileAclIfPresent(paths.record)).rejects.toThrow("private Windows ACL")
    expect(await readFile(paths.record, "utf8")).toBe("replacement")
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)


test.skipIf(process.platform !== "win32")("native Windows ACL checks work without PowerShell module discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "meridian-acl-module-free-"))
  const moduleUrl = new URL("../cli/detachedWindowsAcl.ts", import.meta.url).href
  const directory = join(root, "private ' [literal] $value")
  const environment = Object.fromEntries(
    ["PATH", "HOME", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC", "PATHEXT"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]),
  )
  try {
    const { stdout } = await execute(process.execPath, ["-e", `
      import {checkDetachedWindowsAcl} from ${JSON.stringify(moduleUrl)};
      const path = ${JSON.stringify(directory)};
      await checkDetachedWindowsAcl(path, "create-directory");
      await checkDetachedWindowsAcl(path, "inspect-directory");
      await Bun.write(path + "/record", "owned");
      await checkDetachedWindowsAcl(path + "/record", "inspect-file");
      let rejected = false;
      try { await checkDetachedWindowsAcl(path + "/record", "inspect-directory"); }
      catch { rejected = true; }
      if (!rejected) throw new Error("Wrong-kind path was accepted");
      console.log("private-and-kind-checked");
    `], { env: { ...environment, PSModulePath: join(root, "no-modules") }, timeout: 60000, maxBuffer: 16384 })
    expect(stdout.trim()).toBe("private-and-kind-checked")
  } finally { await rm(root, { recursive: true, force: true }) }
}, 65000)
