#!/usr/bin/env python3
"""Deterministic, offline text-volume measurements. No model or network calls."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def text_metrics(text):
    units = len(text.encode("utf-16-le")) // 2
    return {"utf8_bytes": len(text.encode("utf-8")), "utf16_units": units,
            "estimated_tokens": (units + 3) // 4}


def make_log(rows):
    for i in range(rows):
        failed = i % 97 == 0
        yield {"seq": i, "service": ("catalog", "checkout", "search")[i % 3],
               "status": 503 if failed else 200,
               "latency_ms": (i * 37) % 4000,
               "detail": "Example diagnostic context; retain the source for follow-up. " * 2}


def locality(rows):
    raw = "".join(canonical(row) + "\n" for row in make_log(rows))
    data = [json.loads(line) for line in raw.splitlines()]
    failures = [row for row in data if row["status"] >= 500]
    counts = Counter(row["service"] for row in failures)
    result = {"total_rows": len(data), "error_rows": len(failures),
              "errors_by_service": dict(sorted(counts.items())),
              "slow_rows": sum(row["latency_ms"] >= 2000 for row in data),
              "max_latency_ms": max(row["latency_ms"] for row in data),
              "first_error_samples": [{key: row[key] for key in ("seq", "service", "status", "latency_ms")}
                                      for row in failures[:3]]}
    rendered = canonical(result) + "\n"
    assert len(data) == rows
    assert result["error_rows"] == (rows + 96) // 97
    assert sum(counts.values()) == len(failures)
    assert data[failures[-1]["seq"]] == failures[-1]
    raw_metrics, filtered_metrics = text_metrics(raw), text_metrics(rendered)
    return {"fixture_rows": rows, "fixture_sha256": hashlib.sha256(raw.encode()).hexdigest(),
            "raw": raw_metrics, "filtered": filtered_metrics,
            "estimated_reduction_percent": round(100 * (1 - filtered_metrics["estimated_tokens"] / raw_metrics["estimated_tokens"]), 4),
            "result": result,
            "scope": "Only returned text. Excludes prompts, code, tool schemas, provider overhead, reasoning, images, and cache accounting."
            }, raw, rendered


def compaction(root):
    entry = root / "dsh-compaction-bound" / "src" / "index.ts"
    summary = root / "dsh-compaction-bound" / "src" / "summary.ts"
    source = entry.read_text(encoding="utf-8")
    defaults = {}
    for field in ("retainTokens", "summaryChars", "userMessageChars", "userIndexChars"):
        match = re.search(r"^\s*" + field + r":.*?\.default\((\d+)\)", source, re.MULTILINE)
        if not match:
            raise ValueError("Cannot locate numeric schema default: " + field)
        defaults[field] = int(match[1])
    worker = Path(__file__).with_name("compaction-budget.mjs")
    completed = subprocess.run(["node", "--experimental-strip-types", str(worker), str(summary)],
                               input=canonical(defaults), text=True, capture_output=True, check=False, timeout=60)
    if completed.returncode:
        raise RuntimeError("Production compaction measurement failed:\n" + completed.stderr)
    result = json.loads(completed.stdout)
    result["defaults"] = defaults
    result["production_sources"] = {
        "schema": {"path": "dsh-compaction-bound/src/index.ts", "sha256": hashlib.sha256(entry.read_bytes()).hexdigest()},
        "summary": {"path": "dsh-compaction-bound/src/summary.ts", "sha256": hashlib.sha256(summary.read_bytes()).hexdigest()}}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[1],
                        help="Repository root containing dsh-compaction-bound; inferred by default")
    parser.add_argument("--rows", type=int, default=10000, help="Synthetic log records, 1 through 100000")
    parser.add_argument("--output", type=Path, help="Save the deterministic JSON report")
    parser.add_argument("--export-log", type=Path, help="Optionally save the exact generated fictional JSONL")
    parser.add_argument("--export-conclusion", type=Path, help="Optionally save the exact filtered text")
    parser.add_argument("--check", type=Path, help="Compare semantic results with an existing report")
    args = parser.parse_args()
    if not 1 <= args.rows <= 100000:
        parser.error("--rows must be between 1 and 100000")
    local, raw, conclusion = locality(args.rows)
    report = {"format_version": 1,
              "estimator": "ceil(UTF-16 code units / 4), separately per displayed text; not a model tokenizer",
              "paid_model_calls": 0, "network_calls": 0,
              "locality": local, "compaction": compaction(args.source_root.resolve())}
    if args.check and report != json.loads(args.check.read_text(encoding="utf-8")):
        raise SystemExit("Measured results differ from the reference report; review source hashes and values.")
    text = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    for path, value in ((args.output, text), (args.export_log, raw), (args.export_conclusion, conclusion)):
        if path:
            path.write_text(value, encoding="utf-8")
    print(text, end="")


if __name__ == "__main__":
    main()