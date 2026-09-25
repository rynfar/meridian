#!/usr/bin/env python3
"""Exercise the systemd fd 3 contract with a real Node proxy process.

Run after npm run build. --live additionally sends one Claude Max request.
The parent keeps the listener open, as a systemd socket unit would.
"""

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


parser = argparse.ArgumentParser()
parser.add_argument("--live", action="store_true")
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
node = os.environ.get("E2E_NODE_BIN", "node")
scratch = Path(tempfile.mkdtemp(prefix="meridian-socket-e2e-"))
listener = socket.socket()
assert listener.fileno() == 3, "Run the probe without inherited extra descriptors"
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", 0))
listener.listen(32)
port = listener.getsockname()[1]
base = f"http://127.0.0.1:{port}"
log = scratch / "proxy.log"
processes = []


def request(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", "x-meridian-agent": "pi"} if data else {}
    req = Request(base + path, data=data, headers=headers)
    try:
        with urlopen(req, timeout=20) as response:
            return response.status, response.read().decode()
    except HTTPError as error:
        return error.code, error.read().decode()


def start():
    env = os.environ.copy()
    for key in ("MERIDIAN_API_KEY", "CLAUDE_PROXY_IDLE_EXIT_SECONDS"):
        env.pop(key, None)
    env.update({
        "LISTEN_FDS": "1",
        "MERIDIAN_IDLE_EXIT_SECONDS": "2",
        "MERIDIAN_CONFIG_DIR": str(scratch / "config"),
        "MERIDIAN_SESSION_DIR": str(scratch / "sessions"),
        "MERIDIAN_WORKDIR": str(scratch),
        "MERIDIAN_TELEMETRY_PERSIST": "0",
        "MERIDIAN_PORT": str(port),
    })
    command = f'LISTEN_PID=$$ exec "{node}" "{repo / "dist/cli.js"}"'
    output = log.open("ab")
    child = subprocess.Popen(["/bin/sh", "-c", command], env=env,
                             pass_fds=(3,), stdout=output, stderr=subprocess.STDOUT)
    output.close()
    processes.append(child)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        assert child.poll() is None, log.read_text(errors="replace")[-2000:]
        try:
            status, _ = request("/health")
            if status == 200:
                return child
        except (URLError, TimeoutError):
            pass
        time.sleep(0.1)
    raise AssertionError("socket-activated proxy did not become healthy: " + log.read_text()[-2000:])


try:
    first = start()
    if args.live:
        status, body = request("/v1/messages", {
            "model": "claude-haiku-4-5", "max_tokens": 80,
            "messages": [{"role": "user", "content": "Reply briefly with a greeting."}],
        })
        assert status == 200, (status, body)
        assert any(block.get("type") == "text" and block.get("text") for block in json.loads(body)["content"])
    time.sleep(1.1)
    status, _ = request("/v1/messages", {"model": "claude-haiku-4-5"})
    assert status == 400, status  # Fast model-route request still resets idle time.
    time.sleep(1.2)
    assert first.poll() is None, "exited on the original idle deadline after a short request"
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and first.poll() is None:
        status, _ = request("/health")
        assert status == 200, status  # Health polls must not reset idle time.
        time.sleep(0.25)
    assert first.wait(timeout=3) == 0, log.read_text(errors="replace")[-2000:]
    second = start()
    assert second.pid != first.pid
    status, _ = request("/health")
    assert status == 200
    print(json.dumps({"result": "PASS", "platform": os.uname().sysname,
                      "node": subprocess.check_output([node, "--version"], text=True).strip(),
                      "live": args.live, "port": port, "first_pid": first.pid,
                      "second_pid": second.pid, "log": str(log)}))
finally:
    for child in processes:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    listener.close()
