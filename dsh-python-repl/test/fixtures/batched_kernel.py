"""A fake protocol-3 kernel that emits `done` and a late `host_request` in ONE write.

Exists to make the `done`-then-revoke ordering testable deterministically. A real kernel is a
poor instrument here: whether its two frames land in the same pipe read is a
scheduling accident, so a test built on it proves nothing on the run where they
happen to arrive separately.

This fixture removes the accident. It writes both frames with a single
`os.write`, so the host's dispatch loop is guaranteed to parse `done` and the
trailing `host_request` inside one chunk, without yielding in between. If the
lease is revoked only in the promise continuation (a microtask), the request is
served with the settled cell's authority — exactly the window under test.

Protocol per vendor/prime/rlm/repl.md; only the parts the test needs.
"""

from __future__ import annotations

import json
import os
import sys


def emit(payload: dict) -> None:
    os.write(1, (json.dumps(payload) + "\n").encode("utf-8"))


def main() -> None:
    emit({"event": "ready", "protocol": 3, "python": "3.12.0-fake"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        kind = request.get("type")
        if kind == "shutdown":
            return
        if kind == "host_reply":
            # The host answered our late request. Report what it decided so the
            # test can assert on the refusal rather than infer it.
            os.write(
                2, (f"HOST_REPLY {json.dumps(request.get('data'))}\n").encode("utf-8")
            )
            continue
        if kind != "execute":
            continue

        run_id = request["id"]
        # THE POINT: one write, `done` first, then a tool call tagged with the
        # cell that just finished.
        frames = [
            {"event": "done", "id": run_id, "status": "ok"},
            {
                "event": "host_request",
                "id": f"late-{run_id}",
                "data": {
                    "kind": "tool_call",
                    "runId": run_id,
                    "epoch": 1,
                    "tool": "late",
                    "args": {"from": "after done"},
                },
            },
        ]
        os.write(1, ("".join(json.dumps(f) + "\n" for f in frames)).encode("utf-8"))


if __name__ == "__main__":
    main()
