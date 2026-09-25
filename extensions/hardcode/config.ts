/**
 * HARDcode configuration: ~/.pi/agent/hardcode.json, overlaid by the
 * project's .pi/hardcode.json when the project is trusted.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface HardcodeConfig {
	/** Start every session with HARDcode on. */
	enabled: boolean;
	/** Minimum thinking level while on ("keep" leaves it alone). Never lowers the current level. */
	thinking: "keep" | "high" | "xhigh" | "max";
	/**
	 * How verification happens when the work changed files:
	 * - "auto": HARDcode runs the project's checks itself at the end of each run
	 * - "agent": the agent must run checks; HARDcode checks that it did and that they passed
	 * - "off": no verification gate (prompt policy only)
	 */
	verify: "auto" | "agent" | "off";
	/** Explicit check commands; empty = detect from the project (package.json, Cargo, go, pytest, make). */
	verifyCommands: string[];
	/** Per-command timeout for auto-run checks. */
	commandTimeoutSec: number;
	/** Fix → re-verify rounds after a failing check before HARDcode stops and reports the task unverified. */
	maxFixAttempts: number;
	/** Times the agent is told to run checks itself (agent mode, or when no checks were detected). */
	maxVerifyNudges: number;
	/** Times the agent is told to change approach for an identical repeated failure before HARDcode gives up. */
	maxSameFailure: number;
	/** Hard cap on HARDcode continuations per task, whatever the reason. */
	maxContinuations: number;
	/** Once per task, after checks pass: audit the diff for edge cases/regressions and add missing tests. */
	selfAudit: boolean;
	/** Require a final report with an Evidence section when files changed. */
	requireEvidence: boolean;
	/** Fresh read-only reviewer on the final diff: "on", "off", or "auto" (only for diffs ≥ reviewerMinChangedLines). */
	reviewer: "off" | "on" | "auto";
	reviewerMinChangedLines: number;
	reviewerModel?: string;
	reviewerThinking: string;
	maxReviewRounds: number;
	/** Depth policy inside UltraCode workflow agents: "policy" (prompt only) or "off". */
	workflowAgents: "policy" | "off";
	/** Optional status background, e.g. "#ffd84d". The text is always "HARD" in black and "code" in red. */
	statusBackground?: string;
}

export const DEFAULTS: HardcodeConfig = {
	enabled: false,
	thinking: "xhigh",
	verify: "auto",
	verifyCommands: [],
	commandTimeoutSec: 900,
	maxFixAttempts: 4,
	maxVerifyNudges: 2,
	maxSameFailure: 2,
	maxContinuations: 10,
	selfAudit: true,
	requireEvidence: true,
	reviewer: "off",
	reviewerMinChangedLines: 80,
	reviewerThinking: "high",
	maxReviewRounds: 1,
	workflowAgents: "policy",
};

export const GLOBAL_CONFIG_PATH = path.join(getAgentDir(), "hardcode.json");

function readJson(file: string): Partial<HardcodeConfig> {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		return data && typeof data === "object" && !Array.isArray(data) ? data : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd?: string, projectTrusted = false): HardcodeConfig {
	const merged = { ...DEFAULTS, ...readJson(GLOBAL_CONFIG_PATH) };
	if (cwd && projectTrusted) Object.assign(merged, readJson(path.join(cwd, ".pi", "hardcode.json")));
	return merged;
}

/** Set one key in the global config file. Values are parsed as JSON when possible. */
export function setGlobalConfig(key: string, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
	if (!(key in DEFAULTS) && key !== "reviewerModel" && key !== "statusBackground") {
		return { ok: false, error: `unknown key "${key}". Keys: ${[...Object.keys(DEFAULTS), "reviewerModel", "statusBackground"].join(", ")}` };
	}
	let value: unknown = raw;
	try {
		value = JSON.parse(raw);
	} catch {}
	const expected = typeof (DEFAULTS as any)[key];
	if (key in DEFAULTS && expected !== "undefined" && typeof value !== expected && !(Array.isArray((DEFAULTS as any)[key]) && Array.isArray(value))) {
		return { ok: false, error: `"${key}" expects a ${Array.isArray((DEFAULTS as any)[key]) ? "JSON array" : expected}` };
	}
	const current = readJson(GLOBAL_CONFIG_PATH) as Record<string, unknown>;
	if (raw === "default") delete current[key];
	else current[key] = value;
	fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
	fs.writeFileSync(GLOBAL_CONFIG_PATH, `${JSON.stringify(current, null, 2)}\n`);
	return { ok: true, value: raw === "default" ? (DEFAULTS as any)[key] : value };
}
