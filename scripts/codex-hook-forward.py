#!/usr/bin/env python3
"""
Forward an OpenAI Codex CLI hook payload to the pixel-agents Tauri app.

Codex invokes this via `~/.codex/hooks.json` (requires
`[features] codex_hooks = true` in `~/.codex/config.toml`). The payload
arrives on stdin as JSON; we stamp `source: "codex"` + parent PID and
ship one line to `~/.pixel-agents/bus.sock`. Silent on the happy path;
always exits 0 so a missing app never blocks Codex.
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
    payload["source"] = "codex"
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
