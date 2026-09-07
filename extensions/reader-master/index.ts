/**
 * Reader-master extension for OMP.
 *
 * Deterministic bookkeeping only: persists state to
 * .reader-master/state.json, enforces progression gates, and exposes a
 * /reader-master command. All intelligence lives in the prompts. Two-role
 * model: the main session orchestrates AND implements; one persistent
 * mission-reader agent (read-only) handles codebase exploration so the main
 * session's token reads stay minimal.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	applyAction,
	emptyState,
	MissionError,
	type MissionAction,
	type MissionState,
} from "./state";

const STATE_PATH = ".reader-master/state.json";

const ORCHESTRATOR_BRIEF =
	`You are the orchestrator AND the implementer.\n\n` +
	`## Planning (reader_update TOOL — call it directly; never write to the state file or xd:// docs)\n` +
	`reader_update takes {"actions":[...]} — batch SEVERAL state actions per call whenever gates allow: set_contract + add_feature + start_executing in ONE call; complete_feature + complete_mission in ONE call.\n` +
	`2. set_contract: assertions (id, text) that together define "done" — observable behavior, not code shape.\n` +
`3. add_feature per feature; each covers >=1 assertion id. Decompose to the FEWEST features that cover the contract — a small task is exactly ONE feature. Each extra feature is a full serial implementation cycle.\n` +
	`4. start_executing after the user approves the plan (skip approval only if they pre-approved).\n\n` +
`## Research — route through your reader (RMAP protocol)\n` +
`Spawn exactly ONE mission-reader agent via the task tool (persistent; reuse it for the whole run by messaging its agent id via hub).\n` +
`REQUEST format: {"qs":["question 1","question 2"]} — batch ALL questions in one message; at most TWO reader messages per feature.\n` +
`REPLY format (mandatory): {"map":[{"id":"qs[0]","a":"answer","refs":[{"f":"path","l":[start,end],"d":"what it is","read":true}]}],"gaps":["..."]}. Consume it: ` +
`refs with "read":true are exactly what you open with offset/limit — never whole files. Refs are your only navigation; if a reply is not valid RMAP JSON, re-ask once citing the schema, then fall back to a range read around the cited file. NEVER grep/read/glob yourself except ranged reads of reader-cited files ` +
`and the immediate context of code you are editing. Your context is the scarce resource; the reader's is not.\n\n` +
	`## Execution (per feature, serially)\n` +
`2. Ask the reader anything you need, then implement YOURSELF (edit/write/bash). Keep diffs minimal.\n` +
`   The reader's answers cite file:line refs — use them: read each cited range with offset/limit (ref line ±40), NEVER whole files. Whole-file reads at your token prices are the expense this pipeline exists to avoid; go whole-file only when a range read proves insufficient or the file is smaller than a screen.\n` +
`   Bash is for BUILDING AND TESTING ONLY (run tests, typecheck, git commit). NEVER use bash for exploration — no ls, grep, find, cat, head — that is the reader's job.\n` +
	`3. Verify: build/tests/lint pass and the feature's assertions plausibly hold.\n` +
`4. complete_feature {id, summary} — tight summary: what changed, commands + exit codes, anything left undone.\n` +
`If a feature is not completable, fail_feature {id, issue} — this blocks until you resolve_issue.\n` +
`When the last feature is done, issue complete_feature + complete_mission in the SAME turn.`;

async function readState(cwd: string): Promise<MissionState | null> {
	const file = Bun.file(`${cwd}/${STATE_PATH}`);
	if (!(await file.exists())) return null;
	return (await file.json()) as MissionState;
}

async function writeState(cwd: string, state: MissionState): Promise<void> {
	await Bun.write(`${cwd}/${STATE_PATH}`, JSON.stringify(state, null, 2) + "\n");
}

function renderStatus(s: MissionState): string {
	const lines: string[] = [];
	lines.push(`Run: ${s.goal}`);
	lines.push(`Status: ${s.status}`);
	if (s.status === "planning") lines.push("(planning — define contract + features, then start_executing)");
	for (const f of s.features) {
		lines.push(`  ${f.status.padEnd(12)} ${f.id}  ${f.title}`);
	}
	if (!s.features.length) lines.push("\nNo features planned yet.");
	const open = s.issues.filter((i) => i.open);
	if (open.length) {
		lines.push(`\nOpen issues (${open.length}):`);
		for (const i of open) lines.push(`  ${i.id}: ${i.description}`);
	}
	const coverage = s.contract.map((a) => `${a.id}: ${a.text} <- [${a.coveredBy.join(", ") || "UNCOVERED"}]`);
	if (coverage.length) lines.push(`\nValidation contract:\n  ${coverage.join("\n  ")}`);
	return lines.join("\n");
}

export default function readerMasterExtension(pi: ExtensionAPI) {
	const z = pi.zod;

	pi.setLabel("Reader Master");

	pi.registerCommand("reader-master", {
		description: "Start or inspect a reader-master run (orchestrator session + read-only reader agent)",
		handler: async (args, ctx) => {
			const existing = await readState(ctx.cwd);
			const goal = args?.trim();
			if (!goal) {
				if (!existing) {
					ctx.ui.notify("No active run. Usage: /reader-master <goal>", "info");
					return;
				}
				ctx.ui.notify(renderStatus(existing), "info");
				return;
			}
			if (existing && existing.status !== "done") {
				ctx.ui.notify(
					`Run already active (${existing.status}): ${existing.goal}. Finish it or delete ${STATE_PATH} to start over.`,
					"warning",
				);
				return;
			}
			const state = emptyState(goal);
			await writeState(ctx.cwd, state);
			// The session itself is the orchestrator — brief it directly.
			pi.sendUserMessage(`Start a run. Goal: ${goal}\n\n${ORCHESTRATOR_BRIEF}`, {
				deliverAs: "nextTurn",
				triggerTurn: true,
			});
			ctx.ui.notify(`Run created: ${STATE_PATH}`, "info");
		},
	});

	pi.registerTool({
		name: "reader_update",
		label: "Reader Update",
		description:
			"Record progress on the active run (.reader-master/state.json). Call the tool DIRECTLY — never edit the state file. " +
			'Payload: {"actions":[...]} — batch SEVERAL actions in one call whenever gates allow (e.g. set_contract + add_feature + start_executing together; complete_feature + complete_mission together). Single-action examples: {"action":"set_contract","assertions":[{"id":"A1","text":"..."}]} | {"action":"add_feature","id":"F1","title":"...","assertions":["A1"]} | {"action":"start_feature","id":"F1"} | {"action":"complete_feature","id":"F1","summary":"..."} | {"action":"fail_feature","id":"F1","issue":"..."} | {"action":"resolve_issue","id":"issue-1"} | {"action":"start_executing"} | {"action":"complete_mission"}. ' +
			"Gates block invalid transitions - read the error and comply.",
		parameters: z.object({
			actions: z
				.array(
					z.object({
						action: z.enum([
							"set_contract", "add_feature", "start_feature", "complete_feature",
							"fail_feature", "resolve_issue", "start_executing", "complete_mission",
						]),
						assertions: z.array(z.union([z.string(), z.object({ id: z.string(), text: z.string() })])).optional(),
						id: z.string().optional(),
						title: z.string().optional(),
						summary: z.string().optional(),
						issue: z.string().optional(),
						goal: z.string().optional(),
					}),
				)
				.optional(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = await readState(ctx.cwd);
			if (!state) return { content: [{ type: "text", text: `No active run (${STATE_PATH} missing). Run /reader-master <goal>.` }] };
			// add_feature takes bare assertion ids; normalize object forms to their ids.
			const norm = (p: (typeof params.actions)[number]): (typeof params.actions)[number] =>
				p.action === "add_feature" && Array.isArray(p.assertions)
					? { ...p, assertions: p.assertions.map((a) => (typeof a === "string" ? a : a.id)) }
					: p;
			const list = params.actions?.length ? params.actions : [];
			if (!list.length) return { content: [{ type: "text", text: "BLOCKED: pass actions:[...]" }] };
			try {
				let next = state;
				for (const p of list) {
					next = applyAction(next, norm(p) as MissionAction);
				}
				await writeState(ctx.cwd, next);
				return { content: [{ type: "text", text: `OK (${list.length} action${list.length === 1 ? "" : "s"} applied; status: ${next.status})` }], details: { status: next.status } };
			} catch (err) {
				const msg = err instanceof MissionError ? err.message : String(err);
				return { content: [{ type: "text", text: `BLOCKED: ${msg}` }] };
			}
		},
	});

}
