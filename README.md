# pi-hardcode

**HARDcode** is a maximum-effort mode for [pi](https://pi.dev). It is built for depth, persistence and verification: the agent investigates before editing, implements completely, runs the project's checks, fixes what fails, and claims success only with evidence.

HARDcode is an **execution/policy layer, not an orchestrator**. It works with plain pi, and it composes with [pi-ultracode](https://github.com/rebehzat/pi-ultracode): UltraCode supplies the parallel breadth, and HARDcode puts the resulting work through the verification and fix cycle.

## Install

```bash
pi install git:github.com/rebehzat/pi-hardcode
```

## Use

| | |
|---|---|
| `/hardcode` | Toggle it for this session. `/hardcode on` or `/hardcode off` set it explicitly. The setting is restored when you resume the session. |
| `/hardcode status` | Shows whether it is on, the detected checks, the limits, and the current task's state: checks recorded, fix attempts, and the last gate decision. |
| `/hardcode config [key [value]]` | Shows or sets a value in `~/.pi/agent/hardcode.json`. `value` is parsed as JSON; `default` removes the key. |
| `pi --hardcode` | Starts with HARDcode on. |

While it is on, the status bar shows **💪 HARDcode**, with `HARD` in white and `code` in red. The same badge sits at the left end of the input box's top border (mirroring UltraCode's `⚡ultracode` on the right). HARDcode wraps whatever editor is installed, so the two badges coexist, and restores the original editor when turned off.

## What happens when it's on

1. **Policy.** HARDcode appends rules to the system prompt: investigate the code paths, callers, tests and build first; implement completely (no stubs or TODOs); add tests; never weaken or skip checks, and never mask exit codes; diagnose failures rather than retrying blindly; hunt for regressions; finish with an **Evidence** section. Your thinking level is left as it is, unless you set the `thinking` config key.
2. **Gate.** When the agent finishes a run that changed files (detected with a git working-tree fingerprint, or from edit tool calls outside git), HARDcode steps in before pi settles:
   - **Run checks.** It runs the project's checks itself, detected from package scripts (typecheck → lint → build → test), Cargo, Go, pytest/ruff/mypy, or a Makefile. It runs them once per state of the code and stops at the first failure.
   - **Failure → fix.** Failing output goes back to the agent with instructions to diagnose and fix. If the identical failure repeats, the agent is told its approach isn't working.
   - **No evidence → verify.** In `agent` mode, or when no checks were detected, the agent must run the checks itself. Its `bash` check commands are recorded, and only unmasked exit codes count: `npm test | tail` or `|| true` do not.
   - **Fresh reviewer (optional).** A separate read-only pi process reviews the diff. It sees only the task and the diff, not the conversation. High- and medium-severity findings go back to the agent.
   - **Edge-case audit.** Once per task, after checks pass, the agent audits the whole diff for regressions and missing tests.
   - **Evidence.** The final report must include evidence. The result is recorded in the transcript as **✓ HARDcode verified** or **✗ HARDcode NOT verified**, listing the checks.
3. **Limits.** Fix attempts, verification reminders, repeated identical failures and total continuations are all capped. When a limit is hit, the agent is told to stop and report honestly what is still failing, and the task is marked NOT verified. It cannot loop forever.

Aborted or errored runs are never gated.

## With UltraCode

- **Waiting for workflows:** while a background workflow is running, the gate doesn't fire. When the workflow's result arrives, those changes go through the full cycle with a fresh budget.
- **Main agent:** the policy tells it to end change-making workflow scripts with a verification phase, and not to let parallel agents run full test suites at the same time.
- **Workflow agents:** they get a light depth policy through `PI_HARDCODE_AGENTS=policy`: investigate, implement fully, verify their own part cheaply, and report exactly what was verified. The gate doesn't run inside them, so parallel agents don't fight over the working tree. Set `workflowAgents` to `"off"` to disable this.
- **Thinking level:** HARDcode doesn't lower thinking that UltraCode raised when you turn HARDcode off.

## Off means off

With HARDcode disabled, no policy hooks, prompt text, tools, editor changes or status are installed, and no environment variable is set. The hooks are subscribed when you turn it on and unsubscribed when you turn it off. What stays registered is `/hardcode`, the `--hardcode` flag, renderers for HARDcode's own transcript entries, and session start and shutdown listeners that restore the mode. The test suite asserts this.

## 🌸 SoftCode

The same package includes **SoftCode**, HARDcode's opposite: a light-touch mode for quick, cheap work. It needs HARDcode off; turning one on while the other is on is refused with a message.

| | |
|---|---|
| `/softcode` | Toggle it. `/softcode on`, `/softcode off`, `/softcode status`, `/softcode config [key [value]]` work like HARDcode's. Restored when you resume the session. |
| `pi --softcode` | Starts with SoftCode on. |

While it is on:

- **Light-touch policy:** read only the files the task needs, make the smallest change that does the job (no refactors, renames or unrequested tests), verify with at most one quick targeted check, and keep answers short. It still flags risky or unclear things in a line.
- **Explains as it goes:** one short sentence before each tool call saying what and why, and one or two sentences after each file change. Turn it off with `explain: false`.
- **Lower thinking:** thinking drops to at most `low` (never raised) and goes back when SoftCode is turned off.
- **With UltraCode:** the main agent keeps workflows small, and workflow agents get a short light-touch policy (`PI_SOFTCODE_AGENTS=policy`).
- **Status:** **🌸 SoftCode** in pink in the status bar and at the left end of the input box's border.

Off means off here too: only `/softcode`, `--softcode`, and the session start and shutdown listeners stay registered.

`~/.pi/agent/softcode.json` (a trusted project's `.pi/softcode.json` overrides it):

| Key | Default | |
|---|---|---|
| `enabled` | `false` | Start every session with SoftCode on (skipped if HARDcode is on). |
| `thinking` | `"low"` | Lower thinking to at most this level: `off`, `minimal`, `low`, `medium`, or `keep` to leave it alone. |
| `explain` | `true` | Explain each step and change in plain language. |
| `workflowAgents` | `"policy"` | Light-touch policy inside UltraCode workflow agents, or `"off"`. |

## Config

`~/.pi/agent/hardcode.json` (all keys optional). A trusted project's `.pi/hardcode.json` overrides it.

| Key | Default | |
|---|---|---|
| `enabled` | `false` | Start every session with HARDcode on. |
| `thinking` | `"keep"` | `keep` leaves your thinking level alone. `high`, `xhigh` or `max` raise it to at least that level while HARDcode is on, and never lower it. |
| `verify` | `"auto"` | `auto`: HARDcode runs the checks. `agent`: the agent must run them. `off`: the prompt policy only. |
| `verifyCommands` | `[]` | Explicit checks, e.g. `["npm run typecheck","npm test"]`. Empty means detect them. |
| `commandTimeoutSec` | `900` | Timeout for each auto-run check. |
| `maxFixAttempts` | `4` | Fix → re-verify rounds before giving up. |
| `maxVerifyNudges` | `2` | Reminders to verify before giving up. |
| `maxSameFailure` | `2` | "Change your approach" warnings for an identical repeated failure before giving up. |
| `maxContinuations` | `10` | Hard cap on HARDcode continuations per task. |
| `selfAudit` | `true` | One edge-case and regression audit per task. |
| `requireEvidence` | `true` | Require an Evidence section in the final report. |
| `reviewer` | `"off"` | Fresh reviewer: `off`, `on`, or `auto` (diffs of at least `reviewerMinChangedLines` changed lines). |
| `reviewerMinChangedLines` | `80` | |
| `reviewerModel` | session model | e.g. `"anthropic/claude-sonnet-5"` |
| `reviewerThinking` | `"high"` | |
| `maxReviewRounds` | `1` | |
| `workflowAgents` | `"policy"` | Depth policy inside UltraCode workflow agents, or `"off"`. |
| `statusBackground` | `"none"` | Background for the status label: `"none"`, or any hex color such as `"#303030"`. |

Auto-run checks run with `CI=1` (so test runners don't start watch mode), in their own process group, killed on timeout or when you abort.

## Development

```bash
npm install
npm run typecheck
npm test        # off-means-off (HARDcode and SoftCode), classification, detection, and the gate against a real temp git repo
pi --no-extensions -e ./extensions/hardcode   # try it in isolation
```

## License

MIT
