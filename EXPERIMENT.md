# Experiment log — token usage: reader-master vs plain

Benchmark: three-feature workload on StremioSportsStreams (TypeScript/Bun addon).
Both arms get identical worktrees at the same HEAD, identical behavior-level specs,
and 16 shipped conformance tests (they may not edit them). Metric: MAIN session total
tokens per round (lower is better). Segment 5, 2026-09-06/07.

## Adopted config

1. `reader_update` batched actions (`{"actions":[...]}`) — one call for
   set_contract+add_feature+start_executing; one for complete_feature+complete_mission.
2. Terse one-line state acks; full status on demand (`reader_status`).
3. FEWEST-features decomposition.
4. RMAP v1 JSON handoff (see README), replies ≤80 lines, max 2 reader messages/feature.
5. Reader spawn mandatory (it is a context firewall, see rejected #3).
6. Reader model: glm-4.5-air with refs-only schema (a/d fields ≤12 words).

## Round results (main total tokens; plain total tokens)

mimo-v2.5 reader era (7 rounds): 4.39M/5.75M, 3.18M/3.34M, 2.96M/3.77M, 1.95M/6.24M†,
2.29M/3.42M, 3.24M/2.88M, 1.90M/6.17M† — median 2.96M vs 3.77M; ratio median 0.76.
All 7 reader rounds: 3 commits + 16/16 tests green. † = plain thrashed past deadline
with features uncommitted (its 6M+ token rounds correlate with the thrash).

glm-4.5-air reader era (refs-only schema): 1.52M/4.67M, 3.73M/4.09M — both all-green.

Best single round: 1.52M main tokens (air, refs-only) — 27% below the mimo-era best,
with fresh input 77k vs plain 101k.

## Rejected approaches (each reverted; run-level evidence in session log)

1. Fat reader replies (freeform prose up to 120 lines): +48% main fresh input — every
   reader line is re-read by main on every later turn.
2. Implement-while-reader-maps: no measurable gain.
3. Reader exploration budget (~10 tool calls/batch): flat on primary metric; savings
   did not reproduce across 3 rounds.
4. Conditional reader spawn (skip reader on fully-specified goals): main explored at
   main prices — tokens up 53%. The reader is a firewall, not just a researcher.
5. Questions-in-spawn-prompt (skip the ask round-trip): worst round of the segment.
6. Blocking exploration firewall (wrap grep/glob to BLOCK, redirect to reader):
   converted blocked calls into 26+ reader round-trips; reader tokens 4x.
7. READ tool re-registration (for read-truncation): broke session startup in 5/6
   rounds — never wrap the built-in read in this extension API.
8. Reader message budget 3 messages: flat.
