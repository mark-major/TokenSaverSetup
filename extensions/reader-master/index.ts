/**
 * Reader-master extension for OMP.
 *
 * The main session asks research questions via the `ask_reader` tool; this
 * extension owns everything else: it spawns a persistent headless reader
 * process (`omp -p --continue` in a private session dir), enforces the RMAP
 * reply protocol mechanically (parse + one schema re-ask on invalid JSON),
 * and streams answers back per question as they land. Main never composes
 * reader prompts or parses protocol by hand.
 */
export const ORCHESTRATOR_BRIEF =
	`You are the orchestrator AND the implementer.\n\n` +
	`## Work\n` +
	`Read the goal/spec. Identify its units of work; implement them SERIALLY — implement, verify (build/tests), git commit with a clear message, then move to the next unit. Keep diffs minimal. Finish when every unit is committed and all tests pass.\n\n` +
	`## Research\n` +
	`Route ALL codebase research through the ask_reader tool: {"qs":[...]} — batch your questions, one call per unit of work. Its answers cite verified file:line refs; open each read:true ref with offset/limit (ref line ±40), NEVER whole files. NEVER grep/glob/read for exploration yourself except ranged reads of reader-cited files and the immediate context of code you are editing. Your context is the scarce resource; the reader's is not.\n` +
	`Bash is for BUILDING AND TESTING ONLY (run tests, typecheck, git commit). NEVER use bash for exploration — no ls, grep, find, cat, head.`;
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const READER_MODEL = process.env.RMASTER_READER_MODEL ?? "zai/glm-4.5-air";
const READER_TOOLS = "read,grep,glob,lsp,ast_grep";

const READER_RULES =
	`You are a read-only codebase research agent. Answer the orchestrator's questions.\n` +
	`Your ENTIRE final output must be ONE JSON object, no prose outside it:\n` +
	`{"map":[{"id":"qs[0]","a":"<=12 word answer","refs":[{"f":"path","l":[start,end],"d":"<=12 words","read":true}]}],"gaps":["..."]}\n` +
	`Schema: "a" = answer in at most 12 words. "refs" = array of {"f": repo-relative path, "l": [start,end] line range you VERIFIED with a read/grep call in this session, "d": what the range is in <=12 words, "read": true only for ranges the orchestrator must open before editing (edit site + ~10 context lines, max 6 per reply)}. "gaps" = one line per unverifiable point.\n` +
	`Rules: every claim needs a verified ref; no verified range = put it in gaps, do not guess. id echoes the question ("qs[0]"). JSON only, no markdown fences, no text before or after. You are read-only: refuse write requests in gaps.`;

export default function readerMasterExtension(pi: ExtensionAPI) {
	pi.setLabel("Reader Master");

	// Reader session state (per run).
	let sessionDir: string | null = null;

	async function runReader(question: string, cont: boolean, cwd: string, signal?: AbortSignal) {
		const args = [
			"-p", "--mode", "json", "--no-title", "--no-extensions",
			"--model", READER_MODEL, "--tools", READER_TOOLS,
			"--approval-mode", "yolo", "--max-time", "300",
			"--append-system-prompt", READER_RULES,
			"--session-dir", sessionDir!,
		];
		if (cont) args.push("--continue");
		args.push(question);
		const res = await pi.exec("omp", args, { signal, cwd });
		if (res.killed) throw new Error("reader cancelled");
		if (res.code !== 0) throw new Error(`reader failed: ${(res.stderr || "").slice(-300)}`);
		// Pull the final assistant text out of the json event stream.
		let text = "";
		for (const line of res.stdout.split("\n")) {
			if (!line.startsWith("{")) continue;
			try {
				const ev = JSON.parse(line);
				const msg = ev?.message ?? ev;
				if ((ev.type === "message_end" || ev.type === "message_update") && msg?.role === "assistant") {
					for (const b of msg.content ?? []) {
						if (b.type === "text" && b.text) text = b.text;
					}
				}
			} catch {}
		}
		return text.trim();
	}

	pi.registerTool({
		name: "ask_reader",
		label: "Ask Reader",
		description:
			"Ask your read-only research agent questions about the codebase. Pass all questions at once: {\"qs\":[\"...\",\"...\"]}. " +
			"Answers arrive as verified RMAP refs {f: path, l: [start,end], read} — open each read:true ref with offset/limit (±40 lines), never whole files. " +
			"NEVER grep/glob/read for exploration yourself; all research routes through this tool. Batch questions; one call per unit of work.",
		parameters: pi.zod.object({
			qs: pi.zod.array(pi.zod.string()).min(1).describe("Research questions, plain text"),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!sessionDir) {
				sessionDir = `${process.env.HOME}/.omp/reader-sessions/${Date.now().toString(36)}`;
				await pi.exec("mkdir", ["-p", sessionDir], {});
			}
			const maps: unknown[] = [];
			const gaps: string[] = [];
			for (let i = 0; i < params.qs.length; i++) {
				const q = JSON.stringify({ qs: [params.qs[i]] });
				let reply = await runReader(q, maps.length > 0, ctx.cwd, signal);
				let parsed: any = null;
				try {
					parsed = JSON.parse(reply.replace(/^```(?:json)?|```$/g, "").trim());
				} catch {}
				if (!parsed || !Array.isArray(parsed.map)) {
					// One mechanical schema re-ask, then fall back to raw text.
					reply = await runReader(q + "\nYour previous reply was not valid RMAP JSON. Reply with ONLY the JSON object per the schema.", true, ctx.cwd, signal);
					try { parsed = JSON.parse(reply.replace(/^```(?:json)?|```$/g, "").trim()); } catch {}
				}
				if (parsed && Array.isArray(parsed.map)) {
					for (const m of parsed.map) maps.push(m);
					for (const g of parsed.gaps ?? []) gaps.push(String(g));
				} else {
					maps.push({ id: `qs[${i}]`, a: reply.slice(0, 400), refs: [] });
					gaps.push(`qs[${i}]: reader did not produce valid RMAP JSON`);
				}
				// Stream progress: answers land one question at a time.
				onUpdate?.({
					content: [{ type: "text", text: `reader answered ${i + 1}/${params.qs.length}` }],
					details: { answered: i + 1, of: params.qs.length, last: maps[maps.length - 1] },
				});
			}
			const payload = JSON.stringify({ map: maps, gaps });
			return {
				content: [{ type: "text", text: payload }],
				details: { answers: maps.length, gaps: gaps.length },
			};
		},
	});

	pi.registerCommand("reader-master", {
		description: "Brief this session as a reader-master run (ask_reader tool handles all research)",
		handler: async (args, ctx) => {
			const goal = args?.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /reader-master <goal>", "info");
				return;
			}
			pi.sendUserMessage(`Start a run. Goal: ${goal}\n\n${ORCHESTRATOR_BRIEF}`, {
				deliverAs: "nextTurn",
				triggerTurn: true,
			});
		},
	});
}
