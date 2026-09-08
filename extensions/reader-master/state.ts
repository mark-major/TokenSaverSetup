/**
 * Mission state machine for the reader-master extension.
 *
 * States: planning → executing → done
 * Features: todo → in_progress → done | failed
 * Issues: open | resolved
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MissionAssertion {
	id: string;
	text: string;
}

export interface MissionFeature {
	id: string;
	title: string;
	status: "todo" | "in_progress" | "done" | "failed";
	assertions: string[];
}

export interface MissionIssue {
	id: string;
	description: string;
	open: boolean;
}

export interface MissionState {
	goal: string;
	status: "planning" | "executing" | "done";
	contract: MissionAssertion[];
	features: MissionFeature[];
	issues: MissionIssue[];
}

// ---------------------------------------------------------------------------
// Action union — matches the z.enum in index.ts
// ---------------------------------------------------------------------------

export type MissionAction =
	| { action: "set_contract"; assertions: (string | MissionAssertion)[] }
	| { action: "add_feature"; id: string; title: string; assertions: string[] }
	| { action: "start_feature"; id: string }
	| { action: "complete_feature"; id: string; summary: string }
	| { action: "fail_feature"; id: string; issue: string }
	| { action: "resolve_issue"; id: string }
	| { action: "start_executing" }
	| { action: "complete_mission" };

// ---------------------------------------------------------------------------
// Error class — gates throw this so index.ts can surface a clean message
// ---------------------------------------------------------------------------

export class MissionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MissionError";
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function emptyState(goal: string): MissionState {
	return {
		goal,
		status: "planning",
		contract: [],
		features: [],
		issues: [],
	};
}

// ---------------------------------------------------------------------------
// State machine — applies one action, throws MissionError on invalid transition
// ---------------------------------------------------------------------------

export function applyAction(state: MissionState, action: MissionAction): MissionState {
	const clone = {
		...state,
		contract: [...state.contract],
		features: state.features.map((f) => ({ ...f, assertions: [...f.assertions] })),
		issues: [...state.issues],
	};

	switch (action.action) {
		// ---- planning gates ----

		case "set_contract": {
			if (state.status !== "planning")
				throw new MissionError("set_contract requires status=planning");
			clone.contract = action.assertions.map((a) =>
				typeof a === "string" ? { id: a, text: a } : a,
			);
			break;
		}

		case "add_feature": {
			if (state.status !== "planning")
				throw new MissionError("add_feature requires status=planning");
			if (clone.features.some((f) => f.id === action.id))
				throw new MissionError(`Feature ${action.id} already exists`);
			clone.features.push({
				id: action.id,
				title: action.title,
				status: "todo",
				assertions: action.assertions,
			});
			break;
		}

		case "start_executing": {
			if (state.status !== "planning")
				throw new MissionError("start_executing requires status=planning");
			if (!clone.contract.length)
				throw new MissionError("Cannot start_executing: contract is empty");
			if (!clone.features.length)
				throw new MissionError("Cannot start_executing: no features defined");
			// Check all features have at least one assertion
			const uncovered = clone.features.filter((f) => !f.assertions.length);
			if (uncovered.length)
				throw new MissionError(
					`Cannot start_executing: features ${uncovered.map((f) => f.id).join(", ")} have no assertions`,
				);
			clone.status = "executing";
			break;
		}

		// ---- executing gates ----

		case "start_feature": {
			if (state.status !== "executing")
				throw new MissionError("start_feature requires status=executing");
			const feature = clone.features.find((f) => f.id === action.id);
			if (!feature) throw new MissionError(`Feature ${action.id} not found`);
			if (feature.status !== "todo")
				throw new MissionError(`Feature ${action.id} is already ${feature.status}`);
			feature.status = "in_progress";
			break;
		}

		case "complete_feature": {
			if (state.status !== "executing")
				throw new MissionError("complete_feature requires status=executing");
			const feature = clone.features.find((f) => f.id === action.id);
			if (!feature) throw new MissionError(`Feature ${action.id} not found`);
			if (feature.status !== "in_progress")
				throw new MissionError(`Feature ${action.id} is not in_progress (is ${feature.status})`);
			feature.status = "done";
			break;
		}

		case "fail_feature": {
			if (state.status !== "executing")
				throw new MissionError("fail_feature requires status=executing");
			const feature = clone.features.find((f) => f.id === action.id);
			if (!feature) throw new MissionError(`Feature ${action.id} not found`);
			if (feature.status !== "in_progress" && feature.status !== "todo")
				throw new MissionError(`Feature ${action.id} cannot be failed from status ${feature.status}`);
			feature.status = "failed";
			clone.issues.push({
				id: action.issue,
				description: action.issue,
				open: true,
			});
			break;
		}

		case "resolve_issue": {
			const issue = clone.issues.find((i) => i.id === action.id);
			if (!issue) throw new MissionError(`Issue ${action.id} not found`);
			if (!issue.open) throw new MissionError(`Issue ${action.id} is already resolved`);
			issue.open = false;
			break;
		}

		case "complete_mission": {
			if (state.status !== "executing")
				throw new MissionError("complete_mission requires status=executing");
			const unfinished = clone.features.filter((f) => f.status !== "done");
			if (unfinished.length)
				throw new MissionError(
					`Cannot complete_mission: ${unfinished.map((f) => f.id).join(", ")} not done`,
				);
			const openIssues = clone.issues.filter((i) => i.open);
			if (openIssues.length)
				throw new MissionError(
					`Cannot complete_mission: ${openIssues.map((i) => i.id).join(", ")} still open`,
				);
			clone.status = "done";
			break;
		}

		default:
			// Exhaustive-check helper — should never reach here with valid action
			const _exhaustive: never = action;
			throw new MissionError(`Unknown action: ${_exhaustive}`);
	}

	return clone;
}
