/**
 * The HARDcode verification gate. Runs at agent_before_settle: decides whether
 * the work is verified, or sends the agent back (fix failures, run checks,
 * address review findings, audit edge cases, report evidence), within limits.
 *
 * Side effects are injected so the decision logic is testable on its own.
 */

import { type CheckRun, failureSignature } from "./checks.ts";
import type { HardcodeConfig } from "./config.ts";
import {
	EVIDENCE_REPORT_MESSAGE,
	failedChecksMessage,
	giveUpMessage,
	missingVerificationMessage,
	reviewMessage,
	SELF_AUDIT_MESSAGE,
} from "./policy.ts";
import type { ReviewResult } from "./reviewer.ts";

export interface Verification extends CheckRun {
	trustworthy: boolean;
	source: "agent" | "auto";
	/** Working-tree fingerprint right after the check ran (git), else undefined. */
	fp?: string;
	/** Tool-result sequence number when the check ran (used outside git). */
	seq: number;
}

/** State for one task: from a user prompt until the next one. */
export class Cycle {
	task: string;
	startFp?: string;
	seq = 0;
	lastEditSeq = -1;
	toolEdits = 0;
	/** Changes made outside this session's tool calls (e.g. UltraCode workflow agents). */
	external = false;
	verifications: Verification[] = [];
	continuations = 0;
	fixAttempts = 0;
	verifyNudges = 0;
	reviewRounds = 0;
	audited = false;
	evidenceAsked = false;
	gaveUp = false;
	giveUpReason?: string;
	lastFailureSig?: string;
	sameFailureCount = 0;
	autoRanKey?: string;
	reviewedKey?: string;
	lastReview?: ReviewResult;

	constructor(task: string, startFp?: string) {
		this.task = task;
		this.startFp = startFp;
	}

	/** New work arrived (e.g. a workflow finished): give the verification cycle a fresh budget. */
	resetBudget(): void {
		this.continuations = 0;
		this.fixAttempts = 0;
		this.verifyNudges = 0;
		this.sameFailureCount = 0;
		this.lastFailureSig = undefined;
		this.gaveUp = false;
		this.giveUpReason = undefined;
		this.audited = false;
		this.evidenceAsked = false;
	}
}

export interface GateEnv {
	commands: string[];
	/** Whether HARDcode may run the commands itself (verify=auto and the project is trusted). */
	canAutoRun: boolean;
	lastAssistantText: string;
	pendingWorkflows: number;
	fingerprint(): string | undefined;
	runChecks(commands: string[]): Promise<CheckRun[]>;
	/** Returns undefined when there is nothing to review (no diff available). */
	diff(): { diff: string; changedLines: number } | undefined;
	review(diff: string, checksSummary: string): Promise<ReviewResult>;
	onProgress?(text: string | undefined): void;
}

export type Decision =
	| { action: "skip"; reason: string }
	| { action: "continue"; reason: string; message: string }
	| { action: "settle"; verified: boolean; reason: string };

/** Latest result per command for the current state of the code. */
export function currentResults(cycle: Cycle, fp: string | undefined): Verification[] {
	const relevant = cycle.verifications.filter((v) => (fp !== undefined ? v.fp === fp : v.seq >= cycle.lastEditSeq));
	const latest = new Map<string, Verification>();
	for (const v of relevant) latest.set(v.command, v);
	return [...latest.values()];
}

export function checksSummary(results: Verification[]): string {
	return results
		.map((v) => `${v.ok ? "✓" : "✗"} ${v.command}${v.trustworthy ? "" : " (exit status masked — not counted)"} [${v.source}]`)
		.join("\n");
}

export async function decide(cycle: Cycle, cfg: HardcodeConfig, env: GateEnv): Promise<Decision> {
	if (env.pendingWorkflows > 0) return { action: "skip", reason: "workflow still running" };
	if (cfg.verify === "off") return { action: "skip", reason: "verification off" };

	let fp = env.fingerprint();
	const changed = fp !== undefined ? fp !== cycle.startFp || cycle.external : cycle.toolEdits > 0 || cycle.external;
	if (!changed) return { action: "skip", reason: "no changes to verify" };

	if (cycle.gaveUp) return { action: "settle", verified: false, reason: cycle.giveUpReason ?? "limits reached" };
	if (cycle.continuations >= cfg.maxContinuations) {
		return { action: "settle", verified: false, reason: `continuation cap (${cfg.maxContinuations}) reached` };
	}

	const giveUp = (reason: string): Decision => {
		cycle.gaveUp = true;
		cycle.giveUpReason = reason;
		return { action: "continue", reason: `give up: ${reason}`, message: giveUpMessage(reason) };
	};

	// 1. Run the project's checks ourselves, once per state of the code.
	const stateKey = () => fp ?? `seq:${cycle.lastEditSeq}`;
	if (cfg.verify === "auto" && env.canAutoRun && env.commands.length && cycle.autoRanKey !== stateKey()) {
		const runs: CheckRun[] = [];
		for (const command of env.commands) {
			env.onProgress?.(`running ${command}`);
			const run = await env.runChecks([command]);
			runs.push(...run);
			// Stop at the first failure: later checks usually fail for the same reason.
			if (run.some((r) => !r.ok)) break;
		}
		env.onProgress?.(undefined);
		fp = env.fingerprint();
		cycle.seq++;
		for (const r of runs) cycle.verifications.push({ ...r, trustworthy: true, source: "auto", fp, seq: cycle.seq });
		cycle.autoRanKey = stateKey();
	}

	const results = currentResults(cycle, fp);
	const failing = results.filter((v) => v.trustworthy && !v.ok);
	const passing = results.filter((v) => v.trustworthy && v.ok);

	// 2. Failing checks → diagnose and fix, with limits and repeat detection.
	if (failing.length) {
		const sig = failing.map(failureSignature).sort().join(",");
		cycle.sameFailureCount = sig === cycle.lastFailureSig ? cycle.sameFailureCount + 1 : 1;
		cycle.lastFailureSig = sig;
		if (cycle.fixAttempts >= cfg.maxFixAttempts) return giveUp(`checks still failing after ${cfg.maxFixAttempts} fix attempts`);
		if (cycle.sameFailureCount > cfg.maxSameFailure + 1) {
			return giveUp(`the same failure repeated ${cycle.sameFailureCount} times in a row`);
		}
		cycle.fixAttempts++;
		return {
			action: "continue",
			reason: `checks failing (${failing.map((f) => f.command).join(", ")})`,
			message: failedChecksMessage(failing, cycle.fixAttempts, cfg.maxFixAttempts, cycle.sameFailureCount > 1),
		};
	}

	// 3. No passing verification for this state → the agent has to verify.
	if (!passing.length) {
		if (cycle.verifyNudges >= cfg.maxVerifyNudges) return giveUp(`no passing verification after ${cfg.maxVerifyNudges} reminders`);
		cycle.verifyNudges++;
		const masked = results.some((v) => !v.trustworthy);
		return {
			action: "continue",
			reason: "no verification for the current code",
			message: missingVerificationMessage(env.commands, cycle.verifyNudges, cfg.maxVerifyNudges, masked),
		};
	}

	// 4. Fresh reviewer on the verified diff.
	if (cfg.reviewer !== "off" && cycle.reviewRounds < cfg.maxReviewRounds && cycle.reviewedKey !== stateKey()) {
		const d = env.diff();
		if (d && d.diff.trim() && (cfg.reviewer === "on" || d.changedLines >= cfg.reviewerMinChangedLines)) {
			env.onProgress?.("fresh reviewer is reading the diff");
			const review = await env.review(d.diff, checksSummary(results));
			env.onProgress?.(undefined);
			cycle.reviewRounds++;
			cycle.reviewedKey = stateKey();
			cycle.lastReview = review;
			const blocking = review.issues.filter((i) => i.severity !== "low");
			if (blocking.length) {
				return {
					action: "continue",
					reason: `reviewer found ${blocking.length} issue(s)`,
					message: reviewMessage(blocking, cycle.reviewRounds, cfg.maxReviewRounds),
				};
			}
		}
	}

	// 5. One edge-case / regression audit per task.
	if (cfg.selfAudit && !cycle.audited) {
		cycle.audited = true;
		return { action: "continue", reason: "edge-case audit", message: SELF_AUDIT_MESSAGE };
	}

	// 6. The final report must carry its evidence.
	if (cfg.requireEvidence && !cycle.evidenceAsked && !/\bevidence\b/i.test(env.lastAssistantText)) {
		cycle.evidenceAsked = true;
		return { action: "continue", reason: "final report without evidence", message: EVIDENCE_REPORT_MESSAGE };
	}

	return { action: "settle", verified: true, reason: "checks pass for the final state of the code" };
}
