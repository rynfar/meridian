import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import { lstat } from "node:fs/promises"

const execute = promisify(execFile)

// Windows PowerShell 5.1 supplies the Framework CreateDirectory overload that
// installs the protected DACL at creation, without a broadly inherited interval.
// Existing paths are inspected, never repaired or adopted by changing their ACL.
// Use Framework APIs directly: Get-Acl module autoload fails in the clean
// Windows CLI environment. ACL checks must not depend on profile/module setup.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:MERIDIAN_DETACHED_ACL_PATH
$action = $env:MERIDIAN_DETACHED_ACL_ACTION
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sidType = [System.Security.Principal.SecurityIdentifier]
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
if ($action -eq 'create-directory') {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  [void][System.IO.Directory]::CreateDirectory($path, $security)
}
$attributes = [System.IO.File]::GetAttributes($path)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Detached ACL path is a reparse point' }
$directory = $action -ne 'inspect-file'
if ((($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) -ne $directory) { throw 'Detached ACL path has the wrong kind' }
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
if ($directory) { $acl = [System.IO.Directory]::GetAccessControl($path, $sections) }
else { $acl = [System.IO.File]::GetAccessControl($path, $sections) }
$trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($acl.GetOwner($sidType).Value -notin $trusted) { throw 'Detached ACL owner is not trusted' }
if ($directory -and -not $acl.AreAccessRulesProtected) { throw 'Detached directory ACL inherits outside access' }
$currentFull = $false
foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
  if ($rule.IdentityReference.Value -notin $trusted) { throw 'Detached ACL permits another principal' }
  if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band $full) -eq $full -and ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) {
    if (-not $directory -or ($rule.InheritanceFlags -band $inherit) -eq $inherit) { $currentFull = $true }
  }
}
if (-not $currentFull) { throw 'Detached ACL lacks current-user ownership rights' }
[Console]::WriteLine('private')
`

/** No user-controlled text is interpolated into PowerShell source. */
export async function checkDetachedWindowsAcl(path: string, action: "create-directory" | "inspect-directory" | "inspect-file"): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows ACL checks require Windows")
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  try {
    const { stdout } = await execute(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")], {
      env: { ...process.env, MERIDIAN_DETACHED_ACL_PATH: path, MERIDIAN_DETACHED_ACL_ACTION: action },
      windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
    })
    if (stdout.trim() !== "private") throw new Error("Unexpected Windows ACL result")
  } catch (cause) {
    throw new Error("Detached path must have a private Windows ACL", { cause })
  }
}

/** A retiring owner can remove its record while the asynchronous ACL probe runs. */
export async function checkDetachedFileAclIfPresent(
  path: string,
  inspect: (path: string) => Promise<void> = path => checkDetachedWindowsAcl(path, "inspect-file"),
): Promise<boolean> {
  try { await inspect(path); return true }
  catch (failure) {
    // Only confirmed absence is ordinary retirement. Permission errors, a
    // replacement file, and unknown filesystem failures retain the rejection.
    try { await lstat(path) }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    }
    throw failure
  }
}
