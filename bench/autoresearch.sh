#!/usr/bin/env bash
# Autoresearch entrypoint: delegates to bench-feature.sh, which runs the
# "[WORKS]" marker feature round (feature-20260906-205955 task) — reader-master
# vs plain on identical StremioSportsStreams worktrees + shared conformance test.
# Usage: ./autoresearch.sh [--reuse]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec bash "$ROOT/bench-feature.sh" "${1:-}"
