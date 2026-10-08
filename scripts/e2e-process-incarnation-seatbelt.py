#!/usr/bin/env python3
"""Actual controlled macOS denial; not nono/client acceptance. Uses Python stdlib."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time

PROGRAM = r"""import { spawnSync } from "node:child_process";
const incarnation = await import(process.env.E2E_PROCESS_INCARNATION_MODULE);
const boot = incarnation.describeLocalBootIdentity();
const result = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {encoding:"utf8",env:{...process.env,LC_ALL:"C",LANG:"C",TZ:"UTC0"},timeout:2000,maxBuffer:1048576});
const errno = result.error && "code" in result.error ? result.error.code : undefined;
const diagnostics = [];
const identity = incarnation.captureProcessIncarnation(process.pid, value => diagnostics.push(value));
const safeErrno = typeof errno === "string" && /^E[A-Z0-9_]{1,31}$/.test(errno) ? errno : undefined;
console.log(JSON.stringify({bootAvailable:boot.available,platform:boot.platform,rawProbeErrno:safeErrno,rawProbeStatus:result.status,captureAvailable:!!identity,diagnostics}));
if (!boot.available || safeErrno !== "EPERM" || identity !== undefined) process.exitCode=1;
const corrected=process.env.E2E_EXPECT_DIAGNOSTIC==="1";
if (corrected ? !diagnostics.some(value=>value.includes("/bin/ps process-identity probe failed (EPERM)")) : diagnostics.length!==0) process.exitCode=1;
"""
POLICY = '(version 1) (allow default) (deny process-exec (literal "/bin/ps"))'


def source_identity(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Source module must be a regular file")
    data = path.read_bytes()
    return {"path": str(path), "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "mode": f"{stat.S_IMODE(info.st_mode):04o}"}


def save(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def command_succeeded(receipt):
    return (receipt.get("exit") == 0
            and not receipt.get("controllerFailureClass")
            and not receipt.get("deadlineExpired")
            and receipt.get("ownedGroupPresenceAfterJoin") == "ESRCH_NO_GROUP")


def run(out, name, argv, additional_env, deadline):
    root = out / name
    root.mkdir(mode=0o700)
    for directory in ("home", "tmp", "cwd"):
        (root / directory).mkdir(mode=0o700)
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(root / "home"),
           "TMPDIR": str(root / "tmp"), **additional_env}
    receipt = {"name": name, "argv": argv, "env": env, "envNames": sorted(env),
               "cwd": str(root / "cwd"), "deadlineSeconds": deadline,
               "startUTC": datetime.datetime.now(datetime.timezone.utc).isoformat(), "started": False}
    save(root / "COMMAND_BEFORE.json", receipt)
    start = time.monotonic()
    child = None
    stdout_fd = os.open(root / "stdout.txt", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    stderr_fd = os.open(root / "stderr.txt", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(stdout_fd, "wb") as stdout, os.fdopen(stderr_fd, "wb") as stderr:
        try:
            child = subprocess.Popen(argv, env=env, cwd=root / "cwd", stdin=subprocess.DEVNULL,
                                     stdout=stdout, stderr=stderr, start_new_session=True)
            receipt.update(started=True, pid=child.pid, initialPgid=os.getpgid(child.pid),
                           initialSid=os.getsid(child.pid), ownedNewSession=True)
            try:
                receipt["exit"] = child.wait(timeout=deadline)
                receipt["deadlineExpired"] = False
            except subprocess.TimeoutExpired:
                receipt["deadlineExpired"] = True
                if os.getpgid(child.pid) != child.pid:
                    raise RuntimeError("Owned group identity changed before cancellation")
                os.killpg(child.pid, signal.SIGTERM)
                receipt["termSent"] = True
                try:
                    receipt["exit"] = child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    receipt["killSent"] = True
                    receipt["exit"] = child.wait(timeout=3)
            receipt["leaderWaitJoined"] = True
            try:
                os.killpg(child.pid, 0)
                receipt["ownedGroupPresenceAfterJoin"] = "PRESENT_OR_ZOMBIE_UNQUALIFIED"
            except ProcessLookupError:
                receipt["ownedGroupPresenceAfterJoin"] = "ESRCH_NO_GROUP"
            except PermissionError:
                receipt["ownedGroupPresenceAfterJoin"] = "UNKNOWN_EPERM"
        except Exception as error:
            receipt["controllerFailureClass"] = type(error).__name__
            receipt["controllerFailure"] = str(error)
            if child is not None and child.poll() is None:
                if os.getpgid(child.pid) == child.pid:
                    os.killpg(child.pid, signal.SIGKILL)
                    receipt["emergencyKillSent"] = True
                receipt["exit"] = child.wait(timeout=3)
                receipt["leaderWaitJoined"] = True
    receipt.update(controllerStdoutFileClosed=stdout.closed, controllerStderrFileClosed=stderr.closed,
                   elapsedSeconds=time.monotonic() - start,
                   endUTC=datetime.datetime.now(datetime.timezone.utc).isoformat())
    for filename in ("stdout.txt", "stderr.txt"):
        receipt[filename] = source_identity(root / filename)
    save(root / "COMMAND_AFTER.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-module", type=Path, required=True)
    parser.add_argument("--corrected-module", type=Path,
                        default=Path(__file__).resolve().parent.parent / "src/proxy/session/processIncarnation.ts")
    parser.add_argument("--bun", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="new private output directory")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This native Seatbelt gate requires macOS; another platform is not acceptance")
    baseline = args.baseline_module.resolve()
    corrected = args.corrected_module.resolve()
    bun = args.bun.resolve()
    before = [source_identity(path) for path in (baseline, corrected)]
    out = args.out.resolve()
    out.mkdir(mode=0o700, exist_ok=False)
    save(out / "SOURCE_BEFORE.json", before)
    save(out / "RUNNER.json", source_identity(Path(__file__).resolve()))
    receipts = [run(out, "00-bun-version", [str(bun), "--version"], {}, 5)]
    stopped = None
    for number, (module, expected) in enumerate(((baseline, "0"), (corrected, "1")), 1):
        previous = receipts[-1]
        if not command_succeeded(previous):
            stopped = "FIRST_MEANINGFUL_FAILURE_NO_RERUN"
            break
        env = {"E2E_PROCESS_INCARNATION_MODULE": str(module), "E2E_EXPECT_DIAGNOSTIC": expected}
        receipt = run(out, f"{number:02d}-" + ("baseline" if expected == "0" else "corrected"),
                      ["/usr/bin/sandbox-exec", "-p", POLICY, str(bun), "--eval", PROGRAM], env, 15)
        receipts.append(receipt)
    if any(not command_succeeded(row) for row in receipts):
        stopped = "FIRST_MEANINGFUL_FAILURE_NO_RERUN"
    after = [source_identity(path) for path in (baseline, corrected)]
    save(out / "SOURCE_AFTER.json", after)
    success = (stopped is None and len(receipts) == 3
               and all(command_succeeded(row) for row in receipts) and before == after)
    result = {"result": "PASS" if success else "FAIL", "receipts": receipts,
              "sourceBeforeAfterEqual": before == after, "stoppedReason": stopped,
              "scope": "ACTUAL_CONTROLLED_DARWIN_MODULE_DIAGNOSTIC_ONLY",
              "exactReporterNonoClientAcceptance": False,
              "baselineExpectation": "absent", "correctedExpectation": "present"}
    save(out / "SUMMARY.json", result)
    print(json.dumps({key: value for key, value in result.items() if key != "receipts"}))
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
