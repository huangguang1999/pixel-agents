#!/usr/bin/env python3
"""
Forward a Claude Code hook payload to the pixel-agents Tauri app.

Claude Code invokes this via its `hooks` config; it passes the hook payload
as JSON on stdin. We add a `source: "claude"` field (so the Rust adapter
dispatches correctly) and send it as one line to ~/.pixel-agents/bus.sock.

Designed to be silent and fast on the happy path. Exits 0 regardless so a
missing app never blocks Claude.
"""
import json
import os
import socket
import sys

SOCKET_PATH = os.path.expanduser("~/.pixel-agents/bus.sock")


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return 0
    if not isinstance(payload, dict):
        return 0
    payload.setdefault("source", "claude")
    # Record the parent PID so the app can detect when Claude Code dies without
    # firing SessionEnd (crash, SIGKILL). Claude invokes this shim as a direct
    # subprocess, so getppid() is the Claude process at the moment of the hook.
    payload["pid"] = os.getppid()
    line = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            s.connect(SOCKET_PATH)
            s.sendall(line)
    except (FileNotFoundError, ConnectionRefusedError, socket.timeout, OSError):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
