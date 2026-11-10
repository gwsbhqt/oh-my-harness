"""Extract every executed code snippet from DSH, Prime, Claude Code and Codex sessions.

    python3 scripts/habits/corpus.py            → $HABITS_DIR/corpus.jsonl

One record per snippet: {src, session, seq, lang (py|js), kind, code, ok}.
kind: cell (a persistent-kernel cell), heredoc / -c (python embedded in a
shell command), browser (JS evaluated in a page). ok is False when the tool
reported an error, None when unknown.
"""

import glob
import json
import os
import re
import shlex
import subprocess
from collections import Counter

from common import HERE, OUT

HOME = os.path.expanduser("~")
HEREDOC = re.compile(
    r"(?:python3?|uv run(?: [^\n<]*?)? python3?|\bpython3?\.\d+)\b[^\n<|;&]*?<<-?\s*(['\"]?)(\w+)\1[^\n]*\n(.*?)\n\s*\2\s*(?:\n|$)",
    re.S,
)
DASH_C = re.compile(r"\bpython3?(?:\.\d+)?\s+-c\s+")


def shell_python(cmd):
    for m in HEREDOC.finditer(cmd):
        yield "heredoc", m.group(3)
    for m in DASH_C.finditer(cmd):
        try:
            words = shlex.split(cmd[m.end():], posix=True)
        except ValueError:
            continue
        if words:
            yield "-c", words[0]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    out = open(OUT / "corpus.jsonl", "w")
    n = Counter()

    def emit(src, session, seq, lang, kind, code, ok):
        if isinstance(code, str) and code.strip():
            n[(src, kind)] += 1
            out.write(json.dumps({"src": src, "session": session, "seq": seq, "lang": lang, "kind": kind,
                                  "code": code, "ok": ok}, ensure_ascii=False) + "\n")

    # DSH: sessions are zstd; node decodes them.
    dsh = subprocess.run(["node", str(HERE / "dsh_calls.mjs")], capture_output=True, text=True, check=True).stdout
    for line in dsh.splitlines():
        c = json.loads(line)
        try:
            args = json.loads(c["args"]) if isinstance(c["args"], str) else c["args"]
        except ValueError:
            continue
        ok = None if c["isError"] is None else not c["isError"]
        if c["name"] == "run_code":
            emit("dsh", c["session"], c["seq"], "py", "cell", args.get("code"), ok)
        elif c["name"] == "bash":
            for kind, code in shell_python(args.get("command", "")):
                emit("dsh", c["session"], c["seq"], "py", kind, code, ok)

    # Prime (pa)
    for f in glob.glob(f"{HOME}/.prime/agent/sessions/**/*.jsonl", recursive=True):
        session, calls, results = os.path.basename(f)[:-6], [], {}
        for i, line in enumerate(open(f, errors="replace")):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") != "message":
                continue
            m = d["message"]
            if m.get("role") == "toolResult":
                results[m.get("toolCallId")] = m.get("isError")
            elif isinstance(m.get("content"), list):
                calls += [(i, b) for b in m["content"] if b.get("type") == "toolCall"]
        for i, b in calls:
            args, err = b.get("arguments") or {}, results.get(b.get("id"))
            ok = None if err is None else not err
            if isinstance(args.get("code"), str):
                emit("prime", session, i, "py", "cell", args["code"], ok)
            elif isinstance(args.get("command"), str):
                for kind, code in shell_python(args["command"]):
                    emit("prime", session, i, "py", kind, code, ok)

    # Claude Code
    for f in glob.glob(f"{HOME}/.claude/projects/*/*.jsonl"):
        session, calls, results = os.path.basename(f)[:-6], [], {}
        for i, line in enumerate(open(f, errors="replace")):
            if '"tool_use"' not in line and '"tool_result"' not in line:
                continue
            try:
                content = (json.loads(line).get("message") or {}).get("content")
            except ValueError:
                continue
            for b in content if isinstance(content, list) else []:
                if b.get("type") == "tool_use":
                    calls.append((i, b))
                elif b.get("type") == "tool_result":
                    results[b.get("tool_use_id")] = b.get("is_error")
        for i, b in calls:
            name, inp, err = b.get("name", ""), b.get("input") or {}, results.get(b.get("id"))
            ok = None if err is None else not err
            if name.startswith("mcp__") and name.endswith(("__repl", "__python")) and isinstance(inp.get("code"), str):
                emit("claude", session, i, "py", "cell", inp["code"], ok)
            elif name == "Bash":
                for kind, code in shell_python(inp.get("command", "")):
                    emit("claude", session, i, "py", kind, code, ok)
            elif name == "mcp__chrome-devtools__evaluate_script" and isinstance(inp.get("function"), str):
                emit("claude", session, i, "js", "browser", inp["function"], ok)

    # Codex: `exec` cells are JavaScript; shell commands may embed python.
    for f in glob.glob(f"{HOME}/.codex/sessions/**/*.jsonl", recursive=True):
        session, calls, results = os.path.basename(f)[:-6], [], {}
        for i, line in enumerate(open(f, errors="replace")):
            try:
                p = json.loads(line).get("payload") or {}
            except ValueError:
                continue
            if p.get("type") in ("custom_tool_call", "function_call", "local_shell_call"):
                calls.append((i, p))
            elif p.get("type") in ("custom_tool_call_output", "function_call_output"):
                o = p.get("output")
                results[p.get("call_id")] = "Script failed" in (o if isinstance(o, str) else json.dumps(o))[:400]
        for i, p in calls:
            err = results.get(p.get("call_id"))
            ok = None if err is None else not err
            if p.get("type") == "custom_tool_call" and p.get("name") == "exec":
                emit("codex", session, i, "js", "cell", p.get("input"), ok)
            elif p.get("name") in ("shell", "exec_command"):
                try:
                    a = json.loads(p.get("arguments") or "{}")
                except ValueError:
                    continue
                cmd = a.get("cmd") or a.get("command")
                if isinstance(cmd, list):
                    cmd = cmd[-1] if cmd and cmd[0] in ("bash", "zsh", "sh", "fish") else " ".join(cmd)
                if isinstance(cmd, str):
                    for kind, code in shell_python(cmd):
                        emit("codex", session, i, "py", kind, code, ok)

    out.close()
    for (src, kind), v in sorted(n.items()):
        print(f"{src:7} {kind:8} {v}")
    print("total", sum(n.values()), "→", OUT / "corpus.jsonl")


if __name__ == "__main__":
    main()
