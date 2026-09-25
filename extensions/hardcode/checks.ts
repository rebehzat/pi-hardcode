/**
 * Verification checks: detect the project's check commands, recognise check
 * commands the agent runs itself, run checks, and fingerprint the working tree
 * so "verified" can be tied to an exact state of the code.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ── detection ──────────────────────────────────────────────────────────────

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function packageRunner(dir: string): string {
	if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
	if (fs.existsSync(path.join(dir, "bun.lockb")) || fs.existsSync(path.join(dir, "bun.lock"))) return "bun run";
	return "npm run";
}

/** Check commands for a project directory, cheapest first: typecheck → lint → build → test. */
export function detectCommands(dir: string): string[] {
	const out: string[] = [];

	const pkgText = readText(path.join(dir, "package.json"));
	if (pkgText) {
		try {
			const scripts: Record<string, string> = JSON.parse(pkgText).scripts ?? {};
			const run = packageRunner(dir);
			const pick = (...names: string[]) => names.find((n) => typeof scripts[n] === "string");
			const typecheck = pick("typecheck", "type-check", "check-types", "tsc");
			const lint = pick("lint");
			const build = pick("build");
			const test = pick("test");
			if (typecheck) out.push(`${run} ${typecheck}`);
			else if (fs.existsSync(path.join(dir, "tsconfig.json"))) out.push("npx --no-install tsc --noEmit");
			if (lint) out.push(`${run} ${lint}`);
			if (build) out.push(`${run} ${build}`);
			if (test && !/no test specified/.test(scripts[test]!)) out.push(run === "npm run" ? "npm test" : `${run} test`);
		} catch {}
	}

	if (fs.existsSync(path.join(dir, "Cargo.toml"))) out.push("cargo test --quiet");

	if (fs.existsSync(path.join(dir, "go.mod"))) out.push("go vet ./...", "go test ./...");

	const pyproject = readText(path.join(dir, "pyproject.toml")) ?? "";
	const hasPytest =
		/pytest/.test(pyproject) ||
		fs.existsSync(path.join(dir, "pytest.ini")) ||
		/\[tool:pytest\]/.test(readText(path.join(dir, "setup.cfg")) ?? "") ||
		fs.existsSync(path.join(dir, "tests")) && (pyproject !== "" || fs.existsSync(path.join(dir, "setup.py")));
	if (/\[tool\.ruff/.test(pyproject)) out.push("ruff check .");
	if (/\[tool\.mypy/.test(pyproject)) out.push("mypy .");
	if (hasPytest) out.push("python -m pytest -q");

	if (!out.length) {
		const makefile = readText(path.join(dir, "Makefile")) ?? readText(path.join(dir, "makefile"));
		if (makefile) {
			if (/^check:/m.test(makefile)) out.push("make check");
			if (/^test:/m.test(makefile)) out.push("make test");
		}
	}
	return out;
}

// ── classification of agent-run commands ───────────────────────────────────

const CHECK_TOOLS =
	/^(?:jest|vitest|mocha|ava|tap|playwright|cypress|pytest|tox|nox|mypy|pyright|ruff|flake8|pylint|eslint|biome|oxlint|tsc|vue-tsc|svelte-check|prettier\s+--check|rspec|phpunit|ctest|gradle\w*|\.\/gradlew|mvn|dotnet\s+(?:test|build)|swift\s+(?:test|build)|zig\s+(?:build|test)|deno\s+(?:test|check|lint)|bun\s+test|cargo\s+(?:test|check|clippy|build|nextest)|go\s+(?:test|vet|build)|make(?:\s+\S+)?|just\s+\S+|python\d*\s+-m\s+(?:pytest|unittest|mypy)|node\s+--test)\b/;
const SCRIPT_RUN = /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([\w:.-]+)/;
const SCRIPT_NAME = /(?:^|[:.-])(?:test|tests|spec|e2e|lint|check|typecheck|type-check|tsc|build|verify|ci)(?:$|[:.-])/;

/** Split a shell command into simple command segments (good enough for classification). */
function segments(command: string): string[] {
	return command
		.split(/&&|\|\|?|;|\n/)
		.map((s) => s.trim())
		.map((s) => s.replace(/^(?:\w+=\S*\s+)+/, "")) // leading VAR=value
		.map((s) => s.replace(/^(?:npx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx)|bunx|uv\s+run|poetry\s+run|pipenv\s+run)\s+(?:--\S+\s+)*/, ""))
		.filter(Boolean);
}

export interface CommandClass {
	isCheck: boolean;
	/** False when the exit status cannot be trusted (pipes without pipefail, `|| true`, …). */
	trustworthy: boolean;
}

export function classifyCommand(command: string): CommandClass {
	const isCheck = segments(command).some((seg) => {
		if (CHECK_TOOLS.test(seg)) return true;
		const script = SCRIPT_RUN.exec(seg)?.[1];
		return !!script && SCRIPT_NAME.test(script);
	});
	const masked =
		/\|\|\s*(?:true|:|exit\s+0|echo)\b/.test(command) ||
		(/(?<!\|)\|(?!\|)/.test(command) && !/set\s+-o\s+pipefail|pipefail/.test(command)) ||
		/;\s*(?:true|exit\s+0)\s*$/.test(command);
	return { isCheck, trustworthy: !masked };
}

// ── running checks ─────────────────────────────────────────────────────────

export interface CheckRun {
	command: string;
	ok: boolean;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	/** Last part of combined stdout/stderr. */
	tail: string;
}

const TAIL_BYTES = 6000;

export function runCheck(command: string, cwd: string, timeoutSec: number, signal?: AbortSignal): Promise<CheckRun> {
	const started = Date.now();
	return new Promise((resolve) => {
		const proc = spawn("bash", ["-lc", command], {
			cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
		});
		let output = "";
		let timedOut = false;
		const collect = (d: Buffer) => {
			output += d.toString();
			if (output.length > TAIL_BYTES * 4) output = output.slice(-TAIL_BYTES * 2);
		};
		proc.stdout.on("data", collect);
		proc.stderr.on("data", collect);
		const killTree = () => {
			try {
				process.kill(-proc.pid!, "SIGTERM");
				setTimeout(() => {
					try {
						process.kill(-proc.pid!, "SIGKILL");
					} catch {}
				}, 3000).unref();
			} catch {}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, timeoutSec * 1000);
		signal?.addEventListener("abort", killTree, { once: true });
		const done = (exitCode: number | null) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", killTree);
			resolve({
				command,
				ok: exitCode === 0 && !timedOut,
				exitCode,
				timedOut,
				durationMs: Date.now() - started,
				tail: output.slice(-TAIL_BYTES).trim(),
			});
		};
		proc.on("close", (code) => done(code));
		proc.on("error", (err) => {
			output += String(err);
			done(null);
		});
	});
}

/** Stable-ish signature of a failure, used to notice the same failure repeating. */
export function failureSignature(run: Pick<CheckRun, "command" | "tail">): string {
	const normalized = run.tail
		.replace(/\d+(\.\d+)?\s*m?s\b/g, "") // durations
		.replace(/0x[0-9a-f]+/gi, "")
		.replace(/\s+/g, " ")
		.slice(-2000);
	return createHash("sha1").update(run.command).update(normalized).digest("hex").slice(0, 16);
}

// ── working tree fingerprint ───────────────────────────────────────────────

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

export function gitRoot(cwd: string): string | undefined {
	return git(cwd, ["rev-parse", "--show-toplevel"])?.trim() || undefined;
}

/** Hash of HEAD + tracked diff + untracked files (path, size, mtime). Undefined outside git. */
export function fingerprint(cwd: string): string | undefined {
	const root = gitRoot(cwd);
	if (!root) return undefined;
	const h = createHash("sha1");
	h.update(git(root, ["rev-parse", "HEAD"]) ?? "no-head");
	h.update(git(root, ["diff", "HEAD", "--no-ext-diff", "--binary"]) ?? git(root, ["diff", "--no-ext-diff", "--binary"]) ?? "");
	for (const file of (git(root, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "").split("\0")) {
		if (!file) continue;
		try {
			const st = fs.statSync(path.join(root, file));
			h.update(`${file}:${st.size}:${st.mtimeMs}\n`);
		} catch {}
	}
	return h.digest("hex");
}

/** Unified diff of the working tree against HEAD, including untracked files, for the reviewer. */
export function workingDiff(cwd: string, maxChars: number): { diff: string; changedLines: number } {
	const root = gitRoot(cwd);
	if (!root) return { diff: "", changedLines: 0 };
	let diff = git(root, ["diff", "HEAD", "--no-ext-diff"]) ?? "";
	for (const file of (git(root, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "").split("\0").filter(Boolean)) {
		const content = readText(path.join(root, file));
		if (content === undefined || content.length > 100_000) continue;
		diff += `\n--- /dev/null\n+++ b/${file}\n${content
			.split("\n")
			.map((l) => `+${l}`)
			.join("\n")}\n`;
	}
	const changedLines = diff.split("\n").filter((l) => /^[+-](?![+-]{2})/.test(l)).length;
	return { diff: diff.length > maxChars ? `${diff.slice(0, maxChars)}\n… [diff truncated]` : diff, changedLines };
}
