#!/usr/bin/env python3
"""
Forward a Grok CLI hook payload to the pixel-agents Tauri app.

Grok invokes this via `~/.grok/user-settings.json`. Payload arrives on
stdin as JSON; we stamp `source: "grok"` + parent PID and ship one line
to `~/.pixel-agents/bus.sock`. Silent on the happy path; exit 0 always
so a missing app never blocks Grok.
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
    payload["source"] = "grok"
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
