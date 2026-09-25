/**
 * pi-hardcode — a composable maximum-effort execution policy for pi.
 *
 * HARDcode is a policy layer, not an orchestrator: it tells the agent to
 * investigate, implement completely and verify, and enforces that with a
 * verification gate at the end of each run (auto-run checks → fix/retry with
 * limits → optional fresh reviewer → edge-case audit → evidence report).
 *
 * Off means off: while disabled, no policy hook, prompt text, tool, editor or
 * status is installed. Only /hardcode, the --hardcode flag, two renderers for
 * HARDcode's own entries, and session_start/session_shutdown listeners exist.
 *
 * With UltraCode: workflows supply the breadth; HARDcode waits while a workflow
 * runs, then pushes its combined result through the same verification cycle.
 * Workflow agents get a light depth policy through the PI_HARDCODE_AGENTS env var.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { classifyCommand, detectCommands, fingerprint, gitRoot, runCheck, workingDiff } from "./checks.ts";
import { DEFAULTS, GLOBAL_CONFIG_PATH, type HardcodeConfig, loadConfig, setGlobalConfig } from "./config.ts";
import { checksSummary, Cycle, currentResults, decide } from "./gate.ts";
import { mainPolicy, WORKFLOW_AGENT_POLICY } from "./policy.ts";
import { CHILD_ENV, runReviewer } from "./reviewer.ts";

const MODE_ENTRY = "hardcode-mode";
const GATE_MESSAGE = "hardcode-gate";
const EVIDENCE_ENTRY = "hardcode-evidence";
const AGENTS_ENV = "PI_HARDCODE_AGENTS";
const LABEL = "HARDcode";
const EDIT_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch", "notebook_edit"]);
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function statusText(cfg: HardcodeConfig): string {
	// White background by default ("none" turns it off); 💀 then "HARD" in black and "code" in red.
	const hex = /^#?([0-9a-f]{6})$/i.exec(cfg.statusBackground ?? "")?.[1];
	const bg = hex ? `\x1b[48;2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}m` : "";
	return `${bg} 💀 \x1b[30mHARD\x1b[31mcode\x1b[39m ${bg ? "\x1b[49m" : ""}`;
}

function lastAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		return (m.content ?? [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

function resultText(content: any[]): string {
	return (content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

export default function hardcode(pi: ExtensionAPI) {
	// The reviewer process runs plain pi.
	if (process.env[CHILD_ENV]) return;

	// Inside an UltraCode workflow agent: only the light depth policy, and only when the parent asked for it.
	if (Number(process.env.PI_ULTRACODE_DEPTH ?? 0) > 0) {
		if (process.env[AGENTS_ENV] === "policy") {
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.appendSystemPrompt = `${event.systemPromptOptions.appendSystemPrompt ?? ""}\n${WORKFLOW_AGENT_POLICY}`;
				return undefined;
			});
		}
		return;
	}

	let active = false;
	let cfg: HardcodeConfig = { ...DEFAULTS };
	let unsubscribers: (() => void)[] = [];
	let cycle: Cycle | undefined;
	const pendingWorkflows = new Set<string>();
	let thinkingBefore: string | undefined;
	let thinkingSet: string | undefined;
	let lastDecision: string | undefined;

	const commandsFor = (ctx: ExtensionContext): string[] =>
		cfg.verifyCommands.length ? cfg.verifyCommands : detectCommands(gitRoot(ctx.cwd) ?? ctx.cwd);

	const ultracodeOn = (ctx: ExtensionContext): boolean => {
		let on = false;
		try {
			for (const e of ctx.sessionManager.getBranch() as any[]) {
				if (e?.type === "custom" && e.customType === "ultracode-mode") on = !!e.data?.on;
			}
		} catch {}
		return on;
	};

	const newCycle = (task: string, ctx: ExtensionContext) => {
		cycle = new Cycle(task, fingerprint(ctx.cwd));
		return cycle;
	};

	// ── policy hooks (installed only while active) ──

	function installHooks(): void {
		unsubscribers.push(
			pi.on("input", (event, ctx) => {
				// A person's prompt starts a new task; extension-sent prompts continue the current one.
				if (event.source !== "extension" || !cycle) newCycle(event.text, ctx);
				return { action: "continue" };
			}),

			pi.on("before_agent_start", (event, ctx) => {
				if (!cycle) newCycle(event.prompt, ctx);
				const withWorkflows = pi.getActiveTools().includes("workflow");
				const policy = mainPolicy(cfg, cfg.verify === "auto" ? commandsFor(ctx) : [], withWorkflows);
				event.systemPromptOptions.appendSystemPrompt = `${event.systemPromptOptions.appendSystemPrompt ?? ""}\n${policy}`;
				return undefined;
			}),

			pi.on("tool_result", (event, ctx) => {
				const c = cycle ?? newCycle("", ctx);
				c.seq++;
				if (EDIT_TOOLS.has(event.toolName) && !event.isError) {
					c.toolEdits++;
					c.lastEditSeq = c.seq;
				} else if (event.toolName === "bash" && typeof event.input.command === "string") {
					const command = event.input.command.trim();
					const cls = classifyCommand(command);
					if (cls.isCheck) {
						const text = resultText(event.content);
						const code = event.isError ? Number(/exited with code (\d+)/.exec(text)?.[1] ?? 1) : 0;
						c.verifications.push({
							command,
							ok: !event.isError,
							exitCode: code,
							timedOut: /terminated without an exit code|timed out/i.test(text),
							durationMs: 0,
							tail: text.slice(-6000),
							trustworthy: cls.trustworthy,
							source: "agent",
							fp: fingerprint(ctx.cwd),
							seq: c.seq,
						});
					}
				} else if (event.toolName === "workflow" && !event.isError) {
					const d = event.details as { runId?: string; background?: boolean } | undefined;
					if (d?.runId && d.background) pendingWorkflows.add(d.runId);
					else {
						// A foreground workflow already finished and changed things outside our tool calls.
						c.external = true;
						c.lastEditSeq = c.seq;
					}
				}
				return undefined;
			}),

			pi.on("message_end", (event, ctx) => {
				const msg = event.message as any;
				if (msg?.role !== "custom" || msg.customType !== "ultracode-result") return undefined;
				// A background workflow finished: its combined changes now go through the HARDcode cycle.
				const id = msg.details?.id;
				if (id) pendingWorkflows.delete(id);
				else pendingWorkflows.clear();
				const c = cycle ?? newCycle("", ctx);
				c.external = true;
				c.lastEditSeq = ++c.seq;
				c.resetBudget();
				return undefined;
			}),

			pi.on("agent_before_settle", async (event, ctx) => {
				if (event.outcome !== "completed" || !cycle) return undefined;
				// Another extension is already continuing; gate on the settle after that.
				if (event.continue) return undefined;
				const c = cycle;
				const decision = await decide(c, cfg, {
					commands: commandsFor(ctx),
					canAutoRun: cfg.verify === "auto",
					lastAssistantText: lastAssistantText(event.context.contextMessages as any[]),
					pendingWorkflows: pendingWorkflows.size,
					fingerprint: () => fingerprint(ctx.cwd),
					runChecks: async (commands) => {
						const out = [];
						for (const command of commands) out.push(await runCheck(command, ctx.cwd, cfg.commandTimeoutSec, ctx.signal));
						return out;
					},
					diff: () => {
						const d = workingDiff(ctx.cwd, 80_000);
						return d.diff ? d : undefined;
					},
					review: (diff, checks) =>
						runReviewer({
							task: c.task,
							diff,
							checks,
							cwd: ctx.cwd,
							model: cfg.reviewerModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
							thinking: cfg.reviewerThinking,
							signal: ctx.signal,
						}),
					onProgress: (text) => {
						if (ctx.mode === "tui") ctx.ui.setWorkingMessage(text ? `${LABEL} · ${text}` : undefined);
					},
				});
				lastDecision = `${decision.action}: ${decision.reason}`;
				if (decision.action === "skip") return undefined;

				if (decision.action === "continue") {
					c.continuations++;
					return {
						entries: [
							...event.entries,
							{
								type: "custom_message",
								customType: GATE_MESSAGE,
								content: decision.message,
								display: true,
								details: { reason: decision.reason, continuation: c.continuations },
							},
						],
						continue: true,
					};
				}

				const fp = fingerprint(ctx.cwd);
				const checks = currentResults(c, fp);
				const evidence = {
					verified: decision.verified,
					reason: decision.reason,
					checks: checks.map((v) => ({ command: v.command, ok: v.ok, trustworthy: v.trustworthy, source: v.source })),
					fixAttempts: c.fixAttempts,
					review: c.lastReview ? { issues: c.lastReview.issues.length, error: c.lastReview.error } : undefined,
				};
				if (ctx.hasUI) {
					ctx.ui.notify(
						decision.verified ? `${LABEL}: verified — ${decision.reason}` : `${LABEL}: NOT verified — ${decision.reason}`,
						decision.verified ? "info" : "warning",
					);
				}
				return { entries: [...event.entries, { type: "custom", customType: EVIDENCE_ENTRY, data: evidence }] };
			}),
		);
	}

	// ── activation ──

	function activate(ctx: ExtensionContext, persist: boolean): void {
		if (active) return;
		active = true;
		cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		cycle = undefined;
		pendingWorkflows.clear();
		installHooks();
		if (cfg.workflowAgents === "policy") process.env[AGENTS_ENV] = "policy";
		if (cfg.thinking !== "keep") {
			const current = pi.getThinkingLevel();
			if (THINKING.indexOf(current) < THINKING.indexOf(cfg.thinking)) {
				thinkingBefore = current;
				pi.setThinkingLevel(cfg.thinking as any);
				thinkingSet = pi.getThinkingLevel();
			}
		}
		if (ctx.hasUI) ctx.ui.setStatus("hardcode", statusText(cfg));
		if (persist) pi.appendEntry(MODE_ENTRY, { on: true });
	}

	function deactivate(ctx: ExtensionContext, persist: boolean): void {
		if (!active) return;
		active = false;
		for (const off of unsubscribers) off();
		unsubscribers = [];
		cycle = undefined;
		pendingWorkflows.clear();
		delete process.env[AGENTS_ENV];
		// Put thinking back only if nobody changed it since and UltraCode isn't relying on it.
		if (thinkingBefore && pi.getThinkingLevel() === thinkingSet && !ultracodeOn(ctx)) pi.setThinkingLevel(thinkingBefore as any);
		thinkingBefore = thinkingSet = undefined;
		if (ctx.hasUI) {
			ctx.ui.setStatus("hardcode", undefined);
			ctx.ui.setWorkingMessage();
		}
		if (persist) pi.appendEntry(MODE_ENTRY, { on: false });
	}

	// ── always-on surface: command, flag, renderers, mode restore ──

	pi.registerFlag("hardcode", { type: "boolean", description: "Start with HARDcode on (maximum-effort verification policy)" });

	pi.registerMessageRenderer(GATE_MESSAGE, (message, { expanded }, theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		const [first, ...rest] = text.split("\n");
		const head = `${theme.fg("warning", "▲")} ${theme.bold(LABEL)} ${theme.fg("muted", (first ?? "").replace(/^HARDcode:\s*/, ""))}`;
		const body = expanded ? rest.join("\n") : rest.filter(Boolean).slice(0, 6).join("\n");
		return new Text(body ? `${head}\n${theme.fg("dim", body)}` : head, 0, 0);
	});

	pi.registerEntryRenderer(EVIDENCE_ENTRY, (entry, _opts, theme) => {
		const d = (entry.data ?? {}) as any;
		const icon = d.verified ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const checks = (d.checks ?? [])
			.map((c: any) => `${c.ok && c.trustworthy ? theme.fg("success", "✓") : theme.fg("error", "✗")} ${c.command}`)
			.join(theme.fg("dim", " · "));
		const extras = [
			d.fixAttempts ? `${d.fixAttempts} fix attempt${d.fixAttempts === 1 ? "" : "s"}` : "",
			d.review ? (d.review.error ? `review failed: ${d.review.error}` : `review: ${d.review.issues} issue(s)`) : "",
		].filter(Boolean);
		return new Text(
			`${icon} ${theme.bold(LABEL)} ${d.verified ? "verified" : "NOT verified"} ${theme.fg("muted", `— ${d.reason ?? ""}`)}` +
				(checks ? `\n  ${checks}` : "") +
				(extras.length ? `\n  ${theme.fg("dim", extras.join(" · "))}` : ""),
			0,
			0,
		);
	});

	function statusReport(ctx: ExtensionContext): string {
		const c = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		const commands = c.verifyCommands.length ? c.verifyCommands : detectCommands(gitRoot(ctx.cwd) ?? ctx.cwd);
		const lines = [
			`${LABEL} is ${active ? "ON" : "off"}`,
			`verify: ${c.verify}${c.verify === "auto" ? ` · checks: ${commands.length ? commands.join(" → ") : "none detected (agent must verify)"}` : ""}`,
			`limits: ${c.maxFixAttempts} fix attempts · ${c.maxVerifyNudges} verify reminders · ${c.maxSameFailure} repeat warnings · ${c.maxContinuations} continuations`,
			`reviewer: ${c.reviewer}${c.reviewer === "auto" ? ` (≥${c.reviewerMinChangedLines} changed lines)` : ""} · self-audit: ${c.selfAudit} · evidence report: ${c.requireEvidence}`,
			`thinking: ${c.thinking} · workflow agents: ${c.workflowAgents}`,
		];
		if (active && cycle) {
			lines.push(
				`current task: ${cycle.continuations} continuations · ${cycle.fixAttempts} fixes · ${cycle.verifications.length} checks recorded` +
					(pendingWorkflows.size ? ` · ${pendingWorkflows.size} workflow(s) running` : ""),
			);
			const results = currentResults(cycle, fingerprint(ctx.cwd));
			if (results.length) lines.push(checksSummary(results));
		}
		if (lastDecision) lines.push(`last gate decision: ${lastDecision}`);
		lines.push(`config: ${GLOBAL_CONFIG_PATH}`);
		return lines.join("\n");
	}

	pi.registerCommand("hardcode", {
		description: "HARDcode maximum-effort mode: /hardcode [on|off|status|config [key value]]",
		getArgumentCompletions: (prefix) => {
			const [sub, key] = prefix.split(/\s+/);
			if (sub === "config" && key !== undefined) {
				return Object.keys({ ...DEFAULTS, reviewerModel: 0 })
					.filter((k) => k.startsWith(key))
					.map((k) => ({ value: `config ${k} `, label: k }));
			}
			return ["on", "off", "status", "config"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
		},
		handler: async (args, ctx) => {
			const [sub = "", key, ...rest] = args.trim().split(/\s+/);
			switch (sub.toLowerCase()) {
				case "on":
					activate(ctx, true);
					ctx.ui.notify(`${LABEL} on`, "info");
					return;
				case "off":
					deactivate(ctx, true);
					ctx.ui.notify(`${LABEL} off`, "info");
					return;
				case "":
					if (active) deactivate(ctx, true);
					else activate(ctx, true);
					ctx.ui.notify(`${LABEL} ${active ? "on" : "off"}`, "info");
					return;
				case "status":
					ctx.ui.notify(statusReport(ctx), "info");
					return;
				case "config": {
					if (!key) {
						ctx.ui.notify(JSON.stringify(loadConfig(ctx.cwd, ctx.isProjectTrusted()), null, 2), "info");
						return;
					}
					const value = rest.join(" ");
					if (!value) {
						ctx.ui.notify(`${key} = ${JSON.stringify((loadConfig(ctx.cwd, ctx.isProjectTrusted()) as any)[key])}`, "info");
						return;
					}
					const res = setGlobalConfig(key, value);
					if (!res.ok) {
						ctx.ui.notify(res.error, "error");
						return;
					}
					if (active) {
						cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
						if (ctx.hasUI) ctx.ui.setStatus("hardcode", statusText(cfg));
						if (cfg.workflowAgents === "policy") process.env[AGENTS_ENV] = "policy";
						else delete process.env[AGENTS_ENV];
					}
					ctx.ui.notify(`${LABEL} config: ${key} = ${JSON.stringify(res.value)}`, "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /hardcode [on|off|status|config [key value]]", "warning");
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
		let restored: boolean | undefined;
		if (event.reason === "resume" || event.reason === "fork" || event.reason === "reload") {
			for (const e of ctx.sessionManager.getBranch() as any[]) {
				if (e?.type === "custom" && e.customType === MODE_ENTRY) restored = !!e.data?.on;
			}
		}
		const want = restored ?? (!!pi.getFlag("hardcode") || loadConfig(ctx.cwd, ctx.isProjectTrusted()).enabled);
		if (active) deactivate(ctx, false);
		if (want) activate(ctx, false);
		return undefined;
	});

	pi.on("session_shutdown", () => {
		for (const off of unsubscribers) off();
		unsubscribers = [];
		active = false;
		delete process.env[AGENTS_ENV];
	});
}
