import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hardcode-test-"));
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");
delete process.env.PI_ULTRACODE_DEPTH;
delete process.env.PI_HARDCODE_CHILD;

const { classifyCommand, detectCommands, fingerprint } = await import("../extensions/hardcode/checks.ts");
const { DEFAULTS } = await import("../extensions/hardcode/config.ts");
const { Cycle, decide } = await import("../extensions/hardcode/gate.ts");
const hardcode = (await import("../extensions/hardcode/index.ts")).default;

// ── fake pi ────────────────────────────────────────────────────────────────

function fakePi() {
	const handlers = new Map<string, Set<Function>>();
	const commands = new Map<string, any>();
	const state = { thinking: "medium", statuses: new Map<string, string | undefined>(), entries: [] as any[], notes: [] as string[] };
	const pi: any = {
		on(event: string, fn: Function) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)!.add(fn);
			return () => handlers.get(event)!.delete(fn);
		},
		registerCommand: (name: string, c: any) => commands.set(name, c),
		registerFlag() {},
		getFlag: () => undefined,
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		getThinkingLevel: () => state.thinking,
		setThinkingLevel: (l: string) => (state.thinking = l),
		appendEntry: (customType: string, data: unknown) => state.entries.push({ type: "custom", customType, data }),
		getActiveTools: () => ["read", "bash", "edit", "write"],
	};
	const ctx = (cwd: string): any => ({
		cwd,
		hasUI: true,
		mode: "print",
		model: undefined,
		signal: undefined,
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => state.entries },
		ui: {
			setStatus: (k: string, v: string | undefined) => state.statuses.set(k, v),
			notify: (m: string) => state.notes.push(m),
			setWorkingMessage() {},
		},
	});
	const active = () => [...handlers.entries()].filter(([, s]) => s.size).map(([e]) => e).sort();
	const emit = async (event: string, payload: any, c: any) => {
		let result: any;
		for (const fn of handlers.get(event) ?? []) result = (await fn(payload, c)) ?? result;
		return result;
	};
	return { pi, handlers, commands, state, ctx, active, emit };
}

// ── disabled leaves pi untouched ───────────────────────────────────────────

{
	const f = fakePi();
	hardcode(f.pi);
	assert.deepEqual(f.active(), ["session_shutdown", "session_start"], "only lifecycle listeners while off");
	await f.emit("session_start", { reason: "startup" }, f.ctx(tmp));
	assert.deepEqual(f.active(), ["session_shutdown", "session_start"], "still nothing after session start when off");
	assert.equal(f.state.statuses.size, 0);
	assert.equal(f.state.thinking, "medium");
	assert.equal(process.env.PI_HARDCODE_AGENTS, undefined);

	await f.commands.get("hardcode").handler("on", f.ctx(tmp));
	assert.deepEqual(f.active(), ["agent_before_settle", "before_agent_start", "input", "message_end", "session_shutdown", "session_start", "tool_result"]);
	assert.equal(
		f.state.statuses.get("hardcode"),
		"\x1b[48;2;255;255;255m 💀 \x1b[30mHARD\x1b[31mcode\x1b[39m \x1b[49m",
		"white background, 💀, HARD in black, code in red",
	);
	assert.equal(f.state.thinking, "xhigh");
	assert.equal(process.env.PI_HARDCODE_AGENTS, "policy");

	await f.commands.get("hardcode").handler("off", f.ctx(tmp));
	assert.deepEqual(f.active(), ["session_shutdown", "session_start"], "all policy hooks removed");
	assert.equal(f.state.statuses.get("hardcode"), undefined);
	assert.equal(f.state.thinking, "medium", "thinking restored");
	assert.equal(process.env.PI_HARDCODE_AGENTS, undefined);

	// Restored from the session on resume (new process; pi restores the session's saved xhigh level).
	await f.commands.get("hardcode").handler("on", f.ctx(tmp));
	const f2 = fakePi();
	f2.state.entries.push(...f.state.entries);
	f2.state.thinking = "xhigh";
	hardcode(f2.pi);
	await f2.emit("session_start", { reason: "resume" }, f2.ctx(tmp));
	assert.ok(f2.active().includes("agent_before_settle"), "mode restored on resume");
	await f2.commands.get("hardcode").handler("off", f2.ctx(tmp));
	assert.equal(f2.state.thinking, "medium", "turning off after resume restores the pre-HARDcode level");

	// Switching to another session in-process must not overwrite that session's thinking level.
	await f.commands.get("hardcode").handler("off", f.ctx(tmp));
	await f.commands.get("hardcode").handler("on", f.ctx(tmp));
	f.state.thinking = "high"; // the other session's saved level, applied by pi before session_start
	const otherSession: any[] = [];
	await f.emit("session_start", { reason: "resume" }, { ...f.ctx(tmp), sessionManager: { getBranch: () => otherSession } });
	assert.equal(f.state.thinking, "high", "other session keeps its own level");
	assert.deepEqual(f.active(), ["session_shutdown", "session_start"], "HARDcode off in a session that never enabled it");
	await f2.emit("session_shutdown", {}, f2.ctx(tmp));
}

// Editor badge: wraps the existing editor at the left of its top border, restored when off.
{
	const { withLeftBadge } = await import("../extensions/hardcode/index.ts");
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const border = "\x1b[38;5;203m" + "─".repeat(60) + " ⚡ultracode ─\x1b[39m";
	const badged = withLeftBadge(border, "\x1b[48;2;255;255;255m 💀 \x1b[30mHARD\x1b[31mcode\x1b[39m \x1b[49m");
	assert.equal(visibleWidth(badged), visibleWidth(border), "badge keeps the exact line width");
	assert.match(badged, /💀[\s\S]*HARD[\s\S]*code[\s\S]*⚡ultracode/);
	assert.equal(withLeftBadge("too short", "badge"), "too short");

	const f = fakePi();
	hardcode(f.pi);
	let factory: any = (_t: any, _th: any, _k: any) => ({ render: (w: number) => ["─".repeat(w), "typed text"] });
	const ultracodeFactory = factory;
	const ctx = { ...f.ctx(tmp), mode: "tui" };
	ctx.ui = { ...ctx.ui, getEditorComponent: () => factory, setEditorComponent: (x: any) => (factory = x) };
	await f.commands.get("hardcode").handler("on", ctx);
	assert.notEqual(factory, ultracodeFactory, "editor wrapped");
	const lines = factory(null, null, null).render(40);
	assert.match(lines[0], /^─.*💀.*HARD.*code/);
	assert.equal(visibleWidth(lines[0]), 40);
	assert.ok(!lines[0].includes("\x1b[48;"), "border badge has no background");
	assert.ok(f.state.statuses.get("hardcode")!.includes("\x1b[48;2;255;255;255m"), "status bar stays white");
	assert.equal(lines[1], "typed text");
	await f.commands.get("hardcode").handler("off", ctx);
	assert.equal(factory, ultracodeFactory, "original editor restored");
}

// Inside a workflow agent: nothing unless the parent asked for the policy.
{
	process.env.PI_ULTRACODE_DEPTH = "1";
	const f = fakePi();
	hardcode(f.pi);
	assert.deepEqual(f.active(), [], "workflow agent without policy: untouched");
	process.env.PI_HARDCODE_AGENTS = "policy";
	const g = fakePi();
	hardcode(g.pi);
	assert.deepEqual(g.active(), ["before_agent_start"]);
	const ev = { systemPromptOptions: { appendSystemPrompt: "" } };
	await g.emit("before_agent_start", ev, g.ctx(tmp));
	assert.match(ev.systemPromptOptions.appendSystemPrompt, /HARDcode \(workflow agent\)/);
	delete process.env.PI_ULTRACODE_DEPTH;
	delete process.env.PI_HARDCODE_AGENTS;
}

// ── command classification ─────────────────────────────────────────────────

const cls = (c: string) => classifyCommand(c);
assert.ok(cls("npm test").isCheck && cls("npm test").trustworthy);
assert.ok(cls("pnpm run typecheck").isCheck);
assert.ok(cls("cd pkg && npx vitest run src/a.test.ts").isCheck);
assert.ok(cls("cargo test --quiet").isCheck);
assert.ok(cls("CI=1 go test ./...").isCheck);
assert.ok(cls("python -m pytest -q tests/test_x.py").isCheck);
assert.ok(!cls("cat package.json").isCheck);
assert.ok(!cls("git status").isCheck);
assert.ok(!cls("npm install").isCheck);
assert.ok(!cls("grep -rn test src").isCheck);
assert.equal(cls("npm test || true").trustworthy, false);
assert.equal(cls("npm test 2>&1 | tail -20").trustworthy, false);
assert.equal(cls("set -o pipefail; npm test | tail -20").trustworthy, true);

// ── detection ──────────────────────────────────────────────────────────────

const proj = path.join(tmp, "proj");
fs.mkdirSync(proj);
fs.writeFileSync(
	path.join(proj, "package.json"),
	JSON.stringify({ scripts: { test: "node test.js", lint: "node -e 0", build: "node -e 0" } }),
);
assert.deepEqual(detectCommands(proj), ["npm run lint", "npm run build", "npm test"]);
fs.writeFileSync(path.join(proj, "pnpm-lock.yaml"), "");
assert.deepEqual(detectCommands(proj), ["pnpm lint", "pnpm build", "pnpm test"]);
fs.rmSync(path.join(proj, "pnpm-lock.yaml"));
const goProj = path.join(tmp, "goproj");
fs.mkdirSync(goProj);
fs.writeFileSync(path.join(goProj, "go.mod"), "module x");
assert.deepEqual(detectCommands(goProj), ["go vet ./...", "go test ./..."]);

// ── gate against a real git repo ───────────────────────────────────────────

fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
fs.writeFileSync(path.join(proj, "math.js"), "exports.add = (a, b) => a - b\n");
fs.writeFileSync(path.join(proj, "test.js"), "const a=require('./math').add(2,3); if (a!==5) { console.error('add(2,3)='+a); process.exit(1) }\n");
const sh = (cmd: string) => execFileSync("bash", ["-c", cmd], { cwd: proj, stdio: "pipe" });
sh("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init");

const { runCheck } = await import("../extensions/hardcode/checks.ts");
const cfg = { ...DEFAULTS, maxFixAttempts: 2, reviewer: "off" as const };
const env = (over: Partial<Parameters<typeof decide>[2]> = {}) => ({
	commands: ["npm test"],
	canAutoRun: true,
	lastAssistantText: "done",
	pendingWorkflows: 0,
	fingerprint: () => fingerprint(proj),
	runChecks: async (cmds: string[]) => Promise.all(cmds.map((c) => runCheck(c, proj, 60))),
	diff: () => ({ diff: "diff", changedLines: 10 }),
	review: async () => ({ ok: true, issues: [] }),
	...over,
});

{
	const c = new Cycle("fix add", fingerprint(proj));
	assert.equal((await decide(c, cfg, env())).action, "skip", "no changes → no gate");

	fs.writeFileSync(path.join(proj, "math.js"), "exports.add = (a, b) => a * b\n"); // still wrong
	let d = await decide(c, cfg, env());
	assert.equal(d.action, "continue");
	assert.match((d as any).message, /verification FAILED \(fix attempt 1\/2\)[\s\S]*add\(2,3\)=6/);
	assert.equal((await decide(c, cfg, env({ pendingWorkflows: 1 }))).action, "skip", "waits for workflows");

	fs.writeFileSync(path.join(proj, "math.js"), "exports.add = (a, b) => a - b + 0\n"); // different wrong
	d = await decide(c, cfg, env());
	assert.match((d as any).message, /fix attempt 2\/2/);

	fs.writeFileSync(path.join(proj, "math.js"), "exports.add = (a, b) => b - a\n");
	d = await decide(c, cfg, env());
	assert.equal(d.action, "continue");
	assert.match((d as any).message, /stopping the fix loop/, "gives up after maxFixAttempts");
	d = await decide(c, cfg, env());
	assert.deepEqual([d.action, (d as any).verified], ["settle", false]);
}

{
	sh("git checkout -q -- .");
	const c = new Cycle("fix add", fingerprint(proj));
	fs.writeFileSync(path.join(proj, "math.js"), "exports.add = (a, b) => a + b\n");
	let d = await decide(c, cfg, env());
	assert.match((d as any).message, /regression and edge-case audit/, "passing → self-audit once");
	d = await decide(c, cfg, env());
	assert.match((d as any).message, /Evidence/, "asks for the evidence report");
	d = await decide(c, cfg, env({ lastAssistantText: "Fixed.\n## Evidence\n- npm test ✓" }));
	assert.deepEqual([d.action, (d as any).verified], ["settle", true]);
	assert.equal(c.verifications.filter((v) => v.source === "auto").length, 1, "checks ran once for this state");
}

{
	// Reviewer findings send the agent back once.
	sh("git checkout -q -- .");
	const c = new Cycle("fix add", fingerprint(proj));
	fs.writeFileSync(path.join(proj, "math.js"), "exports.add = (a, b) => a + b\n");
	const reviewCfg = { ...cfg, reviewer: "on" as const, selfAudit: false, requireEvidence: false };
	const review = async () => ({ ok: true, issues: [{ severity: "high" as const, file: "math.js", problem: "no input validation" }] });
	let d = await decide(c, reviewCfg, env({ review }));
	assert.match((d as any).message, /fresh reviewer[\s\S]*no input validation/);
	d = await decide(c, reviewCfg, env({ review }));
	assert.deepEqual([d.action, (d as any).verified], ["settle", true], "one review round by default");
}

{
	// Agent mode: the agent must verify; masked exit codes don't count.
	sh("git checkout -q -- .");
	const agentCfg = { ...cfg, verify: "agent" as const, selfAudit: false, requireEvidence: false };
	const c = new Cycle("fix add", fingerprint(proj));
	fs.writeFileSync(path.join(proj, "math.js"), "exports.add = (a, b) => a + b\n");
	let d = await decide(c, agentCfg, env());
	assert.match((d as any).message, /no passing verification/);
	c.seq++;
	c.verifications.push({ command: "npm test | tail", ok: true, exitCode: 0, timedOut: false, durationMs: 0, tail: "", trustworthy: false, source: "agent", fp: fingerprint(proj), seq: c.seq });
	d = await decide(c, agentCfg, env());
	assert.match((d as any).message, /reminder 2\/2[\s\S]*must not be masked/);
	c.seq++;
	c.verifications.push({ command: "npm test", ok: true, exitCode: 0, timedOut: false, durationMs: 0, tail: "", trustworthy: true, source: "agent", fp: fingerprint(proj), seq: c.seq });
	d = await decide(c, agentCfg, env());
	assert.deepEqual([d.action, (d as any).verified], ["settle", true]);
}

// ── end to end through the fake pi: settle handler appends a gate message and continues ──

{
	sh("git checkout -q -- .");
	const f = fakePi();
	hardcode(f.pi);
	const ctx = f.ctx(proj);
	await f.emit("session_start", { reason: "startup" }, ctx);
	await f.commands.get("hardcode").handler("on", ctx);
	await f.emit("input", { text: "fix add", source: "interactive" }, ctx);
	const ev = { systemPromptOptions: { appendSystemPrompt: "" }, prompt: "fix add" };
	await f.emit("before_agent_start", ev, ctx);
	assert.match(ev.systemPromptOptions.appendSystemPrompt, /HARDcode — maximum-effort execution policy[\s\S]*`npm test`/);
	fs.writeFileSync(path.join(proj, "math.js"), "exports.add = (a, b) => a * b\n");
	await f.emit("tool_result", { toolName: "edit", input: {}, content: [], isError: false }, ctx);
	const settle = { outcome: "completed", entries: [], continue: false, context: { contextMessages: [] } };
	const res = await f.emit("agent_before_settle", settle, ctx);
	assert.equal(res.continue, true);
	assert.equal(res.entries[0].customType, "hardcode-gate");
	assert.match(res.entries[0].content, /verification FAILED/);

	// A background UltraCode workflow: no gate until its result arrives, then a fresh budget.
	await f.emit("tool_result", { toolName: "workflow", input: {}, content: [], isError: false, details: { runId: "w1", background: true } }, ctx);
	assert.equal(await f.emit("agent_before_settle", settle, ctx), undefined, "skips while the workflow runs");
	await f.emit("message_end", { message: { role: "custom", customType: "ultracode-result", details: { id: "w1" } } }, ctx);
	fs.writeFileSync(path.join(proj, "math.js"), "exports.add = (a, b) => a + b\n");
	const res2 = await f.emit("agent_before_settle", settle, ctx);
	assert.match(res2.entries[0].content, /edge-case audit/, "workflow result verified through the cycle");
	await f.commands.get("hardcode").handler("off", ctx);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok");
