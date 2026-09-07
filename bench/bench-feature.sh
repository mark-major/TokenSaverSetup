#!/usr/bin/env bash
# Feature benchmark: reader-master pipeline vs plain session implementing one
# feature in ~/git/StremioSportsStreams, each arm in its own git worktree.
# Usage: ./bench-feature.sh [--reuse]
#   default: fresh worktrees + both sessions, then token metrics
#   --reuse: skip model runs, parse the latest existing round
#
# Selectors (env overrides): ORCH_MODEL, READER_MODEL, ROUND_TIMEOUT (seconds)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$HOME/git/StremioSportsStreams"
ORCH_MODEL="${ORCH_MODEL:-zai/glm-5.3-flash:high}"
READER_MODEL="${READER_MODEL:-opencode-go/mimo-v2.5}"
export ORCH_MODEL READER_MODEL
ROUND_TIMEOUT="${ROUND_TIMEOUT:-2400}"
export ROUND_TIMEOUT
export ROUND_START
ROUND_ID="$(date +%Y%m%d-%H%M%S)"
READER_WT="$ROOT/runs/feature-$ROUND_ID-reader"
PLAIN_WT="$ROOT/runs/feature-$ROUND_ID-plain"
if [ "${1:-}" = "--reuse" ]; then
  READER_WT="$(ls -d "$ROOT"/runs/feature-*-reader 2>/dev/null | sort | tail -1)"
  PLAIN_WT="$(ls -d "$ROOT"/runs/feature-*-plain 2>/dev/null | sort | tail -1)"
fi
FEATURE="$(cat <<'FEATURE_EOF'
This task has THREE features. Implement all three; one feature per conformance test, each committed separately with a clear message.

Feature 1 - failed-extraction cooldown: when provider.extractStream fails (returns null) for a contentId, remember it in memory; for EXTRACTION_COOLDOWN_MS after the failure, subsequent stream requests for that contentId return no streams WITHOUT calling that provider extractStream again. After expiry, retry normally. Successful extractions keep working as today. Anchor: export const EXTRACTION_COOLDOWN_MS = 5 * 60 * 1000 from src/config/constants.ts. Conformance: src/tests/streaming/extraction-cooldown.test.ts (present; do not edit).

Feature 2 - [WORKS] marker: events whose stream extraction succeeded display their name with a "[WORKS] " prefix (composed before any existing "[LIVE] " prefix) in catalog and meta responses; the success mark is cached in memory for 10 minutes with lazy expiry. Anchor: export const WORKS_TTL_MS = 10 * 60 * 1000 from src/config/constants.ts. Conformance: src/tests/streaming/works-marker.test.ts (present; do not edit).

Feature 3 - archive catalog: events whose endTime plus EVENT_EXPIRY_BUFFER_S has passed leave their regular catalogs and appear under the archive catalog id; events still inside the buffer stay put. You will likely need a way to list all events across providers - extend the repo surfaces as needed. Anchor: export const ARCHIVE_CATALOG_ID = "archive" from src/config/constants.ts. Conformance: src/tests/streaming/archive-catalog.test.ts (present; do not edit).

All three specs are behavior-level: you research the codebase and decide where and how, following existing repo patterns.
Acceptance: all three conformance tests pass unmodified and bunx tsc --noEmit is clean. Run targeted tests for modules you touched; do NOT run the full suite (bun test src/) and commit with git commit --no-verify — the bench verifies the conformance suites itself.
Non-goals: no persisted storage, no expiry sweeper, no new config knobs beyond the named anchors, no unrelated refactors.
FEATURE_EOF
)"

rt() { perl -e 'alarm shift; exec @ARGV' "$@"; }  # portable timeout (run env has no coreutils timeout)

EXT="$HOME/.omp/agent/extensions/reader-master/index.ts"
BRIEF="$(bun -e 'const t=await Bun.file(process.argv[1]).text(); const m=t.match(/const ORCHESTRATOR_BRIEF =([\s\S]*?);\r?\n/); if(!m){console.error("ORCHESTRATOR_BRIEF not found");process.exit(1)} console.log(eval("("+m[1]+")"));' "$EXT")"
if [ "${1:-}" != "--reuse" ]; then
  HEAD_REV="$(git -C "$REPO" rev-parse HEAD)"
  make_wt() { # $1 = target dir, $2 = branch
    git -C "$REPO" worktree prune
    git -C "$REPO" worktree add -b "$2" "$1" "$HEAD_REV" >/dev/null
    for t in extraction-cooldown works-marker archive-catalog; do
      cp "$ROOT/conformance/$t.test.ts" "$1/src/tests/streaming/$t.test.ts"
    done
    (cd "$1" && bun install --frozen-lockfile >/dev/null 2>&1) || true
  }

  echo "[harness] worktrees at $HEAD_REV" >&2
  make_wt "$READER_WT" "bench/reader-$ROUND_ID"
  make_wt "$PLAIN_WT" "bench/plain-$ROUND_ID"

  echo "[harness] reader-master session starting..." >&2
  (
    mkdir -p "$READER_WT/.reader-master"
    NOW=$(date -u +%FT%TZ)
    export READER_WT FEATURE NOW
    python3 -c 'import json,os; s={"goal":os.environ["FEATURE"],"status":"planning","contract":[],"features":[],"issues":[],"createdAt":os.environ["NOW"],"updatedAt":os.environ["NOW"]}; open(os.path.join(os.environ["READER_WT"],".reader-master","state.json"),"w").write(json.dumps(s,indent=2)+"\n")'
    cd "$READER_WT"
    rt "$ROUND_TIMEOUT" omp --model "$ORCH_MODEL" -p "Start a run. Goal: $FEATURE

$BRIEF" > /dev/null 2>&1
  ) &
  READER_PID=$!
  READER_START=$(date +%s)

  echo "[harness] plain session starting..." >&2
  PLAIN_START=$(date +%s)
  ( cd "$PLAIN_WT" && rt "$ROUND_TIMEOUT" omp --model "$ORCH_MODEL" -p "$FEATURE" > /dev/null 2>&1 ) || true
  PLAIN_END=$(date +%s)
  echo "[harness] plain done" >&2
  wait $READER_PID || true  # reader-master may hit ROUND_TIMEOUT; still record wall time
  READER_END=$(date +%s)
  echo "[harness] reader done" >&2
  {
    echo "ASI plain_seconds=$((PLAIN_END - PLAIN_START))"
    echo "ASI reader_seconds=$((READER_END - READER_START))"
  } > "$ROOT/runs/timing.env"
fi

python3 - "$READER_WT" "$PLAIN_WT" <<'PY'
import json, os, sys
from pathlib import Path

sess_root = Path.home() / ".omp/agent/sessions"

def folder_for(wt: str) -> str:
    resolved = Path(wt).resolve()
    return "-" + str(resolved.relative_to(Path.home())).replace("/", "-")

def latest_tops(folder: str):
    d = sess_root / folder
    if not d.is_dir():
        return []
    start = int(os.environ.get("ROUND_START", 0))
    tops = sorted(p.with_suffix("") for p in d.glob("*.jsonl") if int(p.stat().st_mtime) >= start)
    if not tops:
        tops = sorted(p.with_suffix("") for p in d.glob("*.jsonl"))
    return tops[-1:]

def parse(sessdir):
    roles = {}
    def usage(path):
        t = {"calls": 0, "cost": 0.0, "tot": 0, "in": 0}
        for line in open(path, encoding="utf-8"):
            try:
                u = (json.loads(line).get("message") or {}).get("usage")
            except json.JSONDecodeError:
                continue
            if u:
                t["calls"] += 1
                t["cost"] += (u.get("cost") or {}).get("total") or 0.0
                t["tot"] += u.get("totalTokens") or 0
                t["in"] += u.get("input") or 0
        return t
    main = sessdir.with_suffix(".jsonl")
    if main.exists():
        roles["main"] = usage(main)
    for p in sorted(sessdir.rglob("*.jsonl")):
        roles[str(p.relative_to(sessdir)).removesuffix(".jsonl")] = usage(p)
    return roles

reader_wt, plain_wt = sys.argv[1], sys.argv[2]
rt_, pt = latest_tops(folder_for(reader_wt)), latest_tops(folder_for(plain_wt))
if not rt_ or not pt:
    sys.stderr.write("missing session data\n")
    sys.exit(1)
r, p = parse(rt_[0]), parse(pt[0])

orch_cost = r["main"]["cost"]
orch_tok = r["main"]["tot"]
reader = {k: v for k, v in r.items() if k != "main"}

print(f"METRIC orchestrator_cost_usd={orch_cost:.4f}")
print(f"METRIC reader_cost_usd={sum(v['cost'] for v in reader.values()):.4f}")
print(f"METRIC reader_tokens={sum(v['tot'] for v in reader.values())}")
print(f"METRIC mission_total_cost_usd={sum(v['cost'] for v in r.values()):.4f}")
print(f"METRIC plain_cost_usd={p['main']['cost']:.4f}")
print(f"METRIC orchestrator_tokens={orch_tok}")
print(f"METRIC orchestrator_input_tokens={r['main']['in']}")
print(f"METRIC plain_tokens={p['main']['tot']}")
print(f"METRIC plain_input_tokens={p['main']['in']}")
print(f"ASI orchestrator_calls={r['main']['calls']}")
print(f"ASI reader_calls={sum(v['calls'] for v in reader.values())}")
print(f"ASI plain_calls={p['main']['calls']}")
PY
[ -f "$ROOT/runs/timing.env" ] && cat "$ROOT/runs/timing.env"
