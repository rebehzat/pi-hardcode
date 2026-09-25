/**
 * 🌸 SoftCode — HARDcode's opposite: a light-touch mode for quick, cheap work.
 * Smallest change that does the job, light verification, short answers, a lower
 * thinking level, and (optionally) a plain-language explanation of each step.
 *
 * Mutually exclusive with HARDcode. Like HARDcode, off means off: while disabled
 * only /softcode, the --softcode flag and the session start/shutdown listeners exist.
 */

import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { leftBadgeEditor } from "./badge.ts";
import { readJson, setConfigKey } from "./config.ts";

export interface SoftcodeConfig {
	/** Start every session with SoftCode on. */
	enabled: boolean;
	/** Thinking level while on: lowered to at most this level (never raised), restored when turned off. "keep" leaves it alone. */
	thinking: "keep" | "off" | "minimal" | "low" | "medium";
	/** Explain each step and change in plain language as it goes. */
	explain: boolean;
	/** Light-touch policy inside UltraCode workflow agents: "policy" or "off". */
	workflowAgents: "policy" | "off";
}

export const SOFTCODE_DEFAULTS: SoftcodeConfig = {
	enabled: false,
	thinking: "low",
	explain: true,
	workflowAgents: "policy",
};

export const SOFTCODE_CONFIG_PATH = path.join(getAgentDir(), "softcode.json");
export const SOFTCODE_AGENTS_ENV = "PI_SOFTCODE_AGENTS";
const MODE_ENTRY = "softcode-mode";
const LABEL = "SoftCode";
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function loadSoftcodeConfig(cwd?: string, projectTrusted = false): SoftcodeConfig {
	const merged = { ...SOFTCODE_DEFAULTS, ...readJson(SOFTCODE_CONFIG_PATH) } as SoftcodeConfig;
	if (cwd && projectTrusted) Object.assign(merged, readJson(path.join(cwd, ".pi", "softcode.json")));
	return merged;
}

/** 🌸 then "Soft" in light pink and "Code" in hot pink. */
export const SOFTCODE_STATUS = " 🌸 \x1b[38;2;255;182;193mSoft\x1b[38;2;255;105;180mCode\x1b[39m ";

export function softcodePolicy(cfg: SoftcodeConfig, withWorkflows: boolean): string {
	let text = `
# SoftCode — light-touch mode (ON)
The user wants the quick, cheap version. Favour speed, small diffs and short answers over thoroughness.

1. Look only at what the task needs. Open the files directly involved; don't survey the repository or read code "just in case".
2. Make the smallest change that does the job. No refactors, renames, reformatting, new abstractions, or unrequested tests and docs. Match the existing style.
3. Verify lightly. For a non-trivial change, one quick targeted check (the relevant test file, or a typecheck) is enough; skip it for trivial edits. Don't run full test suites or builds unless asked.
4. Don't gold-plate. Handle the edge cases the task implies; mention other notable risks in one line instead of fixing them.
5. Keep answers short: a few lines on what changed. No long reports.
6. Stay correct. Light-touch never means guessing: if something is risky (data loss, security, migrations) or unclear, say so briefly.`;
	if (cfg.explain) {
		text += `
7. Explain as you go, in plain language. Before each tool call, one short sentence saying what you're about to do and why. After each file change, one or two sentences on what you changed and why it fixes the problem.`;
	}
	if (withWorkflows) {
		text += `

## SoftCode with UltraCode workflows
Keep workflows small: the fewest agents that do the job, no multi-round verification or adversarial review unless asked, and cheaper models or lower thinking for mechanical stages. If the task is quick to do yourself, just do it.`;
	}
	return text;
}

export const SOFTCODE_AGENT_POLICY = `
# SoftCode (workflow agent)
You are one agent inside a workflow running under SoftCode (light-touch mode). Do only your part, with the smallest change that does the job. Read only the files you need. Verify only if it is quick and targeted. Keep your final message short: what you did, and anything notable you did not do.`;

/** `hardcodeOn`: SoftCode refuses to turn on while HARDcode is on. */
export function softcode(pi: ExtensionAPI, hardcodeOn: () => boolean): { isActive: () => boolean } {
	let active = false;
	let cfg: SoftcodeConfig = { ...SOFTCODE_DEFAULTS };
	let unsubscribers: (() => void)[] = [];
	let thinkingBefore: string | undefined;
	let thinkingSet: string | undefined;
	const badge = leftBadgeEditor(() => (active ? SOFTCODE_STATUS : undefined));

	function applyThinking(restoredBefore?: string): void {
		if (cfg.thinking === "keep") return;
		const current = pi.getThinkingLevel();
		if (THINKING.indexOf(current) > THINKING.indexOf(cfg.thinking)) {
			thinkingBefore = restoredBefore ?? current;
			pi.setThinkingLevel(cfg.thinking as any);
			thinkingSet = pi.getThinkingLevel();
		} else if (restoredBefore && restoredBefore !== current) {
			// Resumed session already carries the lowered level; remember what to go back to.
			thinkingBefore = restoredBefore;
			thinkingSet = current;
		}
	}

	function activate(ctx: ExtensionContext, persist: boolean, restoredBefore?: string): void {
		if (active) return;
		active = true;
		cfg = loadSoftcodeConfig(ctx.cwd, ctx.isProjectTrusted());
		unsubscribers.push(
			pi.on("before_agent_start", (event) => {
				const policy = softcodePolicy(cfg, pi.getActiveTools().includes("workflow"));
				event.systemPromptOptions.appendSystemPrompt = `${event.systemPromptOptions.appendSystemPrompt ?? ""}\n${policy}`;
				return undefined;
			}),
		);
		if (cfg.workflowAgents === "policy") process.env[SOFTCODE_AGENTS_ENV] = "policy";
		applyThinking(restoredBefore);
		if (ctx.hasUI) ctx.ui.setStatus("softcode", SOFTCODE_STATUS);
		badge.install(ctx);
		if (persist) pi.appendEntry(MODE_ENTRY, { on: true, thinkingBefore });
	}

	/** `restoreThinking` is false when switching sessions: the new session brings its own thinking level. */
	function deactivate(ctx: ExtensionContext, persist: boolean, restoreThinking = true): void {
		if (!active) return;
		active = false;
		for (const off of unsubscribers) off();
		unsubscribers = [];
		delete process.env[SOFTCODE_AGENTS_ENV];
		// Put thinking back only if nobody changed it since.
		if (restoreThinking && thinkingBefore && pi.getThinkingLevel() === thinkingSet) pi.setThinkingLevel(thinkingBefore as any);
		thinkingBefore = thinkingSet = undefined;
		if (ctx.hasUI) {
			ctx.ui.setStatus("softcode", undefined);
			badge.remove(ctx);
		}
		if (persist) pi.appendEntry(MODE_ENTRY, { on: false });
	}

	function turnOn(ctx: ExtensionContext): void {
		if (hardcodeOn()) {
			ctx.ui.notify(`${LABEL} needs HARDcode off. Run /hardcode off first.`, "warning");
			return;
		}
		activate(ctx, true);
		ctx.ui.notify(`${LABEL} on`, "info");
	}

	function statusReport(ctx: ExtensionContext): string {
		const c = loadSoftcodeConfig(ctx.cwd, ctx.isProjectTrusted());
		return [
			`${LABEL} is ${active ? "ON" : "off"}${!active && hardcodeOn() ? " (HARDcode is on; turn it off to use SoftCode)" : ""}`,
			`thinking: ${c.thinking === "keep" ? "keep" : `at most ${c.thinking}`}${thinkingBefore ? ` (was ${thinkingBefore})` : ""} · explain: ${c.explain} · workflow agents: ${c.workflowAgents}`,
			`config: ${SOFTCODE_CONFIG_PATH}`,
		].join("\n");
	}

	pi.registerFlag("softcode", { type: "boolean", description: "Start with SoftCode on (light-touch mode; needs HARDcode off)" });

	pi.registerCommand("softcode", {
		description: "🌸 SoftCode light-touch mode (needs HARDcode off): /softcode [on|off|status|config [key value]]",
		getArgumentCompletions: (prefix) => {
			const [sub, key] = prefix.split(/\s+/);
			if (sub === "config" && key !== undefined) {
				return Object.keys(SOFTCODE_DEFAULTS)
					.filter((k) => k.startsWith(key))
					.map((k) => ({ value: `config ${k} `, label: k }));
			}
			return ["on", "off", "status", "config"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
		},
		handler: async (args, ctx) => {
			const [sub = "", key, ...rest] = args.trim().split(/\s+/);
			switch (sub.toLowerCase()) {
				case "on":
					turnOn(ctx);
					return;
				case "off":
					deactivate(ctx, true);
					ctx.ui.notify(`${LABEL} off`, "info");
					return;
				case "":
					if (active) {
						deactivate(ctx, true);
						ctx.ui.notify(`${LABEL} off`, "info");
					} else turnOn(ctx);
					return;
				case "status":
					ctx.ui.notify(statusReport(ctx), "info");
					return;
				case "config": {
					if (!key) {
						ctx.ui.notify(JSON.stringify(loadSoftcodeConfig(ctx.cwd, ctx.isProjectTrusted()), null, 2), "info");
						return;
					}
					const value = rest.join(" ");
					if (!value) {
						ctx.ui.notify(`${key} = ${JSON.stringify((loadSoftcodeConfig(ctx.cwd, ctx.isProjectTrusted()) as any)[key])}`, "info");
						return;
					}
					const res = setConfigKey(SOFTCODE_CONFIG_PATH, SOFTCODE_DEFAULTS, [], key, value);
					if (!res.ok) {
						ctx.ui.notify(res.error, "error");
						return;
					}
					if (active) {
						cfg = loadSoftcodeConfig(ctx.cwd, ctx.isProjectTrusted());
						if (cfg.workflowAgents === "policy") process.env[SOFTCODE_AGENTS_ENV] = "policy";
						else delete process.env[SOFTCODE_AGENTS_ENV];
					}
					ctx.ui.notify(`${LABEL} config: ${key} = ${JSON.stringify(res.value)}${key === "thinking" && active ? " (applies next time SoftCode is turned on)" : ""}`, "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /softcode [on|off|status|config [key value]]", "warning");
			}
		},
	});

	// Registered after HARDcode's session_start listener, so HARDcode has already decided whether it is on.
	pi.on("session_start", (event, ctx) => {
		let restored: boolean | undefined;
		let restoredBefore: string | undefined;
		if (event.reason === "resume" || event.reason === "fork" || event.reason === "reload") {
			for (const e of ctx.sessionManager.getBranch() as any[]) {
				if (e?.type === "custom" && e.customType === MODE_ENTRY) {
					restored = !!e.data?.on;
					restoredBefore = e.data?.thinkingBefore;
				}
			}
		}
		const want = restored ?? (!!pi.getFlag("softcode") || loadSoftcodeConfig(ctx.cwd, ctx.isProjectTrusted()).enabled);
		if (active) deactivate(ctx, false, false);
		if (want && hardcodeOn()) {
			if (ctx.hasUI) ctx.ui.notify(`${LABEL} not started: HARDcode is on`, "warning");
		} else if (want) {
			activate(ctx, false, restored ? restoredBefore : undefined);
			// Other extensions (UltraCode) install their editor in session_start too; wrap it once they have.
			if (ctx.mode === "tui") {
				badge.remove(ctx);
				setTimeout(() => active && badge.install(ctx), 0);
			}
		}
		return undefined;
	});

	pi.on("session_shutdown", () => {
		for (const off of unsubscribers) off();
		unsubscribers = [];
		active = false;
		delete process.env[SOFTCODE_AGENTS_ENV];
	});

	return { isActive: () => active };
}
