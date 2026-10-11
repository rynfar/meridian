#!/usr/bin/env python3
"""Read public official distribution bytes only; never execute or install them."""
import argparse, hashlib, json, mmap
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("record", type=Path)
    args = parser.parse_args()
    record = json.loads(args.record.read_text())
    digest = hashlib.sha256()
    with args.binary.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != record["inspectedArtifactSha256"]:
        raise SystemExit("Pinned binary SHA256 mismatch")
    with args.binary.open("rb") as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
        for item in record["locations"]:
            start = item["binaryByteOffsetStart"]
            end = item["binaryByteOffsetEndExclusive"]
            raw = data[start:end]
            if len(raw) != item["bytes"] or hashlib.sha256(raw).hexdigest() != item["sha256"]:
                raise SystemExit("Slice mismatch: " + item["id"])
            lower, upper = item["searchRange"]
            if data.find(item["locateStartUtf8"].encode(), lower, upper) != start:
                raise SystemExit("Start locator mismatch: " + item["id"])
            if data.find(item["locateEndUtf8"].encode(), start + len(item["locateStartUtf8"].encode()), upper) != end:
                raise SystemExit("End locator mismatch: " + item["id"])
    print(json.dumps({"pinnedBinaryVerified": True, "allStaticLocationsVerified": len(record["locations"]), "executedBinary": False, "readCredentials": False}))

if __name__ == "__main__":
    main()
