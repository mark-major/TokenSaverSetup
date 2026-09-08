# TokenSaverSetup

An [Oh My Pi](https://github.com/oh-my-pi/pi-coding-agent) extension + agent setup that
reduced the **main agent's token usage by 2–3× versus a plain session** in controlled
A/B benchmarks, using a read-only "reader" agent as a context firewall.

## How it works

Two roles:

- **Main session** — orchestrates AND implements (edit/write/bash). It never explores.
  All codebase research goes through one tool call: `ask_reader {"qs": ["...", "..."]}`.
- **Reader** (`mission-reader`, read-only) — does ALL exploration (grep/glob/read/lsp/ast)
  and answers via the **RMAP** JSON protocol:

```jsonc
// reader → main (every reply, no prose outside the JSON)
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

Every claim is schema-enforced to a file + verified line range. `read: true` marks exactly
the ranges main opens with `offset`/`limit` — never whole-file reads at main's token prices.

The extension is deliberately **thin**: no state files, no feature tracking, no gates.
The extension owns the reader process (a persistent headless `omp` session), validates the
RMAP replies mechanically (one schema re-ask on malformed JSON), and hands main a compact
`{"map": [...], "gaps": [...]}` payload. Main never composes reader prompts or parses
protocol by hand — its injected brief is ~0.9 KB.

Measured over 9 benchmark rounds: main median **2.77M tokens vs 4.05M+ plain**
(16–70% fewer per round), with a 9/9 clean-completion record. Reader-side usage
(~400–800k tokens/round on a cheap model) is invisible to main's context.

## Install

Requires: [Oh My Pi](https://github.com/oh-my-pi/pi-coding-agent) (`omp`) with Bun.

### Option A — user-level extension (recommended)

```bash
git clone https://github.com/mark-major/TokenSaverSetup.git
mkdir -p ~/.omp/agent/extensions
ln -s "$(pwd)/TokenSaverSetup/extensions/reader-master" ~/.omp/agent/extensions/reader-master
cp TokenSaverSetup/agents/mission-reader.md ~/.omp/agent/agents/mission-reader.md
```

The `package.json` manifest (`"omp": {"extensions": ["./index.ts"]}`) makes the directory
a proper OMP extension package; OMP auto-discovers everything under
`~/.omp/agent/extensions/` at startup.

### Option B — config-registered path

```bash
git clone https://github.com/mark-major/TokenSaverSetup.git ~/TokenSaverSetup
```

Then in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/TokenSaverSetup/extensions/reader-master
```

### Optional: reader model

The reader defaults to `zai/glm-4.5-air` (cheap, fast). Override per session:

```bash
RMASTER_READER_MODEL=<provider/model> omp
```

### Verify

Start `omp` in any repo and check that the `ask_reader` tool exists and the
`/reader-master` slash command is listed. Then:

```
> /reader-master <your goal>
```

The session implements the goal itself, routing every research question through
`ask_reader` and committing each unit of work separately.

## Benchmark

`bench/` contains the A/B harness (`bench-feature.sh`, `autoresearch.sh`) used to measure
main-vs-plain token usage on real workloads: identical git worktrees, identical behavior-level
specs, 16 shipped conformance tests, token totals parsed from the session transcripts.
See [EXPERIMENT.md](EXPERIMENT.md) for methodology and round-by-round results.

## Files

- `extensions/reader-master/` — the OMP extension (tool + brief)
- `agents/mission-reader.md` — the read-only reader agent definition
- `bench/` — A/B benchmark harness + conformance suites
