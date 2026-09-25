/**
 * Model-facing HARDcode text: the execution policy appended to the system
 * prompt, and the gate messages that send the agent back to work.
 */

import type { CheckRun } from "./checks.ts";
import type { HardcodeConfig } from "./config.ts";
import type { ReviewIssue } from "./reviewer.ts";

export function mainPolicy(cfg: HardcodeConfig, commands: string[], withWorkflows: boolean): string {
	const verifyNote =
		cfg.verify === "auto" && commands.length
			? `When you finish a turn that changed files, HARDcode runs these checks itself and sends you back if any fail: ${commands.map((c) => `\`${c}\``).join(", ")}. Still run the relevant ones yourself while you work.`
			: cfg.verify === "off"
				? "HARDcode's automatic verification is off; you are still responsible for running the checks."
				: "You must run the project's checks yourself (find out which exist: package scripts, Makefile, CI config). HARDcode checks that you did and that they passed, after your last change.";
	let text = `
# HARDcode — maximum-effort execution policy (ON)
Favour depth, persistence and verified correctness over speed. These rules override any instinct to finish quickly.

1. Investigate before editing. Read the relevant code paths end to end, find callers and usages, existing tests and conventions, and how the project is built and tested. Reproduce the bug or pin down the exact requirement before changing code.
2. Implement completely. No stubs, TODOs, placeholder logic or partial migrations. Handle errors and edge cases. Update the callers, types, docs and tests your change affects.
3. Verify with evidence. After your changes, run the project's real checks (typecheck, lint, build, tests). Add or update tests that fail without your change and pass with it. Never weaken, skip, mute or delete tests or checks to get green, and never mask exit codes (\`|| true\`, piping into \`tail\` without pipefail).
4. On failure, diagnose. Read the full output, find the root cause, fix it, re-run. If the same failure comes back, change your approach instead of repeating the same fix.
5. Hunt for regressions. Consider empty/null/huge inputs, error paths, concurrency, platform differences, and every other place your change reaches.
6. Claim success only with evidence. End with a final report containing an **Evidence** section: each check you ran and its result, and the tests you added. If anything is unverified, say so plainly.

${verifyNote} Limits: ${cfg.maxFixAttempts} fix attempts per task; after that, report honestly what is still failing.`;
	if (withWorkflows) {
		text += `

## HARDcode with UltraCode workflows
Workflows give breadth; HARDcode governs depth. In workflow scripts, give each agent complete context, tell it to verify its own part cheaply (targeted tests for the files it touched) and to report what it verified. End each script that changes code with a verification phase: a single agent runs the project's checks and returns the failures as JSON. Never let parallel agents run full test suites against the same tree at the same time. When a workflow's result arrives, you own the HARDcode cycle: inspect the combined changes, run the checks, fix the failures, and report the evidence.`;
	}
	return text;
}

export const WORKFLOW_AGENT_POLICY = `
# HARDcode (workflow agent)
You are one agent inside a larger workflow running under HARDcode. Investigate before editing, and implement your part completely (no stubs or TODOs). Verify your own part where it is cheap and safe: targeted tests or a quick typecheck of the files you touched. Do not run the full test suite unless your task says to, because other agents are working in parallel. In your final message, state exactly what you verified (the commands and their results) and what you could not verify. Never claim success without evidence.`;

function fence(text: string): string {
	return `\`\`\`\n${text.replace(/```/g, "ˋˋˋ")}\n\`\`\``;
}

export function failedChecksMessage(failures: CheckRun[], attempt: number, max: number, repeated: boolean): string {
	const parts = failures.map(
		(f) =>
			`### \`${f.command}\` — ${f.timedOut ? "timed out" : `exit ${f.exitCode}`}\n${fence(f.tail || "(no output)")}`,
	);
	return [
		`HARDcode: verification FAILED (fix attempt ${attempt}/${max}). The task is not done.`,
		"",
		...parts,
		"",
		repeated
			? "This is the same failure as last time, so your previous fix did not work. Step back: re-read the failing code and test, question your assumptions, and try a different approach."
			: "Diagnose the root cause from the output (read the failing code and test), fix it properly, and re-run the checks. Do not weaken or skip tests.",
	].join("\n");
}

export function missingVerificationMessage(commands: string[], nudge: number, max: number, trustedOnlyNote: boolean): string {
	const known = commands.length ? ` Known checks for this project: ${commands.map((c) => `\`${c}\``).join(", ")}.` : "";
	return [
		`HARDcode: you changed files but there is no passing verification for the current state of the code (reminder ${nudge}/${max}).`,
		`Run the project's checks now (typecheck, lint, build, tests) and read the results.${known}`,
		"If the project has no automated checks, write and run a small reproduction or test that exercises the change.",
		trustedOnlyNote ? "Exit codes must not be masked: no `|| true`, and no piping into another command without `set -o pipefail`." : "",
	]
		.filter(Boolean)
		.join("\n");
}

export const SELF_AUDIT_MESSAGE = `HARDcode: the checks pass. Before finishing, run one regression and edge-case audit of your whole diff:
- For each change: which inputs, states or callers could break? (empty/null/huge inputs, errors, concurrency, backwards compatibility)
- Are there tests that would fail without your change? Add the missing ones.
- Is anything incomplete: TODOs, stubs, unhandled branches, docs or types you did not update?
Fix what you find and re-run the relevant checks. If nothing needs changing, say so briefly, then give the final report with its Evidence section.`;

export function reviewMessage(issues: ReviewIssue[], round: number, max: number): string {
	return [
		`HARDcode: a fresh reviewer, who did not see this conversation, found issues in your diff (review ${round}/${max}):`,
		"",
		...issues.map(
			(i, n) =>
				`${n + 1}. [${i.severity}] ${i.file ? `${i.file}${i.line ? `:${i.line}` : ""}: ` : ""}${i.problem}${i.fix ? `\n   Suggested fix: ${i.fix}` : ""}`,
		),
		"",
		"Check each one against the code. Fix the real ones and re-run the checks. For any you reject, say why in your final report.",
	].join("\n");
}

export const EVIDENCE_REPORT_MESSAGE =
	"HARDcode: finish with the final report. Summarize what you changed, then add an **Evidence** section listing each check you ran and its result, the tests you added, and anything that remains unverified.";

export function giveUpMessage(reason: string): string {
	return `HARDcode: stopping the fix loop (${reason}). Do not attempt more fixes. Write the final report: what you changed, what still fails (the exact commands and errors), your best diagnosis, and suggested next steps. State clearly that the task is NOT verified.`;
}
