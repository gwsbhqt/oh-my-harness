"""Offline pre-labeling with TypeSafe Jev (a yes/no-probability model).

Used by `label.py … --jev`: every item of a new batch is scored; confident
answers become labels, the rest (plus an audit sample of the confident ones)
go to the labelers. Measured 2026-09-23 against 1,506 labeled shapes:
AUC 0.89 (0.98 on high-confidence labels); p <= 0.30 agreed with "no" 98.8%
of the time, p >= 0.75 with "yes" 96.4%. ~670 input tokens per item at
$0.042 per million tokens: 1,500 items cost ~$0.04 and take ~95 s.

Never the only judge: precision is decided on `evaluate.py exact`, which says
how many of its labels came from Jev; the audit sample re-checks Jev each round.

Needs TYPESAFE_API_KEY.
"""

import concurrent.futures as cf
import json
import os
import time
import urllib.request

URL = "https://api.typesafe.ai/v1/systemone"
LOW, HIGH, AUDIT = 0.30, 0.75, 0.10

QUESTIONS = {
    "function": {
        "type": "noul",
        "instructions": "An AI agent works in a persistent Python kernel where functions survive across cells. The same code shape "
                        "(same structure, only literal values or local names differ) has now run again. Would telling the agent "
                        "'make this a function now and call it from here on' be a GOOD nudge?",
        "criteria": {
            "true": "The repeated part is real work logic — parsing/extracting/filtering results, checking conditions, a loop, or a "
                    "fixed multi-step procedure (run → parse → check; find → slice → show; wait → poll → test) — so a small function "
                    "taking the differing values as parameters would make later cells shorter or less error-prone. More repetitions "
                    "make this more justified.",
            "false": "The resemblance is only a wrapper and the substance is the differing content (different edit texts, scripts, "
                     "commands, queries or data literals); or it is trivial (print a value, one simple call, an import, a constant, an "
                     "attribute read) so a function saves nothing; or it is a deliberate re-run of the same check once or twice; or it "
                     "already calls a helper function.",
        },
    },
    "edit": {
        "type": "noul",
        "instructions": "An AI agent read a file's text, replaced literal substrings and wrote the file back, by hand in Python, for the "
                        "second time. The kernel has an edit tool that replaces literal text in an existing file and takes several "
                        "changes per call. Is advising the agent to use that edit tool appropriate here?",
        "criteria": {
            "true": "This is editing existing file content by literal replacement, which the edit tool can do (even many replacements).",
            "false": "The edit tool would not fit: it regenerates the whole file from computed content, replaces by regex or computed "
                     "patterns, edits a binary or generated temp file, writes a different file than it read, or is not a file edit.",
        },
    },
}


def _clip(text, n=1400):
    text = text or ""
    return text if len(text) <= n else text[:n] + "\n…(truncated)"


def _ask(key, note, shape):
    body = json.dumps({"model": "jev-latest", "questions": {"q": QUESTIONS[note]}, "state": {
        "first_occurrence": _clip(shape["first"]), "second_occurrence": _clip(shape["second"]),
        "times_run_in_session": shape["total"]}}).encode()
    request = urllib.request.Request(URL, data=body, headers={"authorization": f"Bearer {key}", "content-type": "application/json"})
    error = None
    for attempt in range(3):
        try:
            reply = json.loads(urllib.request.urlopen(request, timeout=30).read())
            return {"p": reply["answers"]["q"]["noul"], "tokens": reply.get("usage", {}).get("input_tokens", 0)}
        except Exception as exc:  # noqa: BLE001 — reported per item, never guessed
            error = str(exc)
            time.sleep(1 + attempt)
    return {"error": error}


def score(note, shapes, workers=6):
    """[shape] → [{"p", "tokens"} | {"error"}], same order."""
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        raise SystemExit("jev: TYPESAFE_API_KEY is not set")
    with cf.ThreadPoolExecutor(workers) as pool:
        return list(pool.map(lambda s: _ask(key, note, s), shapes))


def triage(items, scores, rng):
    """Split into (auto-labels, ids to review). Unscored items and an audit
    sample of the confident ones are reviewed; nothing is guessed."""
    auto, review = [], []
    for item, s in zip(items, scores):
        p = s.get("p")
        confident = p is not None and (p <= LOW or p >= HIGH)
        if confident and rng.random() >= AUDIT:
            auto.append({"id": item["id"], "label": "yes" if p >= HIGH else "no", "confidence": "jev", "p": round(p, 4)})
        else:
            review.append(item["id"])
    return auto, review
