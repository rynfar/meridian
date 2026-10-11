#!/usr/bin/env python3
"""Verify the frozen E72 snapshot containment packet without auth or SDK calls."""
import gzip
import hashlib
import json
import re
from pathlib import Path

evidence = Path(__file__).resolve().parent
repository = evidence.parents[4]
digest = lambda value: hashlib.sha256(value).hexdigest()
manifest = json.loads((evidence / "verified-artifacts.json").read_text())
for name, expected in manifest.items():
    relative = Path(name)
    assert not relative.is_absolute() and ".." not in relative.parts, name
    assert digest((evidence / relative).read_bytes()) == expected, name
receipt = json.loads((evidence / "receipt.json").read_text())
for name, expected in [
    ("before-harness.mjs.gz", receipt["before_source_sha256"]),
    ("after-harness.mjs.gz", receipt["after_source_sha256"]),
    ("control-test.ts.gz", receipt["exact_test_sha256_before_after"]),
]:
    assert digest(gzip.decompress((evidence / name).read_bytes())) == expected, name
assert digest((repository / receipt["source_path"]).read_bytes()) == receipt["after_source_sha256"]
assert digest((repository / receipt["test_path"]).read_bytes()) == receipt["exact_test_sha256_before_after"]
assert digest(gzip.decompress((evidence / "frozen-delta.patch.gz").read_bytes())) == receipt["frozen_delta_sha256"]
assert all(check["exit_code"] == 0 for check in receipt["final_narrow_checks"])
for log in receipt["logs"]:
    archive = evidence / log["archive_path"]
    assert digest(archive.read_bytes()) == log["archive_sha256"]
    raw = gzip.decompress(archive.read_bytes())
    assert digest(raw) == log["raw_sha256"]
    summary = re.search(r"\n\s*(\d+) pass\n(?:\s*\d+ filtered out\n)?\s*(\d+) fail\n\s*(\d+) expect\(\) calls", raw.decode())
    assert summary and tuple(map(int, summary.groups())) == (log["pass"], log["fail"], log["assertions"])
for arm in ["before", "after"]:
    for kind, row in receipt["snapshot_controls"][arm].items():
        assert row == json.loads((evidence / arm / f"{kind}.json").read_text())
        assert row["joined"] and row["networkAttempts"] == 0
        assert not row["sdkInvoked"] and row["queryCount"] == 0 and not row["acceptance"]
        assert row["cleanupFailures"] == [] and row["privateRuntimeRemoved"]
for kind in ["symlink", "directory", "hardlink", "writable"]:
    before = receipt["snapshot_controls"]["before"][kind]
    after = receipt["snapshot_controls"]["after"][kind]
    assert before["contentReadAttempts"] > 0 and after["contentReadAttempts"] == 0
    assert after["code"] == 1 and not after["privateSnapshotCreated"]
assert not receipt["native_e72_acceptance"]
assert not receipt["full_suite_typecheck_build_run"]
assert not receipt["actual_blocking_fifo_run"]
print(json.dumps({"verified_artifacts": len(manifest), "exact_before_after_controls": 5,
                  "full_focused_tests": 27, "native_acceptance": False}))
