# TokenSaverSetup

An [Oh My Pi](https://github.com/oh-my-pi/pi-coding-agent) extension + agent setup that
reduces the **main agent's token usage** by 2-3x versus a plain session, using a
read-only "reader" agent as a context firewall.

## Architecture (two roles)

- **Main (orchestrator + implementer)**: plans via `reader_update`, implements itself,
  never explores. Its context is the scarce resource.
- **Reader** (`mission-reader`, read-only): does ALL exploration (grep/glob/read/lsp),
  answers via the **RMAP v1** JSON protocol.

### RMAP v1 handoff protocol

```jsonc
// main → reader
{"qs": ["how does the extraction flow work?", "where do failures return?"]}

// reader → main
{
  "map": [
    {
      "id": "qs[0]",
      "a": "answer in at most 12 words",
      "refs": [
        {"f": "src/streaming/module.ts", "l": [42, 99], "d": "failure path", "read": true}
      ]
    }
  ],
  "gaps": ["what could not be verified"]
}
```

Every claim is schema-enforced to a file + line range. `read: true` marks exactly the
ranges main opens with `offset`/`limit` — no whole-file reads at main's token prices.
No prose outside the JSON.

### Other structural pieces

- `reader_update` accepts batched actions: `{"actions":[set_contract, add_feature,
  start_executing]}` in ONE call (each call is a full context re-read — batching cut
  orchestrator total tokens ~3x).
- Terse one-line state acks (full status only on demand via `reader_status`).
- FEWEST-features decomposition; max 2 reader messages per feature; replies capped
  (~80 lines, `a`/`d` fields ≤12 words — see "weak model" note below).

## Benchmark outcome

Three-feature workload on a real TypeScript codebase (StremioSportsStreams):
failed-extraction cooldown + [WORKS] success marker + archive catalog. Behavior-level
specs; 16 conformance tests shipped identically to both arms; both arms judged only by
the conformance suites (main total tokens per round, lower is better):

| config | main tokens (median) | plain tokens (median) | all-green completions |
|---|---|---|---|
| reader-master (RMAP + mimo-v2.5 reader) | **2.96M** (best 1.90M) | 3.77M | 7/7 |
| reader-master (RMAP + glm-4.5-air reader, refs-only schema) | **1.52M–3.73M** | 4.09M–6.24M | 2/2 |
| plain session | 3.34M–6.24M (worst case explodes, misses deadline) | — | 5/7 |

Key findings:

1. **Main uses 1.5–3.2x fewer total tokens than plain** on multi-feature work; plain's
   bad rounds thrash past the deadline with features uncommitted, while reader-master's
   worst case stays bounded and always finishes.
2. **The reader is a context firewall, not just a researcher**: removing it (letting
   main explore) *increased* main's tokens 2.7x — exploration belongs in the cheap agent.
3. **Weak readers need constrained schemas**: glm-4.5-air with freeform-ish RMAP replies
   cost 2.7x main tokens; capping prose fields (paths + numbers only) restored
   best-of-session results (1.52M).
4. Batched state actions cut orchestrator volume ~3x; every tool call re-reads context.

Full dead-lever log (8 approaches tested and rejected with run-level evidence) is in
`EXPERIMENT.md`.

## Layout

```
extensions/reader-master/index.ts   the omp extension (tools: reader_update/reader_status,
                                    /reader-master command, ORCHESTRATOR_BRIEF — single
                                    source of truth, extracted by the bench at runtime)
agents/mission-reader.md            read-only reader agent (model-pinned; RMAP protocol)
bench/bench-feature.sh              round driver: identical worktrees + conformance tests,
                                    both arms, METRIC parsing
bench/conformance/*.test.ts         the three feature conformance suites (16 tests)
```

## Install

```bash
# extension
mkdir -p ~/.omp/agent/extensions && cp -r extensions/reader-master ~/.omp/agent/extensions/
# reader agent (edit model: to your reader of choice)
mkdir -p ~/.omp/agent/agents && cp agents/mission-reader.md ~/.omp/agent/agents/
# in the target project
omp
/reader-master <goal>
```

## Benchmark

`bench/bench-feature.sh` clones two worktrees of the target repo, ships the conformance
tests, runs reader-master vs a plain session with identical specs, and prints token/
cost metrics. Requires `omp`, `bun`, and `gh`-authenticated git.
