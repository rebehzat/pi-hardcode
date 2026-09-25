/**
 * Fresh reviewer: a separate read-only pi process that sees only the task and
 * the diff (not the conversation) and reports concrete problems as JSON.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CHILD_ENV = "PI_HARDCODE_CHILD";

export interface ReviewIssue {
	severity: "high" | "medium" | "low";
	file?: string;
	line?: number;
	problem: string;
	fix?: string;
}

export interface ReviewResult {
	ok: boolean;
	issues: ReviewIssue[];
	summary?: string;
	error?: string;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function extractJson(text: string): any {
	const t = text.trim();
	const candidates = [t, ...[...t.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!)];
	const first = t.indexOf("{");
	const last = t.lastIndexOf("}");
	if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));
	for (const c of candidates) {
		try {
			return JSON.parse(c);
		} catch {}
	}
	return undefined;
}

export function reviewPrompt(task: string, diff: string, checks: string): string {
	return `You are a fresh, skeptical code reviewer. You did not write this change. Find real defects before it ships.

## Task the change was meant to accomplish
${task || "(not recorded)"}

## Checks already run
${checks || "(none)"}

## Diff (working tree vs HEAD)
\`\`\`diff
${diff}
\`\`\`

Read the surrounding code with your tools where needed. Look for: incorrect logic, unhandled edge cases (empty/null/large inputs, errors, concurrency), regressions to existing behaviour or callers, missing or weakened tests, incomplete implementation (TODOs, stubs, partially applied changes), and anything the task asked for that is missing. Do not report style nits or speculative concerns you cannot point to in the code.

Final message: ONLY this JSON, no prose:
{"summary": "one sentence", "issues": [{"severity": "high|medium|low", "file": "path", "line": 123, "problem": "what is wrong and why", "fix": "concrete fix"}]}
Use an empty issues array if the change is correct.`;
}

export async function runReviewer(opts: {
	task: string;
	diff: string;
	checks: string;
	cwd: string;
	model?: string;
	thinking?: string;
	signal?: AbortSignal;
}): Promise<ReviewResult> {
	const args = ["--mode", "json", "-p", "--no-session", "--tools", "read,grep,find,ls"];
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	const prompt = reviewPrompt(opts.task, opts.diff, opts.checks);
	let promptFile: string | undefined;
	if (Buffer.byteLength(prompt) > 100_000) {
		promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hardcode-review-")), "review.md");
		fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
		args.push(`@${promptFile}`, "Carry out the review described in the attached file.");
	} else args.push(prompt);

	return new Promise((resolve) => {
		const inv = piInvocation(args);
		// The reviewer must not run HARDcode or UltraCode itself.
		const proc = spawn(inv.command, inv.args, {
			cwd: opts.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, [CHILD_ENV]: "reviewer", PI_HARDCODE_AGENTS: "", PI_ULTRACODE_DEPTH: "1" },
		});
		let buffer = "";
		let lastText = "";
		let stderr = "";
		proc.stdout.on("data", (d) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const e = JSON.parse(line);
					if (e.type === "message_end" && e.message?.role === "assistant") {
						const text = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
						if (text) lastText = text;
					}
				} catch {}
			}
		});
		proc.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-4000)));
		const kill = () => proc.kill("SIGTERM");
		opts.signal?.addEventListener("abort", kill, { once: true });
		proc.on("close", (code) => {
			opts.signal?.removeEventListener("abort", kill);
			if (promptFile) fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
			const parsed = extractJson(lastText);
			if (!parsed || !Array.isArray(parsed.issues)) {
				resolve({ ok: false, issues: [], error: code === 0 ? "reviewer returned no parseable JSON" : stderr.trim() || `exit ${code}` });
				return;
			}
			const issues: ReviewIssue[] = parsed.issues
				.filter((i: any) => i && typeof i.problem === "string")
				.map((i: any) => ({ ...i, severity: ["high", "medium", "low"].includes(i.severity) ? i.severity : "medium" }));
			resolve({ ok: true, issues, summary: typeof parsed.summary === "string" ? parsed.summary : undefined });
		});
		proc.on("error", (err) => resolve({ ok: false, issues: [], error: err.message }));
	});
}
