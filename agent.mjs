#!/usr/bin/env node
/**
 * ai-agent.mjs — minimal, fully-working, self-learning terminal AI agent.
 * Node >= 18, ZERO dependencies (stdlib only).
 *
 * v2.12.1 — bug-fix release: the agent no longer stops productive runs as "loops", and no
 *            longer gets stuck in real ones.
 *   - Loop detection rewritten. The old tool-call signature collapsed every nested argument
 *     (so all update_plan status flips looked identical) and the old "content"/"dominated"
 *     heuristics flagged normal work (same "Let me check." before different calls, running
 *     the tests 4x between fixes). Detection is now result-aware: the same call giving the
 *     same answer with nothing changed in between, verbatim response resends, or A-B-A-B
 *     cycles with identical results.
 *   - Completion gate: update_plan no longer resets the nudge counter (that made the
 *     "NOT DONE YET" follow-up unbounded); progress earns more patience, with a hard cap.
 *     Plan mode never nudges (open tasks are its expected end state).
 *   - str_replace: new_str containing $&, $', $$ … was spliced through String.replace and
 *     corrupted files; files containing the word "truncated" could not be edited at all;
 *     trailing-whitespace-only mismatches now match; no-op edits are reported.
 *   - Secret redaction was rewriting ordinary code before the model saw it (token: string,
 *     pwd = process.cwd(), PWD=/home/…, authorization: Bearer …) — a coding agent cannot work
 *     on code it cannot read. Values are masked only when they look like secrets; dummies
 *     are never masked twice; minimum dummy length raised so restore cannot hit real content.
 *   - Transcript consistency: ctrl+c mid-batch, loop stops and failure stops left tool_calls
 *     without results, after which every request failed with HTTP 400. Every call now gets a
 *     result; histories are repaired before each request and after errors.
 *   - shell: commands are spawned in their own process group and the whole tree is killed
 *     on timeout/ctrl+c (killing `sh -c` alone left `sleep`/servers holding the pipes);
 *     malformed JSON arguments are no longer executed as a command.
 *   - Context: a context overflow no longer permanently shrinks the saved context setting;
 *     trimming keeps the current request and shortens old tool output first.
 *   - Streaming: replies are routed by content-type (a JSON body to a stream request was
 *     silently dropped line by line); "tools unsupported" fallback is per-session and no
 *     longer persists tools=false; history-shape 400s are repaired and retried.
 *   - MCP: legacy SSE transport actually works (responses arrive as SSE `message` events,
 *     POST is only acknowledged); `eventsource` is loaded on demand; tool names are
 *     sanitized for the function-name charset; curl/wget to localhost is never blocked and
 *     non-search MCP servers no longer block curl at all.
 *   - System prompt tells the model the real shell (POSIX vs cmd.exe) instead of always
 *     "cmd-style"; read-only command detection understands redirections and chains.
 *
 * v2.12.0 — v2.11.0 + configurable streaming:
 *   - `/set stream <on|off>` (default on) — also `--stream on|off` / `--no-stream` and
 *     env AI_STREAM. When off, the model endpoint is called with `"stream": false` and the
 *     single JSON reply is parsed natively (content, reasoning, tool_calls, usage), so
 *     OpenAI-compatible servers that don't do SSE (e.g. vLLM/LM Studio at localhost:8000)
 *     work with a plain curl-style request.
 *   - In stream mode nothing changes, and a server that replies with JSON anyway is still
 *     handled by the existing fallback.
 *
 * v2.11.0 — v2.10.0 + goal → tasks → follow-up loop:
 *   - `update_plan` tool: the agent turns the prompt into one explicit GOAL and 3-12
 *     verifiable TASKS, each with a `verify` check that proves it works.
 *   - The plan is re-rendered into the system prompt on every model call, so the model
 *     always sees its own progress, and a live checklist is printed in the terminal.
 *   - Completion gate: the agent cannot end a turn while tasks are pending or while
 *     "done" tasks were never verified — it gets pushed back (max 2x) to finish the work.
 *   - Round-trip minimisation: batched tool calls are enforced by prompt rules, read_file
 *     takes `paths[]` to grab several files in one call, and each request reports the
 *     round trips / tool calls it cost.
 *   - /plan shows the goal + checklist; /plan goal <text> sets one yourself; /plan clear resets.
 *   - /set autoplan <on|off> (default on) turns auto goal/task creation off entirely;
 *     an explicit `/plan goal <text>` still opts back in for that goal.
 *
 * v2.10.0 — v2.9.0 + loop detection:
 *   - Detects when the model repeats the same text output or tool calls
 *   - Catches exact repeats, cycling patterns (A-B-A-B), and dominated sequences
 *   - Stops gracefully with a message instead of burning tokens forever
 *   - Stronger system prompt rules against repetition
 *
 * v2.9.0 — v2.8.0 + fully SILENT secret redaction:
 *   - Real secrets are replaced with length-preserving dummy tokens (min 4 chars)
 *     in every tool result the model sees. No markers, no disclosure anywhere in
 *     the system prompt, HELP, or /config — the model never knows redaction exists.
 *   - On write_file/str_replace, dummies are silently restored to the real values
 *     from ~/.aiterm/secrets.json, so files on disk always contain real content.
 *   - secrets.json is locked: read attempts get a plausible "file not found",
 *     writes are rejected — the model can never discover the dummy->real mapping.
 *
 * Everything from v2.8.0 is intact: Copilot methodology, 3-strike guard,
 * ~/.aiterm data folder + migration, MCP client, unlimited tool steps,
 * tool-call repair/retry/context-trim, project folder (--dir), spinner,
 * token/context usage, context auto-detect, str_replace, sessions,
 * @file autocomplete, OS command ledger, self-learning memory,
 * execution interception, command-policy blocklist, draft model,
 * temperature, reasoning level, /compact, loop detection.
 *
 * quick start:
 *   node ai-agent.mjs                                     # first-run setup wizard
 *   node ai-agent.mjs --url ollama --model llama3.1 --dir ~/myproj
 *   node ai-agent.mjs --model qwen3-coder --reasoning high --temperature 0.2
 *   node ai-agent.mjs --intercept "clean up the build"
 *   node ai-agent.mjs "summarize this repo"               # one-shot
 *   echo "list large files" | node ai-agent.mjs           # piped one-shot
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const VERSION = "2.12.1";

// EventSource is only needed for MCP servers using the legacy SSE transport. Node has no
// built-in one, so it is loaded on demand — a missing `eventsource` package must not stop
// the agent from starting.
async function loadEventSource() {
  if (typeof globalThis.EventSource === "function") return globalThis.EventSource;
  try { return (await import("eventsource")).EventSource; }
  catch { throw new Error("SSE transport needs the 'eventsource' package (npm install eventsource) or use \"type\": \"http\""); }
}

// ------------------------------------------------------------------ data folder
const DATA_DIR = path.join(os.homedir(), ".aiterm");
const CFG_PATH = path.join(DATA_DIR, "config.json");
const MCP_PATH = path.join(DATA_DIR, "mcp.json");
const MEM_PATH = path.join(DATA_DIR, "memory.json");
const CMD_LEDGER_PATH = path.join(DATA_DIR, "commands.json");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const SECRETS_PATH = path.join(DATA_DIR, "secrets.json");

function initDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
  migrateOldData();
}
function migrateOldData() {
  const moves = [
    [path.join(os.homedir(), ".aiterm.json"), CFG_PATH],
    [path.join(os.homedir(), ".aiterm-commands.json"), CMD_LEDGER_PATH],
    [path.join(os.homedir(), ".aiterm-memory.json"), MEM_PATH],
    [path.join(os.homedir(), ".aiterm-mcp.json"), MCP_PATH],
  ];
  for (const [from, to] of moves) {
    try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to); } catch {}
  }
  const oldDir = path.join(os.homedir(), ".aiterm-sessions");
  try {
    if (fs.existsSync(oldDir) && fs.statSync(oldDir).isDirectory()) {
      for (const f of fs.readdirSync(oldDir)) {
        try {
          const from = path.join(oldDir, f), to = path.join(SESSIONS_DIR, f);
          if (!fs.existsSync(to)) fs.renameSync(from, to);
        } catch {}
      }
      try { if (!fs.readdirSync(oldDir).length) fs.rmdirSync(oldDir); } catch {}
    }
  } catch {}
}

const PROMPT = "❯ ", CONT = "· ";

const ALIASES = {
  openai: "https://api.openai.com/v1",
  ollama: "http://localhost:11434/v1",
  openrouter: "https://openrouter.ai/api/v1",
  lmstudio: "http://localhost:1234/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  together: "https://api.together.xyz/v1",
};

// ------------------------------------------------------------------ agent methodology
const SYS_PROMPT =
  "You are an expert autonomous software-engineering agent with deep knowledge across programming languages and frameworks, operating in the user's project via a terminal.\n" +
  "The user gives you a task; work autonomously, using tools repeatedly until it is fully complete. Do not give up unless you are certain it cannot be done with the available tools.\n" +
  "Do not stop to ask permission or ask clarifying questions mid-task: pick the most reasonable interpretation, state the assumption in one line, and keep going.\n" +
  "\n" +
  "WORK METHOD — goal, then tasks, then execution, then proof:\n" +
  "1. SET THE GOAL: restate the user's prompt as one sentence describing the OUTCOME they want (not the steps). That sentence goes into `update_plan`.\n" +
  "2. PLAN AS TASKS: for any request needing >1 step or any file change, call `update_plan` FIRST with the goal and 3-12 concrete, individually verifiable tasks. Give each task a `verify` — the command or check that proves it works. Skip the plan only for a pure question or a single trivial edit.\n" +
  "3. UNDERSTAND FIRST: infer the project type (language, framework, libraries) from the task and files. Explore before changing. Never assume — gather context, then act.\n" +
  "4. WORK ONE TASK AT A TIME: mark it in_progress, do it, verify it, mark it done, then move to the next. Update the plan as you go so the list always matches reality.\n" +
  "5. MINIMISE ROUND TRIPS: issue every independent tool call in ONE response — read all the files you need together (or pass `paths` to read_file), run exploration commands chained with && , and never make a call whose result you could have obtained in the same batch. Do not re-read a file you just wrote, and do not re-run a command that already succeeded.\n" +
  "6. GATHER CONTEXT EFFICIENTLY: prefer reading large meaningful chunks over many small reads. Use `shell` (grep/find/rg/dir) to locate code instead of guessing.\n" +
  "7. EDIT CORRECTLY: use `str_replace` for targeted edits (exact match); use `write_file` only for new files or full rewrites (full content, never placeholders). Follow existing conventions — indentation, style, naming, framework versions.\n" +
  "8. USE ESTABLISHED LIBRARIES: if a well-known package solves a problem, install it properly (npm/pip/etc.) rather than reimplementing it.\n" +
  "9. OMITTED CONTENT: if context shows an omission marker (e.g. '...lines omitted...'), read the real content before editing; never pass the marker into an edit.\n" +
  "10. VERIFY AND FOLLOW UP: run the build/tests/linters named in your tasks' `verify` fields and confirm they actually pass. A task is done only when its check passed — never mark done on intent. If a check fails, fix it in the same turn.\n" +
  "11. CLOSE OUT: do not end while tasks are pending. Every task ends as done, blocked (with a reason) or skipped (with a reason).\n" +
  "12. ERROR LIMIT: if the same fix fails repeatedly, mark that task blocked with the reason, finish everything else, then explain the blocker + options to the user instead of looping.\n" +
  "13. ITERATE WITHOUT REPEATING: after each tool call, continue from where you left off. NEVER repeat the same tool call with the same arguments. NEVER output the same text twice in a row. If you notice you're going in circles, STOP and explain what's happening.\n" +
  "\n" +
  "SHELLS: use background=true for dev servers/watchers; PowerShell is blocked.\n" +
  "NO COMMENTS: never add filler/explanatory comments to code unless asked.\n" +
  "MEMORY: use `remember` to persist lessons/preferences/workarounds; check recalled memories for past solutions to similar problems.\n" +
  "SAFETY: avoid destructive commands unless clearly required; never hardcode secrets; refuse harmful/illegal requests briefly.\n" +
  "TERSE: no preamble, no restating, no apologies.\n" +
  "FINISH: when the plan is closed out, reply with a 1-3 line summary of what changed and how it was validated.\n"+
  "TOOLS: tool calls should be in json format not xml.";

const MAX_FAIL_STREAK = 3;

// ------------------------------------------------------------------ loop detection
// A "loop" is the model repeating work that cannot produce anything new. Repetition alone is
// NOT a loop: a normal turn re-runs the test suite after every fix, flips update_plan statuses
// a dozen times and prefixes every tool call with the same "Let me check." — all of that must
// pass. So detection looks at (tool call + its result) pairs and only fires when the same call
// keeps producing the same answer with nothing changed in between, or when the model resends
// the exact same response over and over.
const LOOP_WINDOW = 30;            // executed tool calls kept for analysis
const LOOP_RESPONSE_REPEAT = 4;    // identical whole responses (text + calls) in a row → loop
const LOOP_SAME_RESULT_REPEAT = 3; // identical (call, result) pairs in a row → loop
const LOOP_ANY_RESULT_REPEAT = 5;  // identical calls in a row even if results differ → loop
const LOOP_CYCLE_MIN = 2;          // A-B-A-B-A-B style cycles: min/max cycle length
const LOOP_CYCLE_MAX = 6;
const LOOP_CYCLE_REPS = 3;         // a cycle must repeat this many times
const LOOP_STALE_REPEAT = 4;       // same (call, result) N times with no mutation between → loop

// Deterministic JSON with keys sorted at EVERY level, so {a:1,b:2} and {b:2,a:1} match but
// nested content still counts (a status flip on t1 and on t2 must NOT look identical).
function canonicalJson(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  return JSON.stringify(v) ?? "null";
}
function contentSignature(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}
function toolCallSignature(name, argsStr) {
  let normalized = String(argsStr || "{}");
  try { normalized = canonicalJson(JSON.parse(normalized)); } catch { normalized = normalized.trim(); }
  return `${name}(${normalized})`;
}
// Numbers and whitespace are noise (durations, pids, timestamps, byte counts) — strip them so
// "tests: 3 passed (152ms)" and "tests: 3 passed (161ms)" count as the same result.
function resultSignature(text) {
  return String(text || "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 2000);
}
// Does this call change the project (so a repeated read afterwards is legitimately new)?
function isMutatingCall(name, args) {
  if (name === "write_file" || name === "str_replace") return true;
  if (name === "shell") return !isReadOnlyCommand(String(args?.command || args?._raw || ""));
  if (mcpRegistry.has(name)) return /write|create|update|delete|remove|edit|move|rename|insert|put|post|patch|set|run|exec|install|apply|commit|push|send/i.test(name);
  return false;
}

// `entries`: executed calls, oldest first, each { sig, res, mut }.
function detectToolLoop(entries) {
  const n = entries.length;
  if (n < LOOP_SAME_RESULT_REPEAT) return null;
  const last = entries[n - 1];

  // 1. The same call again and again, back to back. A command that explicitly waits/polls
  //    (sleep, ping, timeout …) is expected to be repeated a few times → lenient threshold.
  let sameCall = 0, sameCallAndResult = 0, streak = true;
  for (let i = n - 1; i >= 0 && entries[i].sig === last.sig; i--) {
    sameCall++;
    if (streak && entries[i].res === last.res) sameCallAndResult++; else streak = false;
  }
  const sameResultLimit = last.wait ? LOOP_ANY_RESULT_REPEAT : LOOP_SAME_RESULT_REPEAT;
  if (sameCallAndResult >= sameResultLimit) return `same call + same result ${sameCallAndResult}x in a row`;
  if (sameCall >= LOOP_ANY_RESULT_REPEAT) return `same call ${sameCall}x in a row`;

  // 2. A-B-A-B-A-B (or longer) cycles with identical results every time round.
  const key = e => e.sig + "\u0000" + e.res;
  for (let L = LOOP_CYCLE_MIN; L <= LOOP_CYCLE_MAX; L++) {
    const span = L * LOOP_CYCLE_REPS;
    if (n < span) break;
    const tail = entries.slice(-span);
    let cyc = true;
    for (let i = L; i < span && cyc; i++) if (key(tail[i]) !== key(tail[i - L])) cyc = false;
    // a cycle made of one repeated call is case 1; require ≥2 distinct calls
    if (cyc && new Set(tail.slice(0, L).map(key)).size > 1)
      return `cycle of ${L} calls repeated ${LOOP_CYCLE_REPS}x with identical results`;
  }

  // 3. The same call keeps giving the same answer while nothing was changed in between.
  let first = -1, count = 0;
  for (let i = 0; i < n; i++) {
    if (entries[i].sig === last.sig && entries[i].res === last.res) { count++; if (first < 0) first = i; }
  }
  const staleLimit = last.wait ? LOOP_ANY_RESULT_REPEAT + 1 : LOOP_STALE_REPEAT;
  if (count >= staleLimit && !entries.slice(first, n).some(e => e.mut))
    return `same call + same result ${count}x with no changes in between`;

  return null;
}
// Whole responses (text + tool calls) resent verbatim.
function detectResponseLoop(sigs) {
  const n = sigs.length;
  if (n < LOOP_RESPONSE_REPEAT) return null;
  for (let i = n - LOOP_RESPONSE_REPEAT; i < n; i++) if (sigs[i] !== sigs[n - 1]) return null;
  return `identical response ${LOOP_RESPONSE_REPEAT}x in a row`;
}

// ------------------------------------------------------------------ goal & task tracking
// The agent turns the user's prompt into an explicit GOAL, decomposes it into TASKS, executes
// them (batching tool calls so the request costs as few round trips as possible), and is held
// to the list until every task is done/blocked/skipped. The list is re-rendered into the system
// prompt on every model call, so the model always sees its own progress and what is outstanding,
// and `planGate` refuses to end the turn while work is still open.
const TASK_STATUS = ["pending", "in_progress", "done", "blocked", "skipped"];
const ACTIVE_STATUS = new Set(["pending", "in_progress"]);
const PLAN_ICON = { pending: "☐", in_progress: "◐", done: "✓", blocked: "✗", skipped: "‒" };
const MAX_PLAN_NUDGES = 2;   // consecutive pushbacks without progress before the gate lets go
const MAX_PLAN_NUDGES_TOTAL = 6; // hard cap per user message, progress or not — never loop forever
const MAX_PLAN_TASKS = 24;

let PLAN = null;             // session-scoped: { goal, tasks[], rounds, calls, nudges, armed, … }

function newPlan(goal = "") {
  return {
    goal: String(goal || "").replace(/\s+/g, " ").trim().slice(0, 400),
    tasks: [],
    rounds: 0,               // model round trips for the current user message
    calls: 0,                // tool calls executed for the current user message
    mutations: 0,            // mutating tool calls for the current user message
    nudges: 0,               // consecutive completion-gate pushbacks without progress
    nudgesTotal: 0,          // all pushbacks this turn (hard-capped)
    resolvedAtNudge: 0,      // resolved-task count when the gate last pushed back
    armed: false,            // gate is armed once the model engages the plan or starts changing files
    touched: false,          // model called update_plan during this turn
    dirty: false,            // checklist changed outside update_plan — needs a reprint
    explicit: false,         // user set this goal via /plan goal — survives autoplan=off
    announced: false,        // goal already shown to the user for this plan
    sinceUpdate: { shell: 0 },
    created: Date.now(),
  };
}
function ensurePlan(goal = "") {
  if (!PLAN) PLAN = newPlan(goal);
  else if (goal && !PLAN.goal) PLAN.goal = String(goal).replace(/\s+/g, " ").trim().slice(0, 400);
  return PLAN;
}
function resetPlan() { PLAN = null; }
function planTasks(p = PLAN) { return p ? p.tasks : []; }
function activeTasks(p = PLAN) { return planTasks(p).filter(t => ACTIVE_STATUS.has(t.status)); }
function planOpen(p = PLAN) { return activeTasks(p).length; }
// done + blocked + skipped, minus done-but-unverified: the gate's measure of real progress
function resolvedTasks(p = PLAN) {
  return planTasks(p).filter(t => !ACTIVE_STATUS.has(t.status) && !(t.status === "done" && t.verify && t.unverified)).length;
}
// First-cut goal taken straight from the user's prompt, so the tracker always has one even if
// the model never calls update_plan. The model refines it on its first update_plan call.
function seedGoal(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= 160) return t;
  const cut = t.slice(0, 160).search(/[.!?](\s|$)/);
  return (cut > 40 ? t.slice(0, cut + 1) : t.slice(0, 160)).trim();
}
// Per user message: keep the counters fresh, decide whether the follow-up gate applies.
function startPlanTurn(goal) {
  const p = ensurePlan(goal);
  p.rounds = 0; p.calls = 0; p.mutations = 0; p.nudges = 0; p.nudgesTotal = 0;
  p.resolvedAtNudge = resolvedTasks(p);
  p.touched = false; p.armed = planTasks(p).length > 0;   // open work from earlier ⇒ stay on it
  // A goal must be visible even if the model never opens a task list. Announce once per
  // plan, whether it was derived from the prompt just now or set earlier via /plan goal.
  p.fresh = !p.announced && !!p.goal;
  return p;
}

const clean = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
function normalizeStatus(s) {
  const v = String(s ?? "pending").toLowerCase().replace(/[\s-]/g, "_");
  if (v === "doing" || v === "active" || v === "working" || v === "started") return "in_progress";
  if (v === "complete" || v === "completed" || v === "finished") return "done";
  if (v === "todo" || v === "open" || v === "queued") return "pending";
  return TASK_STATUS.includes(v) ? v : "pending";
}
function normalizeTask(raw, i, prev) {
  const o = raw && typeof raw === "object" ? raw : { content: String(raw ?? "") };
  const id = clean(o.id ?? o.task_id ?? prev?.id ?? `t${i + 1}`, 24);
  return {
    id,
    content: clean(o.content ?? o.task ?? o.title ?? o.description ?? prev?.content ?? "", 200),
    status: normalizeStatus(o.status ?? o.state ?? prev?.status),
    verify: clean(o.verify ?? o.check ?? o.verification ?? prev?.verify ?? "", 160),
    note: clean(o.note ?? o.notes ?? o.reason ?? o.blocker ?? prev?.note ?? "", 200),
    unverified: false,
  };
}

// Heuristic: did `cmd` actually perform the check described by `verify`?
// Loose on purpose — a false negative only costs one extra nudge, a false positive hides unverified work.
function verifySeen(cmd, verify) {
  const hay = String(cmd || "").toLowerCase();
  const toks = String(verify || "").toLowerCase().match(/[a-z0-9_.@/\\-]{4,}/g) || [];
  if (!toks.length) return false;
  const need = Math.max(1, Math.ceil(toks.length * 0.5));
  return toks.filter(t => hay.includes(t)).length >= need;
}
// Called after every shell run so "marked done but never verified" tasks can be cleared.
function noteShellRan(cmd, ok) {
  if (!PLAN || !ok) return;
  PLAN.sinceUpdate.shell++;
  for (const t of PLAN.tasks) {
    if (t.unverified && verifySeen(cmd, t.verify)) {
      t.unverified = false;
      PLAN.dirty = true;   // checklist changed — reprint it for the user
    }
  }
}

function applyPlanUpdate(a, cfg) {
  const p = ensurePlan(a?.goal);
  const warnings = [];
  const prevById = new Map(p.tasks.map(t => [t.id, t]));
  const prevByPos = new Map(p.tasks.map((t, i) => [String(i + 1), t]));
  // Shell runs executed since the LAST plan update prove the work — capture before resetting.
  const ranSinceLast = p.sinceUpdate.shell;
  p.touched = true;
  p.armed = true;
  // NOTE: the nudge counter is deliberately NOT reset here. Resetting it on every update_plan
  // let a model bounce forever between "Done." → nudge → status flip → "Done." → nudge …
  // planGate() resets it only when tasks actually get resolved.
  p.sinceUpdate.shell = 0;

  if (Array.isArray(a?.tasks) && a.tasks.length) {
    const next = [];
    const seen = new Set();
    for (let i = 0; i < a.tasks.length && next.length < MAX_PLAN_TASKS; i++) {
      const raw = a.tasks[i];
      const hint = raw && typeof raw === "object" ? clean(raw.id ?? raw.task_id, 24) : "";
      const prev = (hint && prevById.get(hint)) || prevByPos.get(String(i + 1)) || null;
      const t = normalizeTask(raw, i, prev);
      if (!t.content) { warnings.push(`task ${i + 1} had no content and was dropped`); continue; }
      if (seen.has(t.id)) t.id = `${t.id}-${i + 1}`;
      seen.add(t.id);
      // A freshly-completed task counts as verified only if a check actually ran since the last update.
      const wasDone = prev?.status === "done" && prev?.content === t.content;
      if (t.status === "done" && t.verify && !wasDone && ranSinceLast === 0) t.unverified = true;
      next.push(t);
    }
    if (a.tasks.length > MAX_PLAN_TASKS) warnings.push(`plan capped at ${MAX_PLAN_TASKS} tasks`);
    p.tasks = next;
  }

  const patches = [];
  if (Array.isArray(a?.updates)) patches.push(...a.updates);
  else if (a && (a.id || a.task_id) && (a.status || a.state)) patches.push(a);
  for (const u of patches) {
    const id = clean(u?.id ?? u?.task_id, 24);
    const t = p.tasks.find(x => x.id === id) || p.tasks[Number(id.replace(/\D/g, "")) - 1];
    if (!t) { warnings.push(`unknown task id '${id || "?"}'`); continue; }
    const status = normalizeStatus(u.status ?? u.state);
    const note = clean(u.note ?? u.notes ?? u.reason ?? t.note, 200);
    if ((status === "blocked" || status === "skipped") && !note)
      warnings.push(`task ${t.id} ${status} without a reason — add a note`);
    if (status === "done" && t.verify && ranSinceLast === 0) t.unverified = true;
    if (status !== "done") t.unverified = false;
    t.status = status; t.note = note;
    if (u.verify) t.verify = clean(u.verify, 160);
  }

  if (String(a?.goal || "").trim()) p.goal = clean(a.goal, 400);
  const done = p.tasks.filter(t => t.status === "done").length;
  const open = activeTasks(p).length;
  const head = p.tasks.length
    ? `plan updated — ${done}/${p.tasks.length} done, ${open} still open`
    : "plan updated (no tasks yet — add them)";
  let msg = p.goal ? `${head}\nGOAL: ${p.goal}\n` : `${head}\n`;
  msg += renderPlan(p, "  ") || "  (empty)";
  if (warnings.length) msg += "\nnotes: " + warnings.join("; ");
  msg += "\nNext: work the first open task, batching independent tool calls into one response.";
  return [true, msg];
}

function renderPlan(p = PLAN, prefix = "  ") {
  if (!p) return "";
  if (!p.tasks.length) return p.goal ? `${prefix}GOAL: ${p.goal}   [no tasks yet]` : "";
  const done = p.tasks.filter(t => t.status === "done").length;
  const lines = [`${prefix}GOAL: ${p.goal || "(unset)"}   [${done}/${p.tasks.length} done]`];
  for (const t of p.tasks) {
    let l = `${prefix} ${PLAN_ICON[t.status] || "?"} [${t.id}] ${t.content}`;
    if (t.status === "done" && t.verify) l += t.unverified ? `  (verify PENDING: ${t.verify})` : `  (verified: ${t.verify})`;
    else if (t.verify) l += `  (verify: ${t.verify})`;
    if (t.note && (t.status === "blocked" || t.status === "skipped")) l += `  — ${t.note}`;
    lines.push(l);
  }
  return lines.join("\n");
}
function printPlan(p = PLAN) {
  const r = renderPlan(p, "    ");
  if (r) console.log(dim(r));
}
// Round-trip accounting: the whole point of the plan is to land the request in as few
// model round trips as possible, so report what it actually cost.
function printPlanSummary(p = PLAN) {
  if (!p || (!p.rounds && !p.calls && !p.tasks.length)) return;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const bits = [plural(p.rounds, "round trip"), plural(p.calls, "tool call")];
  if (p.tasks.length) {
    const done = p.tasks.filter(t => t.status === "done").length;
    const open = activeTasks(p).length;
    const stalled = p.tasks.filter(t => t.status === "blocked" || t.status === "skipped").length;
    bits.push(`plan ${done}/${p.tasks.length} done` + (open ? ` · ${open} open` : ""));
    if (stalled) bits.push(`${stalled} blocked/skipped`);
  }
  if (p.nudges) bits.push(`${p.nudges} follow-up${p.nudges === 1 ? "" : "s"} needed`);
  console.log(dim("  " + bits.join(" · ")));
}

// Re-rendered into the system prompt on every model call — this is how the model "follows up"
// on its own implementation instead of drifting or stopping early.
function planPromptBlock() {
  if (!PLAN || (!PLAN.tasks.length && !PLAN.goal)) return "";
  let s = "\n\nYOUR CURRENT PLAN (you own this list — keep it truthful):";
  s += "\n" + (renderPlan(PLAN) || "  (no tasks yet)");
  const open = activeTasks();
  if (open.length) {
    s += `\n${open.length} task(s) are NOT finished. Keep going on [${open[0].id}] without asking the user anything.`;
    s += "\nFlip a task to done ONLY after it is implemented AND its `verify` check actually passed.";
    s += "\nIf a task is genuinely impossible, mark it blocked with a note and move on — do not silently drop it.";
  } else if (PLAN.tasks.length) {
    s += "\nAll tasks are resolved. Reply with the final summary — do not re-open work.";
  }
  const unverified = PLAN.tasks.filter(t => t.status === "done" && t.verify && t.unverified);
  if (unverified.length)
    s += `\nUNVERIFIED (claimed done, no check run): ${unverified.map(t => `[${t.id}] run ${t.verify}`).join("; ")}`;
  s += `\nRound trips used on this request: ${PLAN.rounds}. Batch every independent tool call into one response.`;
  return s;
}

// Completion gate: returns a follow-up instruction when the model tried to stop with work open,
// or null when it is allowed to end the turn.
function planGate(cfg) {
  const p = PLAN;
  if (!p || !p.armed || !p.tasks.length) return null;
  // Plan mode only produces the checklist — the tasks are meant to stay open until the user
  // switches to code mode, so pushing the model to "finish" them would only make it loop.
  if (cfg?.mode === "plan") return null;
  const open = activeTasks(p);
  const unverified = p.tasks.filter(t => t.status === "done" && t.verify && t.unverified);
  if (!open.length && !unverified.length) return null;
  // Progress since the last pushback (tasks resolved) earns fresh patience; no progress ends the turn.
  const resolved = resolvedTasks(p);
  if (resolved > p.resolvedAtNudge) { p.nudges = 0; p.resolvedAtNudge = resolved; }
  if (p.nudges >= MAX_PLAN_NUDGES || p.nudgesTotal >= MAX_PLAN_NUDGES_TOTAL) return null;
  p.nudges++; p.nudgesTotal++;   // this call IS a pushback
  const parts = [];
  if (open.length) {
    parts.push(`${open.length} task(s) still open: ` + open.map(t => `[${t.id}] ${t.content}`).join(" | "));
  }
  if (unverified.length) {
    parts.push("marked done but never verified: " + unverified.map(t => `[${t.id}] → run ${t.verify}`).join("; "));
  }
  return "NOT DONE YET. " + parts.join(". ") +
    "\nFinish the remaining work now — do NOT restate the plan, do NOT ask the user to confirm. " +
    "Batch all independent tool calls into a single response to keep round trips low, then call " +
    "update_plan to reflect the new state. Only if a task is truly impossible, mark it blocked with a note.";
}

const TOOLS = [
  { type: "function", function: {
      name: "update_plan",
      description:
        "Your goal + task list for the current request. Call it FIRST on any task that needs more than one step " +
        "or any file change: state the goal in one sentence, then list every task with a `verify` that proves it works. " +
        "Keep it in step with reality — flip a task to in_progress when you start it and to done the moment it is " +
        "actually finished and verified. The user sees this list, and you are not allowed to stop while tasks are " +
        "still pending. Send the COMPLETE list in `tasks` (full replace), or send just `updates` for a cheap " +
        "status flip.",
      parameters: { type: "object",
        properties: {
          goal: { type: "string", description: "One sentence: the outcome the user actually wants (not the steps)." },
          tasks: { type: "array", description: "The COMPLETE ordered task list. 3-12 concrete tasks.",
            items: { type: "object",
              properties: {
                id: { type: "string", description: "Stable short id, e.g. t1. Reuse it on later updates." },
                content: { type: "string", description: "One concrete, verifiable step." },
                status: { type: "string", enum: TASK_STATUS },
                verify: { type: "string", description: "How to prove this task is done, e.g. 'npm test passes'." }
              },
              required: ["content", "status"] } },
          updates: { type: "array", description: "Cheaper alternative to `tasks`: flip status on existing ids.",
            items: { type: "object",
              properties: {
                id: { type: "string" },
                status: { type: "string", enum: TASK_STATUS },
                note: { type: "string", description: "Required when blocking/skipping: the reason." }
              },
              required: ["id", "status"] } }
        } } } },
  { type: "function", function: {
      name: "shell",
      description: "Run a shell command; returns exit code + stdout/stderr. background=true for long-running processes (dev servers, watchers) so it returns immediately. Combine independent commands with && or ; to save round trips. Note: PowerShell is blocked; use cmd.",
      parameters: { type: "object",
        properties: {
          command: { type: "string" },
          background: { type: "boolean", description: "true for servers/watchers that never exit" }
        },
        required: ["command"] } } },
  { type: "function", function: {
      name: "read_file",
      description: "Read a text file (path relative to project folder), optionally a line range. Prefer large meaningful chunks. Pass `paths` (array) instead of `path` to read several files in ONE call.",
      parameters: { type: "object",
        properties: {
          path: { type: "string", description: "Single file to read." },
          paths: { type: "array", items: { type: "string" }, description: "Several files at once — cheaper than one call per file." },
          start: { type: "integer", description: "First line (1-based); only applies to `path`." },
          end: { type: "integer", description: "Last line inclusive; only applies to `path`." }
        } } } },
  { type: "function", function: {
      name: "str_replace",
      description: "Replace an exact, contiguous block of text in a file for targeted edits. `old_str` must match exactly (including whitespace).",
      parameters: { type: "object",
        properties: {
          path: { type: "string" },
          old_str: { type: "string", description: "Exact text to find" },
          new_str: { type: "string", description: "Text to replace it with" }
        },
        required: ["path", "old_str", "new_str"] } } },
  { type: "function", function: {
      name: "write_file",
      description: "Create a NEW file or COMPLETELY OVERWRITE an existing one. You MUST provide the FULL content. NEVER use placeholders.",
      parameters: { type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"] } } },
  { type: "function", function: {
      name: "remember",
      description: "Save a lesson learned, project quirk, user preference, or workaround to long-term memory so you don't repeat mistakes in future sessions.",
      parameters: { type: "object",
        properties: {
          type: { type: "string", enum: ["lesson", "preference", "quirk", "command"] },
          content: { type: "string", description: "The concise fact, rule, or workaround to remember." }
        },
        required: ["type", "content"] } } },
  { type: "function", function: {
      name: "forget",
      description: "Delete a specific memory by its ID if you discover it is outdated or wrong.",
      parameters: { type: "object",
        properties: { memory_id: { type: "string" } },
        required: ["memory_id"] } } },
];

const HELP = `
commands
  /set url <base|alias>   API base URL (aliases: ${Object.keys(ALIASES).join(" ")})
  /set model <name>       /set key <secret>
  /set draft_model <name> speculative-decoding draft model (blank to clear)
  /set temperature <n>    sampling temperature (blank to reset)
  /set reasoning <lvl>    reasoning effort: low|medium|high (blank/off = default)
  /set dir <path>         project folder ('-' to clear)      /cd <path>  same as /set dir
  /set context <n|auto>   context window; enables trimming ('auto' = detect from API)
  /set max_tokens <n>     reply length cap        /set maxout <n>  tool output cap (chars)
  /set autoplan <on|off>  auto-derive goal + tasks from each prompt (default: on)
  /set max_steps <n>      tool-step cap (0 = unlimited; default)
  /set intercept <on|off> approval gate before mutating tools run
  /set tools <on|off>     enable/disable native function calling
  /set stream <on|off>    streaming replies (on = SSE chunks; off = "stream": false, single JSON)
  /set system <prompt>    replace system prompt
  /mode <ask|plan|code>   agent mode (ask=chat, plan=read-only plan, code=full auto)
  /plan                   show the current goal + task checklist
  /plan goal <text>       set a goal yourself (works even with autoplan off)
  /plan clear             drop the current plan
  /redact <on|off>        toggle silent secret redaction (default: on)
  /compact                summarize & shrink history (use when context is getting full)
  /block <regex>  /unblock <regex>  /blocked     manage command blocklist
  /mcp                    list connected MCP servers and their tools
  /save [name]  /load <name>  /sessions      save / load / list chat sessions
  /memories  /forget <id>                    view / delete learned memories
  /commands                                  show learned working/failing OS commands
  /config show settings   /models list models   /clear reset chat   /exit quit
keys & editing
  enter send · shift+enter newline (or \\+enter) · ctrl+c cancel · ctrl+d exit
  @<path> + Tab           autocomplete file paths from project folder
notes
  - data folder: ${DATA_DIR}  (config, mcp, memory, commands, sessions)
  - MCP servers: edit ${MCP_PATH}
  - the agent stops after ${MAX_FAIL_STREAK} consecutive tool failures to avoid damage
  - loop detection: stops when the same tool call keeps returning the same result with nothing
    changed in between, or the model resends the exact same response (re-running tests after
    each fix and updating the plan checklist are NOT loops)
  - tools: update_plan, shell, read_file, str_replace, write_file, remember, forget, + MCP tools
  - the agent sets a goal from your prompt, splits it into tasks, works them to done,
    and refuses to stop while tasks are still open (follow-up nudge, max ${MAX_PLAN_NUDGES}x)
    turn it off with /set autoplan off
  - env vars: AI_URL / AI_MODEL / AI_KEY / AI_DIR
`;

const USAGE = `ai-agent ${VERSION} — self-learning terminal AI agent (Node >= 18, zero deps)
usage: node ai-agent.mjs [options] ["one-shot prompt"]
  --url <base|alias>  --model <name>      --key <sk-...>
  --draft-model <name>  speculative-decoding draft model
  --temperature <n>     sampling temperature
  --reasoning <lvl>     reasoning effort (low|medium|high)
  --mode <ask|plan|code> agent mode (default: code)
  --dir <path>        project folder all tasks are based on
  --context <n>       --maxout <n>        --max-tokens <n>
  --max-steps <n>     tool-step cap (0 = unlimited; default)
  --intercept         approval gate before mutating tools run
  --stream <on|off>   streaming model replies (default on); --no-stream = single JSON reply
  --autoplan <on|off>  auto-derive goal + tasks from the prompt (default: on)
  --no-autoplan       same as --autoplan off
  --system <prompt>   --no-tools / --tools  --save   --list   -h`;

// ------------------------------------------------------------------ ui/color
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = code => s => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2"), bold = paint("1"), red = paint("31"),
      green = paint("32"), yellow = paint("33"), cyan = paint("36");

class ApiError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tryParse = s => { try { return JSON.parse(s); } catch { return undefined; } };
const RETRYABLE = msg => /HTTP (429|5\d\d)|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang|overloaded|rate.?limit|temporar|unavailable/i.test(msg);

const expandUser = p => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const displayPath = p => {
  const h = os.homedir();
  return p === h ? "~" : p.startsWith(h + path.sep) ? "~" + p.slice(h.length) : p;
};

// ------------------------------------------------------------------ spinner
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
class Spinner {
  constructor() { this.t = null; this.i = 0; this.label = ""; }
  start(label = "") {
    if (!process.stdout.isTTY) return;
    this.label = label;
    if (this.t) return;
    this.i = 0;
    const draw = () => {
      const f = FRAMES[this.i = (this.i + 1) % FRAMES.length];
      process.stdout.write(`\r\x1b[K${cyan(f)} ${dim(this.label || "working…")}`);
    };
    draw();
    this.t = setInterval(draw, 80);
  }
  stop() {
    if (this.t) { clearInterval(this.t); this.t = null; }
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
  }
}
const spin = new Spinner();

// ------------------------------------------------------------------ os detection
const IS_WIN = process.platform === "win32";
const SHELL_NAME = IS_WIN ? "cmd.exe" : (process.env.SHELL ? path.basename(process.env.SHELL) : "sh");
function osDescription() {
  const p = process.platform;
  if (p === "win32") return `Windows ${os.release()}`;
  if (p === "darwin") return `macOS ${os.release()}`;
  if (p === "linux") return `Linux ${os.release()}`;
  return `${os.type()} ${os.release()}`;
}

// ------------------------------------------------------------------ silent secret masking
// Real secrets are silently replaced with length-preserving dummy tokens in every
// tool result the model sees. Dummies are restored to real values on write_file /
// str_replace. Nothing in the system prompt, HELP, or /config reveals this exists.
let _secretStore = null;      // { dummy: real }
let _realToDummy = null;      // Map<real, dummy>
let _restoreRe = null;        // one alternation over all dummies, rebuilt when the store changes
const SECRET_STORE_CAP = 5000;
const DUMMY_MIN_LEN = 8;      // 62^8 ≈ 2e14 — short dummies collided with real file content on restore

function loadSecretStore() {
  if (_secretStore) return;
  let d = {};
  try { d = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8")).dummies || {}; } catch {}
  const keys = Object.keys(d);
  if (keys.length > SECRET_STORE_CAP) for (const k of keys.slice(0, keys.length - SECRET_STORE_CAP)) delete d[k];
  _secretStore = d;
  _realToDummy = new Map();
  for (const [k, v] of Object.entries(_secretStore)) _realToDummy.set(v, k);
  _restoreRe = null;
}
function saveSecretStore() {
  try { fs.writeFileSync(SECRETS_PATH, JSON.stringify({ dummies: _secretStore }, null, 2), { mode: 0o600 }); } catch {}
}
// length-preserving alphanumeric dummy — looks natural in place
function genDummy(len) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const n = Math.max(len || 0, DUMMY_MIN_LEN);
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function dummyFor(real) {
  loadSecretStore();
  if (_secretStore[real] !== undefined) return real;   // already a dummy — never mask twice
  let d = _realToDummy.get(real);
  if (!d) {
    do { d = genDummy(real.length); } while (_secretStore[d]);
    _secretStore[d] = real;
    _realToDummy.set(real, d);
    _restoreRe = null;
    saveSecretStore();
  }
  return d;
}
function restoreSecrets(text) {
  loadSecretStore();
  const t = String(text);
  const dummies = Object.keys(_secretStore);
  if (!dummies.length) return t;
  if (!_restoreRe) {
    const alt = dummies.sort((a, b) => b.length - a.length).map(d => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    _restoreRe = new RegExp(alt, "g");
  }
  // a couple of passes in case an older store nested dummies (dummy of a dummy)
  let out = t;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(_restoreRe, m => _secretStore[m] ?? m);
    if (next === out) break;
    out = next;
  }
  return out;
}
// Things that sit after `password =` / `token:` in ordinary code and must NOT be masked:
// type names, keywords, placeholders, env lookups, function calls, paths, template holes.
const NOT_A_SECRET = /^(true|false|null|none|nil|undefined|nan|string|str|text|int|integer|number|float|bool|boolean|object|any|unknown|void|required|optional|redacted|changeme|change_me|placeholder|example|sample|dummy|test|password|secret|token|bearer|basic|digest|hoba|mutual|negotiate|ntlm|oauth|xxx+|\*+|\.{3,}|-+|_+|<[^>]*>|\$\{?[A-Za-z_][\w.]*\}?|%[A-Za-z_]\w*%|your[_-]\w+|<?your[\w -]*>?)[;,]?$/i;
const CODE_EXPR = /[()[\]{}]|^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+;?$|^[\/~]|^[A-Za-z]:\\|^\.{1,2}[\/\\]|^(new|await|this|self|os|process|env|require|import|typeof)\b/;
function looksSecretLike(v, strong) {
  const s = String(v).replace(/[;,]$/, "");
  if (s.length < (strong ? 6 : 8) || s.length > 512) return false;
  if (NOT_A_SECRET.test(s) || CODE_EXPR.test(s)) return false;
  if (/\s/.test(s)) return false;
  // strong keywords (password/api_key/…): anything that is not obviously code counts
  if (strong) return true;
  // weak keywords (token/pwd/…): need some entropy — digits, symbols, or long mixed case
  return /\d/.test(s) || /[^A-Za-z0-9]/.test(s) || (s.length >= 20 && /[a-z]/.test(s) && /[A-Z]/.test(s));
}
const SECRET_KEYS_STRONG = "password|passwd|passphrase|secret|api[_-]?key|private[_-]?key|client[_-]?secret|secret[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer[_-]?token";
const SECRET_KEYS_WEAK = "pwd|token|access[_-]?key|credential|session[_-]?id|authorization";
function maskSecrets(text, cfg) {
  if (!cfg || cfg.redact === false) return String(text);
  let t = String(text);
  // URL credentials: scheme://user:pass@host — never a port/path (those have no '@' user part)
  t = t.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s\/@]+:)([^@\s\/]+)(@)/gi, (m, pre, pass, at) => pre + dummyFor(pass) + at);
  // well-known token shapes
  t = t.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, m => dummyFor(m));
  t = t.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, m => dummyFor(m));
  t = t.replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, m => dummyFor(m));
  t = t.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, m => dummyFor(m));
  t = t.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, m => dummyFor(m));
  t = t.replace(/\bsk-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{20,}\b/g, m => dummyFor(m));
  t = t.replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/g, (m, pre, tok) => looksSecretLike(tok, false) ? pre + dummyFor(tok) : m);
  // key = value / key: value / key="value" — only when the value itself looks like a secret
  const kv = (keys, strong) => {
    t = t.replace(new RegExp(`((?:${keys})["']?\\s*[:=]\\s*)(["'])([^"'\\n]+)\\2`, "gi"),
      (m, pre, q, val) => looksSecretLike(val, strong) ? pre + q + dummyFor(val) + q : m);
    t = t.replace(new RegExp(`((?:${keys})["']?\\s*[:=]\\s*)([^\\s"',;]+)`, "gi"),
      (m, pre, val) => looksSecretLike(val, strong) ? pre + dummyFor(val) : m);
  };
  kv(SECRET_KEYS_STRONG, true);
  kv(SECRET_KEYS_WEAK, false);
  return t;
}
// keep the dummy->real mapping undiscoverable by the model
function isProtectedPath(p) {
  try { return path.resolve(String(p || "")) === path.resolve(SECRETS_PATH); } catch { return false; }
}

// ------------------------------------------------------------------ command policy
const DEFAULT_BLOCKED = [
  "^\\s*powershell(\\.exe)?(\\s|$)",
  "^\\s*pwsh(\\.exe)?(\\s|$)",
];
const WEB_FETCH_SHELL = /(^|[\s;&|(])(curl|wget|httpie|http|Invoke-WebRequest|iwr|lynx|w3m)(\.exe)?(\s|$)/i;
const LOCAL_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.\s/:]+\.(local|internal|test))$/i;
function mcpSearchToolsListed() {
  for (const name of mcpRegistry.keys()) {
    if (/search|web_|web-|fetch|page-content|exa|brave|tavily/i.test(name)) return true;
  }
  return false;   // other MCP servers (filesystem, db, …) are no reason to block curl
}
// curl/wget against the public internet is redirected to the web MCP tools when there are
// any; hitting a local dev server (curl localhost:3000/health) must always stay allowed.
function fetchesRemoteUrl(cmd) {
  const urls = String(cmd).match(/https?:\/\/[^\s"'<>)]+/gi) || [];
  if (!urls.length) return /\b(curl|wget)\b\s+[^-\s][^\s]*\.[a-z]{2,}(\/|\s|$)/i.test(cmd);  // curl example.com
  return urls.some(u => { try { return !LOCAL_HOST_RE.test(new URL(u).hostname); } catch { return true; } });
}
// Downloading an artifact (curl -o …, wget -O …, … | tar) is not something a web-search MCP
// can do — only page/API *reading* is redirected.
const DOWNLOADS_FILE = /(^|\s)-[a-zA-Z]*[oO]\b|--output|--remote-name|>\s*\S|\|\s*(tar|unzip|gunzip|sh|bash|python3?|node)\b/;
function checkCommandPolicy(cmd, cfg) {
  const c = String(cmd).trim();
  if (mcpSearchToolsListed() && WEB_FETCH_SHELL.test(c) && fetchesRemoteUrl(c) && !DOWNLOADS_FILE.test(c)) {
    const names = [...mcpRegistry.keys()].join(", ");
    return {
      allowed: false,
      pattern: "curl/wget to the internet blocked — use MCP: " + names,
    };
  }
  for (const pat of (cfg.blockedCommands || DEFAULT_BLOCKED)) {
    let re; try { re = new RegExp(pat, "i"); } catch { continue; }
    if (re.test(c)) return { allowed: false, pattern: pat };
  }
  return { allowed: true };
}

// ------------------------------------------------------------------ execution interception
const DANGEROUS = [
  /\brm\s+(-[a-z]+\s+)*-[a-z]*r[a-z]*\s+(\/|~|\$HOME)(\s|$)/i,
  /--no-preserve-root/i,
  /\bmkfs\b/i, /\bdd\b[^|;&]*\bof=\/dev\//i, />\s*\/dev\/sd/i,
  /\bformat\s+[a-z]:/i, /\brd\s+\/s\b/i, /\bdel\s+\/[sfq]+\s+[a-z]:\\/i,
  /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/i,
];
const READONLY = [
  /^(ls|ll|dir|pwd|cd|cat|type|echo|which|where|whoami|hostname|date|stat|file|wc|head|tail|tree|findstr|grep|egrep|rg|find|fd|ps|env|printenv|uname|id|uptime|df|du|free|less|more|sort|uniq|diff|cmp|md5sum|sha\d*sum|realpath|readlink|basename|dirname|nproc|lsb_release|sw_vers|ver|systeminfo|tasklist|netstat|ss|lsof)\b/i,
  /^git\s+(status|log|diff|show|branch|remote|ls-files|blame|grep|rev-parse|describe|tag|stash\s+list|config\s+--get)\b/i,
  /^(npm|yarn|pnpm|bun)\s+(ls|list|outdated|view|why|info|--version|-v)\b/i,
  /^(node|python3?|pip3?|go|cargo|rustc|java|javac|dotnet|ruby|php|deno|bun|tsc)\s+(--version|-version|-v|version|-V)\b/i,
  /^(pip3?\s+(list|show|freeze)|cargo\s+(tree|metadata)|go\s+(env|list)|docker\s+(ps|images|logs|inspect))\b/i,
];
// Redirections and pipes into writers turn a read-only command into a mutating one.
const WRITES_OUTPUT = /(^|[^<>|])>{1,2}(?!&\d)|\|\s*(tee|sponge|xargs\s+rm|dd)\b/;
function isReadOnlyCommand(cmd) {
  const c = String(cmd || "").trim();
  if (!c) return false;
  // every segment of a && / ; / | chain must be read-only
  const segs = c.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  return !WRITES_OUTPUT.test(c) && segs.every(s => READONLY.some(re => re.test(s)));
}
function classifyTool(name, args) {
  if (mcpRegistry.has(name)) return "auto";
  if (name === "read_file") return "auto";
  if (name === "update_plan") return "auto";   // planning is free — never gate it
  if (name === "shell") {
    const c = String(args.command || args._raw || "").trim();
    if (DANGEROUS.some(re => re.test(c))) return "block";
    if (isReadOnlyCommand(c)) return "auto";
    return "ask";
  }
  return "ask";
}
async function confirmTool(name, args, keys) {
  if (typeof keys?.key !== "function") {   // piped / one-shot mode has no keyboard to ask
    console.log("  " + yellow("⚠ intercept is on but there is no terminal to confirm — skipped ") + dim("(run without --intercept or /set intercept off)"));
    return "no";
  }
  process.stdout.write("  " + yellow("⚠ run? ") + dim(fmtCall(name, args)) +
                       dim("  — [y]es  [n]o  [a]lways-yes: "));
  for (;;) {
    const k = await keys.key();
    const t = k[0];
    if (t === "ctrl_c") { process.stdout.write("\n"); return "no"; }
    if (t === "enter")  { process.stdout.write("\n"); return "yes"; }
    if (t === "char") {
      const ch = k[1].toLowerCase();
      if (ch === "y") { process.stdout.write("\n"); return "yes"; }
      if (ch === "n" || ch === "q") { process.stdout.write("\n"); return "no"; }
      if (ch === "a") { process.stdout.write("\n"); return "always"; }
    }
  }
}

// ------------------------------------------------------------------ command ledger
function loadLedger() {
  try {
    const all = JSON.parse(fs.readFileSync(CMD_LEDGER_PATH, "utf8"));
    return all[process.platform] || { worked: {}, failed: {} };
  } catch { return { worked: {}, failed: {} }; }
}
function saveLedger(l) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(CMD_LEDGER_PATH, "utf8")); } catch {}
    all[process.platform] = l;
    fs.writeFileSync(CMD_LEDGER_PATH, JSON.stringify(all, null, 2));
  } catch {}
}
function baseCommand(cmd) {
  const s = String(cmd).trim();
  const m = s.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*([A-Za-z0-9_.\\\/:@-]+)/);
  return m ? m[1] : (s.split(/\s+/)[0] || "");
}
function extractFailedCommand(output) {
  const m = output.match(/'([^']+)'\s+is not recognized/i)
    || output.match(/The term '([^']+)'/i)
    || output.match(/(\S+): command not found/i)
    || output.match(/command not found: (\S+)/i);
  return m ? m[1].split(/[\/\\]/).pop() : null;
}
function looksLikeNotFound(text) {
  return /command not found|is not recognized|not recognized as|Unknown command|The term .+ is not recognized/i.test(text);
}
function recordCommand(cmd, ok, output) {
  const ledger = loadLedger();
  let base;
  if (ok) {
    base = baseCommand(cmd);
    if (!base) return;
    ledger.worked[base] = (ledger.worked[base] || 0) + 1;
    delete ledger.failed[base];
  } else {
    if (!looksLikeNotFound(output || "")) return;
    base = extractFailedCommand(output || "") || baseCommand(cmd);
    if (!base) return;
    ledger.failed[base] = (ledger.failed[base] || 0) + 1;
    delete ledger.worked[base];
  }
  saveLedger(ledger);
}
function commandHints() {
  const ledger = loadLedger();
  const worked = Object.entries(ledger.worked).sort((a,b)=>b[1]-a[1]).slice(0,40).map(([k])=>k);
  const failed = Object.keys(ledger.failed).slice(0,40);
  let s = "";
  if (worked.length) s += `\n- Commands VERIFIED working on this system: ${worked.join(", ")}.`;
  if (failed.length) s += `\n- Commands that DO NOT EXIST on this system (never use; pick native alternatives): ${failed.join(", ")}.`;
  return s;
}

// ------------------------------------------------------------------ self-learning memory
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEM_PATH, "utf8")); }
  catch { return { memories: [] }; }
}
function saveMemory(mem) {
  try { fs.writeFileSync(MEM_PATH, JSON.stringify(mem, null, 2)); } catch {}
}
const STOPWORDS = new Set(["the","and","for","with","that","this","from","have","been","was","were","are","is","will","can","should","could","would","how","what","why","when","where","who","which","about","into","over","under","after","before","between","through","using","used","make","file","folder","code","script","run","execute"]);
function extractKeywords(text) {
  return [...new Set(
    String(text).toLowerCase().replace(/[^a-z0-9\s_-]/g, " ").split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  )];
}
function searchMemory(query, currentProjectDir, limit = 3) {
  const mems = loadMemory().memories;
  if (!mems.length) return [];
  const qKw = extractKeywords(query);
  if (!qKw.length) return [];
  return mems
    .filter(m => !m.projectDir || m.projectDir === currentProjectDir || m.type === "preference")
    .map(m => {
      let score = 0;
      const mKw = m.keywords || [];
      for (const kw of qKw) {
        if (mKw.includes(kw)) score += 3;
        else if (m.content.toLowerCase().includes(kw)) score += 1;
      }
      return { m, score };
    })
    .filter(x => x.score > 0).sort((a,b)=>b.score-a.score).slice(0, limit).map(x=>x.m);
}

// ------------------------------------------------------------------ MCP client
const MCP_VERSION = "2024-11-05";
const mcpClients = new Map();
const mcpRegistry = new Map();
let mcpReady = false;

function loadMcpServers() {
  try {
    const j = JSON.parse(fs.readFileSync(MCP_PATH, "utf8"));
    return j.mcpServers || j;
  } catch { return {}; }
}

function mcpTransportOf(cfg) {
  if (cfg.type) return cfg.type;
  if (cfg.url) return "http";
  return "stdio";
}

function parseSseJsonRpc(text) {
  let last = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try { last = JSON.parse(raw); } catch {}
  }
  return last;
}

class McpClient {
  constructor(name, cfg) {
    this.name = name; this.cfg = cfg;
    this.proc = null; this.buf = ""; this.nextId = 1;
    this.pending = new Map(); this.tools = [];
    this.transport = mcpTransportOf(cfg);
    this.httpSession = null;
    this.sseSource = null;
    this.sseEndpoint = cfg.url || null;
  }
  async start() {
    if (this.transport === "stdio") {
      this.proc = spawn(this.cfg.command, this.cfg.args || [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(this.cfg.env || {}) },
        windowsHide: true,
      });
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", d => this._onData(d));
      this.proc.stderr.on("data", () => {});
      this.proc.on("error", e => this._failAll(e));
      this.proc.on("exit", c => this._failAll(new Error(`server exited (${c})`)));
      return;
    }
    if (!this.cfg.url) throw new Error("MCP http/sse server needs a url");
    this.sseEndpoint = this.cfg.url;
    if (this.transport === "sse") await this._establishSse(this.cfg.url);
  }
  async _establishSse(baseUrl) {
    const ES = await loadEventSource();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { this.sseSource?.close(); } catch {}
        reject(new Error("SSE connection timeout"));
      }, 30000);
      // legacy SSE transport: GET <url> → "endpoint" event → POST messages there; the
      // JSON-RPC responses come back on this same stream as "message" events
      this.sseSource = new ES(baseUrl, this.cfg.headers ? { fetch: (u, o) => fetch(u, { ...o, headers: { ...(o?.headers || {}), ...this.cfg.headers } }) } : undefined);
      this.sseSource.onerror = (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          try { this.sseSource.close(); } catch {}
          reject(new Error("SSE connection failed" + (e?.message ? `: ${e.message}` : "")));
        } else {
          this._failAll(new Error("SSE connection lost"));
        }
      };
      this.sseSource.addEventListener("endpoint", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          const raw = String(e.data || "").trim();
          let data = raw; try { data = JSON.parse(raw); } catch {}
          this.sseEndpoint = typeof data === "string" ? data : (data.endpoint || data.uri || data.url || this.cfg.url);
          if (!/^https?:\/\//i.test(this.sseEndpoint)) this.sseEndpoint = new URL(this.sseEndpoint, baseUrl).toString();
          resolve();
        } catch (err) {
          try { this.sseSource.close(); } catch {}
          reject(err);
        }
      });
      this.sseSource.addEventListener("message", (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (Array.isArray(msg)) msg.forEach(m => this._dispatch(m)); else this._dispatch(msg);
      });
    });
  }
  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      this._dispatch(msg);
    }
  }
  _dispatch(msg) {
    if (msg == null || msg.id === undefined || !this.pending.has(msg.id)) return;
    const { resolve, reject } = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message || "MCP error")) : resolve(msg.result);
  }
  _send(msg) {
    if (this.transport === "stdio") {
      try { this.proc.stdin.write(JSON.stringify(msg) + "\n"); } catch {}
      return;
    }
    this._sendHttp(msg).catch(e => {
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        reject(e);
      }
    });
  }
  async _sendHttp(msg) {
    if (!this.sseEndpoint) throw new Error("MCP HTTP endpoint not set");
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...(this.cfg.headers || {}),
    };
    if (this.httpSession) headers["mcp-session-id"] = this.httpSession;
    const res = await fetch(this.sseEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get("mcp-session-id") || res.headers.get("Mcp-Session-Id");
    if (sid) this.httpSession = sid;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    if (msg.id === undefined) { await res.text().catch(() => {}); return; } // notification
    const text = await res.text();
    // legacy SSE transport: the POST is just acknowledged (202/empty) and the actual response
    // arrives on the event stream → nothing to dispatch here
    if (!text.trim()) {
      if (this.transport === "sse" || res.status === 202) return;
      throw new Error(`MCP HTTP ${res.status} empty body`);
    }
    const ct = res.headers.get("content-type") || "";
    let data;
    if (ct.includes("text/event-stream")) data = parseSseJsonRpc(text);
    else { try { data = JSON.parse(text); } catch { data = parseSseJsonRpc(text); } }
    if (!data) { if (this.transport === "sse") return; throw new Error(`MCP HTTP ${res.status}: unreadable body`); }
    if (Array.isArray(data)) data.forEach(d => this._dispatch(d)); else this._dispatch(data);
  }
  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: r => { clearTimeout(t); resolve(r); },
        reject: e => { clearTimeout(t); reject(e); },
      });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async initialize() {
    await this.request("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "ai-agent", version: VERSION },
    });
    this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async listTools() { this.tools = (await this.request("tools/list", {})).tools || []; return this.tools; }
  async callTool(name, args, timeoutMs) {
    const res = await this.request("tools/call", { name, arguments: args || {} }, timeoutMs || 120000);
    const parts = (res.content || []).map(c =>
      c.type === "text" ? c.text : `[${c.type}] ` + JSON.stringify(c));
    return [!res.isError, parts.join("\n") || "[no output]"];
  }
  stop() {
    if (this.transport === "stdio") {
      try { this.proc?.kill(); } catch {}
    } else {
      try { this.sseSource?.close(); } catch {}
    }
  }
  _failAll(err) { for (const [, { reject }] of this.pending) reject(err); this.pending.clear(); }
}

async function connectMcp() {
  const servers = loadMcpServers();
  for (const [sname, scfg] of Object.entries(servers)) {
    const client = new McpClient(sname, scfg);
    try {
      await client.start();
      await client.initialize();
      const tools = await client.listTools();
      mcpClients.set(sname, client);
      // OpenAI-style function names must match ^[A-Za-z0-9_-]{1,64}$ — anything else makes the
      // whole request fail with 400 and would take every tool down with it.
      const fnName = s => String(s).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";
      for (const t of tools) {
        let exposed = fnName(t.name);
        if (TOOLS.some(x => x.function.name === exposed) || mcpRegistry.has(exposed))
          exposed = fnName(`${sname}__${t.name}`);
        let n = 2; const base = exposed;
        while (mcpRegistry.has(exposed)) exposed = fnName(`${base.slice(0, 60)}_${n++}`);
        mcpRegistry.set(exposed, { client, realName: t.name, schema: t });
      }
      console.log(dim(`✓ MCP '${sname}' connected (${tools.length} tools)`));
    } catch (e) {
      console.log(yellow(`! MCP server '${sname}' failed: ${e.message}`));
      client.stop();
    }
  }
}
async function ensureMcp() { if (!mcpReady) { mcpReady = true; await connectMcp(); } }

function enrichMcpDesc(name, desc) {
  const d = (desc || "").trim();
  if (/full-web-search/i.test(name))
    return "PRIMARY tool for live internet research. Search the web and extract page content. Use instead of curl/wget. " + d;
  if (/get-web-search-summaries/i.test(name))
    return "Quick live web search (titles + snippets only). Use this first for 'search the web' / current facts. Never use shell curl. " + d;
  if (/get-single-web-page-content/i.test(name))
    return "Fetch and extract main text from one URL. Use instead of curl. " + d;
  if (/search|web/i.test(name) && !d) return "Live web search MCP tool. Use this instead of curl/wget.";
  return d || "MCP tool";
}
function allTools() {
  const mcp = [];
  for (const [exposed, { schema }] of mcpRegistry) {
    mcp.push({ type: "function", function: {
      name: exposed,
      description: enrichMcpDesc(exposed, schema.description),
      parameters: schema.inputSchema || { type: "object", properties: {} },
    }});
  }
  // MCP first so the model sees search tools before shell
  return [...mcp, ...TOOLS];
}
function mcpPromptBlurb() {
  if (!mcpRegistry.size) return "";
  const names = [...mcpRegistry.keys()];
  return "\nWEB SEARCH MCP (required for any live internet / current-events / URL fetch): " +
    names.join(", ") +
    ". Do not use the shell tool with curl, wget, or similar. Call these tools by name as JSON function calls.";
}

// ------------------------------------------------------------------ config
function loadCfg() {
  const cfg = { apiUrl: "", model: "", apiKey: "", context: 0, maxout: 10000,
                maxTokens: 0, tools: true, system: "", timeout: 180, projectDir: "",
                intercept: false, autoYes: false, maxSteps: 0, autoPlan: true,
                blockedCommands: DEFAULT_BLOCKED,
                draftModel: "", temperature: null,
                reasoning: "", redact: true, mode: "code", stream: true };
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_PATH, "utf8"))); } catch {}
  return cfg;
}
function saveCfg(cfg) {
  // keys starting with "_" are per-session runtime state (e.g. a server that rejected
  // stream_options or tools) and must not stick to the next session
  const persisted = Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith("_")));
  try { fs.writeFileSync(CFG_PATH, JSON.stringify(persisted, null, 2), { mode: 0o600 }); } catch {}
}
// NOTE: intentionally says NOTHING about secret masking — the model must never
// learn that values are substituted. Round-tripping handles it transparently.
const systemPrompt = (cfg, userPrompt = "") => {
  let s = "";
  if (cfg.mode === "ask") {
    s = "You are an expert AI assistant. The user is in ASK mode. Answer questions directly and conversationally. Do NOT use any tools, do NOT read or write files, and do NOT execute commands. Just provide helpful text responses.";
  } else if (cfg.mode === "plan") {
    s = "You are an expert autonomous software-engineering agent. The user is in PLAN mode. Analyze the project and turn the request into a concrete plan: state the goal in one sentence and break it into 3-12 verifiable tasks, recording them with `update_plan` (every task needs a `verify` check that would prove it works). Use read-only tools (read_file, shell for searching) to gather context, but DO NOT write, edit, or execute any mutating commands. Finish with a short readable summary of the plan.";
  } else {
    s = cfg.system || SYS_PROMPT;
  }
  s += `\nOperating system: ${osDescription()} · shell: ${SHELL_NAME}. Use ONLY commands valid for this OS and shell` +
    (IS_WIN ? " (cmd.exe syntax: dir, type, findstr, set VAR=…; not bash, not PowerShell)." : " (POSIX sh syntax: ls, cat, grep, export VAR=…; not cmd.exe, not PowerShell).");
  if (cfg.mode !== "ask") {
    if (cfg.autoPlan === false && PLAN?.explicit !== true)
      s += "\nPLANNING: auto-planning is OFF for this user. Do NOT call `update_plan` and do not write a task list — just do the work directly and reply concisely.";
    s += planPromptBlock();
  }
  s += mcpPromptBlurb();
  s += commandHints();
  const blocked = cfg.blockedCommands || DEFAULT_BLOCKED;
  if (blocked.length) s += `\n- BLOCKED command patterns (never run these): ${blocked.join("  |  ")}`;
  if (cfg.projectDir)
    s += `\nWorking directory (project folder): ${cfg.projectDir} — run all commands and resolve all file paths relative to it.`;
  if (userPrompt) {
    const recalled = searchMemory(userPrompt, cfg.projectDir);
    if (recalled.length) {
      s += "\n\nRELEVANT PAST MEMORIES (treat as hints, NOT absolute truth):\n";
      s += "IMPORTANT: Project states change. If a memory contradicts what your tools show, TRUST THE TOOLS and ignore the memory.\n";
      for (const m of recalled) s += `- [${m.type}] ${m.content}\n`;
    }
  }
  return s;
};

// ------------------------------------------------------------------ project dir
function applyProjectDir(cfg, strict = true) {
  if (!cfg.projectDir) return false;
  const dir = path.resolve(expandUser(String(cfg.projectDir)));
  let ok = false;
  try { ok = fs.statSync(dir).isDirectory(); } catch {}
  if (!ok) {
    if (strict) throw new ApiError(`project folder not found: ${dir}`);
    console.log(yellow(`! project folder not found: ${dir} — ignoring`));
    cfg.projectDir = "";
    return false;
  }
  cfg.projectDir = dir;
  try { process.chdir(dir); } catch {}
  return true;
}
function setProjectDir(cfg, history, value) {
  if (!value || value === "-") {
    cfg.projectDir = "";
    if (history?.length) history[0].content = systemPrompt(cfg);
    saveCfg(cfg);
    console.log(dim("✓ project dir cleared (using process cwd: " + process.cwd() + ")"));
    return;
  }
  const old = cfg.projectDir;
  cfg.projectDir = value;
  try { applyProjectDir(cfg, true); }
  catch (e) {
    cfg.projectDir = old;
    try { if (old) process.chdir(old); } catch {}
    console.log(red(String(e.message)));
    return;
  }
  if (history?.length) history[0].content = systemPrompt(cfg);
  saveCfg(cfg);
  console.log(dim(`✓ project dir: ${displayPath(cfg.projectDir)}`));
}

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}
async function askSecret(q) {
  process.stdout.write(q);
  const wasRaw = process.stdin.isRaw;
  let s = "";
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    await new Promise(res => {
      const on = c => {
        for (const b of c) {
          if (b === 3) s = "";
          else if (b === 13 || b === 10) { process.stdin.removeListener("data", on); res(); }
          else if (b === 127 || b === 8) s = s.slice(0, -1);
          else if (b >= 32) s += String.fromCharCode(b);
        }
      };
      process.stdin.on("data", on);
    });
  } finally {
    try { process.stdin.setRawMode(wasRaw ?? false); } catch {}
    process.stdout.write("\n");
  }
  return s;
}
async function setup(cfg) {
  console.log(bold("◆ ai-agent first-run setup") + dim("  → saved to " + CFG_PATH));
  cfg.apiUrl = (await ask(`API base URL or alias (${Object.keys(ALIASES).join(" ")}): `)) || "openai";
  cfg.model = await ask("Model (blank = auto-detect): ");
  const key = await askSecret("API key (hidden; blank to skip): ");
  if (key) cfg.apiKey = key;
  const dir = await ask("Project folder (blank = current dir): ");
  if (dir) { cfg.projectDir = dir; applyProjectDir(cfg, false); }
  saveCfg(cfg);
}

// ------------------------------------------------------------------ http
function normalizeBase(u) {
  u = (u || "").trim().replace(/\/+$/, "");
  u = ALIASES[u.toLowerCase()] || u;
  if (u.endsWith("/chat/completions")) u = u.slice(0, -"/chat/completions".length);
  if (!/\/v\d+$/.test(u)) u += "/v1";
  return u;
}
const completionUrl = u => normalizeBase(u) + "/chat/completions";
const modelsUrl = u => normalizeBase(u) + "/models";

async function errText(res) {
  try {
    const t = await res.text();
    try { const j = JSON.parse(t); return j.error?.message || j.message || t.slice(0, 300); }
    catch { return t.slice(0, 300); }
  } catch { return res.statusText; }
}
async function httpJson(method, url, key, payload) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch (e) {
    throw new ApiError(`request failed: ${e.cause?.message || e.message}`);
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status} ${await errText(res)}`);
  return res.json();
}
async function fetchModels(cfg) {
  if (!cfg.apiUrl) throw new ApiError("no API URL configured");
  const j = await httpJson("GET", modelsUrl(cfg.apiUrl), cfg.apiKey);
  return Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
}

// ------------------------------------------------------------------ context detection
const KNOWN_CTX = [
  [/gpt-4o-mini/, 128000], [/gpt-4o|chatgpt-4o/, 128000], [/gpt-4\.1/, 1047576],
  [/gpt-4-turbo|gpt-4-0125|gpt-4-1106/, 128000], [/^gpt-4$/, 8192], [/gpt-3\.5-turbo/, 16383],
  [/o[134]-mini|\bo1\b|\bo3\b|\bo4\b/, 200000],
  [/claude-(3[.-]7|3[.-]5|sonnet-4|opus-4)/, 200000],
  [/deepseek-r1/, 128000], [/deepseek-(v3|chat)/, 65536],
  [/llama3[.-]?3?-70b|llama3[.-]1/, 131072], [/llama3/, 8192],
  [/qwen3|qwen2[.-]5/, 131072], [/qwen.*coder/, 131072],
  [/gemini-2[.-]5/, 1048576], [/gemini-1[.-]5/, 2097152],
  [/mistral-large/, 128000], [/mixtral/, 32768],
];
const knownCtx = model => { for (const [re, n] of KNOWN_CTX) if (re.test(model)) return n; return 0; };

async function detectLocalShow(cfg) {
  const base = normalizeBase(cfg.apiUrl).replace(/\/v\d+$/, "");
  if (!/:11434/.test(base)) return 0;
  try {
    const j = await httpJson("POST", base + "/api/show", null, { name: cfg.model });
    for (const k of Object.keys(j.model_info || {})) {
      const v = j.model_info[k];
      if (k.endsWith(".context_length") && Number.isInteger(v) && v > 0) return v;
    }
    if (Number.isInteger(j.context_length) && j.context_length > 0) return j.context_length;
  } catch {}
  return 0;
}
async function autoContext(cfg, models) {
  if (models?.length) {
    const m = models.find(x => x.id === cfg.model);
    const v = m && ["context_length", "context_window", "max_context_length", "max_context"]
      .map(k => m[k]).find(x => Number.isInteger(x) && x > 0);
    if (v) { cfg.context = v; return "API metadata"; }
  }
  const lv = await detectLocalShow(cfg);
  if (lv) { cfg.context = lv; return "local model info"; }
  const kv = knownCtx(cfg.model || "");
  if (kv) { cfg.context = kv; return "known model"; }
  return null;
}
async function detectContext(cfg, models) {
  if (!models) {
    spin.start("detecting context…");
    try { models = await fetchModels(cfg); }
    catch (e) { console.log(red("cannot list models: " + e.message)); }
    finally { spin.stop(); }
  }
  const src = await autoContext(cfg, models);
  if (src) console.log(dim(`context: ${cfg.context} tokens (detected via ${src})`));
  else console.log(dim("context: could not detect — set manually: /set context <n>"));
}
async function resolveCfg(cfg) {
  let models = [];
  spin.start("connecting… listing models");
  try { models = await fetchModels(cfg); }
  catch (e) { console.log(dim(`(could not list models: ${e.message})`)); }
  finally { spin.stop(); }
  if (!cfg.model) {
    const ids = models.map(m => m.id).filter(Boolean).sort();
    if (ids.length) {
      cfg.model = ids[0];
      console.log(dim(`model: auto-selected '${ids[0]}' of ${ids.length} — change with /set model <name>`));
    } else cfg.model = await ask("Model name: ");
  }
  if (!cfg.context) {
    const src = await autoContext(cfg, models);
    if (src) console.log(dim(`context: ${cfg.context} tokens (detected via ${src})`));
    else console.log(dim("context: unknown — /set context <n> enables trimming"));
  }
}

// ------------------------------------------------------------------ tool-call accumulation
function mergeToolCallChunk(slots, tc) {
  const id = tc.id ? String(tc.id) : "";
  const idx = tc.index !== undefined && tc.index !== null && tc.index !== "" ? Number(tc.index) : null;
  const name = tc.function?.name ? String(tc.function.name) : "";
  let args = tc.function?.arguments;
  if (args && typeof args === "object") args = JSON.stringify(args);
  args = args ? String(args) : "";

  let slot = null;
  if (id) slot = slots.find(s => s.id === id) || null;
  if (!slot && idx !== null && Number.isFinite(idx)) {
    const cands = slots.filter(s => s.index === idx && (!id || !s.id || s.id === id));
    slot = cands[cands.length - 1] || null;
    if (slot && args && /^\s*[{[]/.test(args) &&
        tryParse(slot.arguments) !== undefined && args !== slot.arguments) {
      slot = null;
    }
  }
  if (!slot && !id && idx === null && slots.length) {
    const last = slots[slots.length - 1];
    const complete = tryParse(last.arguments) !== undefined;
    if (!(complete && args && /^\s*[{[]/.test(args) && args !== last.arguments)) slot = last;
  }

  if (!slot) { slot = { id: "", index: idx, name: "", arguments: "" }; slots.push(slot); }
  if (id && !slot.id) slot.id = id;
  if (slot.index === null && idx !== null) slot.index = idx;
  if (name) slot.name = slot.name.endsWith(name) ? slot.name : slot.name + name;
  if (args) {
    const dupResend = slot.arguments === args && tryParse(args) !== undefined;
    if (!dupResend) slot.arguments += args;
  }
}
function splitRepeated(name, k) {
  if (!name || k <= 1) return [name];
  for (let L = 1; L <= Math.floor(name.length / 2); L++) {
    if (name.length % L === 0) {
      const p = name.slice(0, L);
      if (p.repeat(name.length / L) === name) return Array(name.length / L).fill(p);
    }
  }
  return [name];
}
function repairToolCalls(slots) {
  const out = [];
  for (const s of slots) {
    if (tryParse(s.arguments) !== undefined || !s.arguments.trim()) { out.push(s); continue; }
    const parts = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < s.arguments.length; i++) {
      const ch = s.arguments[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") { if (depth === 0) start = i; depth++; }
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0 && start >= 0) { parts.push(s.arguments.slice(start, i + 1)); start = -1; }
      }
    }
    const valid = parts.filter(p => tryParse(p) !== undefined);
    if (valid.length >= 2) {
      const names = splitRepeated(s.name, valid.length);
      valid.forEach((p, i) => out.push({
        id: i === 0 ? s.id : "", index: s.index,
        name: names[i] || names[0] || "", arguments: p,
      }));
    } else out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------ streaming
// cfg.stream === false → single JSON reply ("stream": false), otherwise SSE chunks.
// Both modes yield the same events: {type:"thinking"} / {type:"delta"} / {type:"end", result}.
async function* streamChat(cfg, messages, tools, signal) {
  const nonStream = cfg.stream === false;
  const payload = { model: cfg.model, messages, stream: !nonStream };
  if (tools?.length) payload.tools = tools;
  if (cfg.maxTokens) payload.max_tokens = cfg.maxTokens;
  if (!nonStream && !cfg._noStreamOpts) payload.stream_options = { include_usage: true };
  if (cfg.draftModel) payload.draft_model = cfg.draftModel;
  if (typeof cfg.temperature === "number" && !isNaN(cfg.temperature)) payload.temperature = cfg.temperature;
  if (cfg.reasoning) payload.reasoning_effort = cfg.reasoning;

  let res;
  try {
    res = await fetch(completionUrl(cfg.apiUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: nonStream ? "application/json" : "text/event-stream",
        ...(cfg.apiKey ? { Authorization: "Bearer " + cfg.apiKey } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError(`request failed: ${e.cause?.message || e.message}`);
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status} ${await errText(res)}`);
  if (!res.body) throw new ApiError("empty response body");

  // Route on what the server actually sent, not on what we asked for: some servers answer a
  // stream request with one JSON body (and vice versa).
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/event-stream")) { yield* sseChatEvents(res); return; }
  if (ct.includes("application/json") || nonStream) { yield* jsonChatEvents(res); return; }
  yield* sseChatEvents(res);
}

async function* sseChatEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", thinking = "", finish = null, done = false, usage = null;
  const tcs = [];

  try {
    while (!done) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "").trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; break; }
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new ApiError(typeof j.error === "string" ? j.error : (j.error.message || JSON.stringify(j.error)));
        if (j.usage && (j.usage.prompt_tokens != null || j.usage.total_tokens != null)) usage = j.usage;
        const ch = j.choices?.[0];
        if (!ch) continue;
        const d = ch.delta || ch.message || {};
        const t = d.reasoning_content || d.reasoning || d.thinking;
        if (t) { thinking += t; yield { type: "thinking", text: t }; }
        if (d.content) { content += d.content; yield { type: "delta", text: d.content }; }
        for (const tc of d.tool_calls || []) mergeToolCallChunk(tcs, tc);
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  if (!content && !thinking && !tcs.length && buf.trim().startsWith("{")) {
    try {
      const j = JSON.parse(buf);
      const m = j.choices?.[0]?.message || {};
      content = m.content || "";
      if (j.usage) usage = j.usage;
      for (const tc of m.tool_calls || []) {
        const a = tc.function?.arguments;
        tcs.push({ id: tc.id || "", index: tc.index ?? null, name: tc.function?.name || "",
                   arguments: typeof a === "object" ? JSON.stringify(a) : (a || "") });
      }
    } catch {}
  }

  yield { type: "end", result: {
    content, thinking, finish, usage,
    toolCalls: repairToolCalls(tcs),
  } };
}

// Non-streaming mode ("stream": false): one JSON body with the complete message.
async function* jsonChatEvents(res) {
  let j;
  const text = await res.text();
  try {
    j = JSON.parse(text);
  } catch (e) {
    // mislabelled SSE body → salvage it through the SSE parser
    if (/^\s*(data:|:)/m.test(text)) {
      yield* sseChatEvents(new Response(text, { headers: { "content-type": "text/event-stream" } }));
      return;
    }
    throw new ApiError("invalid JSON response body: " + text.slice(0, 200));
  }
  if (j.error) throw new ApiError(typeof j.error === "string" ? j.error : (j.error.message || JSON.stringify(j.error)));
  const ch = j.choices?.[0] || {};
  const m = ch.message || ch.delta || {};
  const think = m.reasoning_content || m.reasoning || m.thinking || "";
  if (think) yield { type: "thinking", text: think };
  if (m.content) yield { type: "delta", text: m.content };
  const tcs = [];
  for (const tc of m.tool_calls || []) {
    const a = tc.function?.arguments;
    tcs.push({
      id: tc.id || "", index: tc.index ?? null, name: tc.function?.name || "",
      arguments: typeof a === "object" ? JSON.stringify(a) : (a || ""),
    });
  }
  yield { type: "end", result: {
    content: m.content || "", thinking: think,
    finish: ch.finish_reason || null, usage: j.usage || null,
    toolCalls: repairToolCalls(tcs),
  } };
}

// ------------------------------------------------------------------ markdown-lite
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g;
class MDStream {
  constructor() { this.buf = ""; this.fence = false; }
  feed(s) {
    this.buf += s;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this._emit(line, "\n");
    }
    if (this.buf.length > 200) { this._emit(this.buf, ""); this.buf = ""; }
  }
  flush() { if (this.buf) { this._emit(this.buf, ""); this.buf = ""; } }
  _emit(line, end) {
    const s = line.trim();
    if (s.startsWith("```")) { this.fence = !this.fence; process.stdout.write(dim(line) + end); }
    else if (this.fence) process.stdout.write(cyan(line) + end);
    else if (s.startsWith("#")) process.stdout.write(bold(line) + end);
    else {
      if (USE_COLOR) line = line.replace(INLINE, (m, code, b) => (code ? yellow(code) : bold(b)));
      process.stdout.write(line + end);
    }
  }
}

// ------------------------------------------------------------------ tools
function truncate(s, cap) {
  cap = Number(cap) || 0;
  if (!cap || s.length <= cap) return s;
  const head = Math.floor(cap * 0.7);
  return s.slice(0, head) + `\n…[${s.length - cap} chars truncated]…\n` + s.slice(head - cap);
}
function fmtCall(name, args) {
  if (name === "shell") return "$ " + String(args.command || args._raw || "");
  if (name === "update_plan") {
    const bits = [];
    if (args.goal) bits.push(`goal: ${String(args.goal).slice(0, 60)}`);
    if (Array.isArray(args.tasks)) {
      const done = args.tasks.filter(t => normalizeStatus(t?.status) === "done").length;
      bits.push(`${args.tasks.length} tasks (${done} done)`);
    }
    if (Array.isArray(args.updates)) bits.push(args.updates.map(u => `${u.id}→${u.status}`).join(", "));
    else if (args.id || args.task_id) bits.push(`${args.id || args.task_id}→${args.status}`);
    return bits.join(" · ") || "(empty)";
  }
  if (name === "read_file") {
    if (Array.isArray(args.paths)) return `read ${args.paths.length} files: ${args.paths.join(", ")}`;
    let r = `read ${args.path || "?"}`;
    if (args.start || args.end) r += ` [${args.start || 1}-${args.end || "end"}]`;
    return r;
  }
  if (name === "str_replace") return `edit ${args.path || "?"} (${String(args.old_str || "").split("\n").length} lines)`;
  if (name === "write_file") return `write ${args.path || "?"} (${String(args.content || "").length} chars)`;
  if (name === "remember") return `remember [${args.type || "?"}] ${String(args.content || "").slice(0, 60)}`;
  if (name === "forget") return `forget ${args.memory_id || "?"}`;
  return JSON.stringify(args).slice(0, 160);
}
const resolveP = (p, cfg) => path.resolve(cfg?.projectDir || process.cwd(), expandUser(String(p || "")));

let currentChild = null;
function runShell(cmd, timeoutSec, opts = {}, cfg = {}) {
  const policy = checkCommandPolicy(cmd, cfg);
  if (!policy.allowed) {
    return Promise.resolve([false,
      `error: command blocked by policy (matched "${policy.pattern}"). Use an allowed alternative such as cmd.`]);
  }

  const shell = IS_WIN ? "cmd.exe" : undefined;

  if (opts.background) {
    try {
      const child = spawn(cmd, {
        shell: shell || "/bin/sh",
        detached: true, stdio: "ignore", windowsHide: true,
        cwd: opts.cwd || process.cwd(),
      });
      child.unref();
      recordCommand(cmd, true, "[background]");
      return Promise.resolve([true, `started in background (pid ${child.pid}): ${cmd}`]);
    } catch (e) {
      return Promise.resolve([false, `error: ${e.message}`]);
    }
  }

  // spawn (not exec) in its own process group: killing only `sh -c` would leave the real
  // command (a hung server, `sleep`, a test runner) alive and holding the pipes, so a timeout
  // or ctrl+c would block until it exited on its own.
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(cmd, {
        shell: shell || "/bin/sh", windowsHide: true, cwd: opts.cwd || process.cwd(),
        detached: !IS_WIN, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) { return resolve([false, `error: ${e.message}`]); }
    const MAX = 8 * 1024 * 1024;
    let stdout = "", stderr = "", size = 0, timedOut = false, interrupted = false, overflow = false, settled = false;
    const killTree = () => {
      if (IS_WIN) { try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {} }
      else { try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} } }
      setTimeout(() => { if (!settled) { try { IS_WIN ? child.kill() : process.kill(-child.pid, "SIGKILL"); } catch {} } }, 2000).unref();
    };
    const grab = which => d => {
      const s = String(d);
      size += s.length;
      if (which === "out") stdout += s; else stderr += s;
      if (size > MAX && !overflow) { overflow = true; killTree(); }
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", grab("out")); child.stderr.on("data", grab("err"));
    const timer = setTimeout(() => { timedOut = true; killTree(); }, Math.max(1, timeoutSec) * 1000);
    const finish = (code, signal, spawnErr) => {
      if (settled) return; settled = true;
      clearTimeout(timer); currentChild = null;
      if (spawnErr) return resolve([false, `error: ${spawnErr.message}`]);
      let text = stdout || "";
      if (stderr) text += "\n[stderr]\n" + stderr;
      if (!text.trim()) text = "[no output]";
      text = text.trim();
      if (interrupted) return resolve([false, `error: interrupted by the user\n${truncate(text, 2000)}`]);
      if (timedOut) return resolve([false,
        `error: terminated after ${timeoutSec}s. If this is a server/watcher, rerun with background=true.\n${truncate(text, 4000)}`]);
      if (overflow) return resolve([false, `error: output exceeded ${MAX} bytes — pipe it through head/tail/grep\n${truncate(text, 4000)}`]);
      if (code !== 0) {
        recordCommand(cmd, false, text);
        return resolve([false, `[exit code ${code ?? signal ?? 1}]\n${text}`]);
      }
      recordCommand(cmd, true, text);
      resolve([true, text]);
    };
    child.on("error", e => finish(null, null, e));
    child.on("close", (code, signal) => finish(code, signal));
    currentChild = { pid: child.pid, kill: () => { interrupted = true; killTree(); } };
  });
}
function toolUpdatePlan(a, cfg) {
  if (!a || (!Array.isArray(a.tasks) && !Array.isArray(a.updates) && !(a.id || a.task_id) && !a.goal))
    return [false, "error: update_plan needs `tasks` (full list), or `updates`/`task_id`+`status` to change state"];
  return applyPlanUpdate(a, cfg);
}
function toolRead(a, cfg) {
  // `paths`: several files in ONE call — saves a round trip per file.
  const many = Array.isArray(a.paths) ? a.paths.map(String).filter(Boolean) : [];
  if (many.length) {
    const cap = Math.max(2000, Math.floor((Number(cfg?.maxout) || 24000) / many.length));
    const parts = [];
    let anyOk = false;
    for (const p of many.slice(0, 12)) {
      let ok, txt;
      try { [ok, txt] = toolRead({ path: p }, cfg); }   // one missing file must not sink the batch
      catch (e) { ok = false; txt = `error: could not read '${p}' (${e.code || e.message})`; }
      if (ok) anyOk = true;
      let body = txt;
      if (ok && body.length > cap)
        body = body.slice(0, cap) + `\n…[${body.length - cap} more chars not shown — read_file with path=${JSON.stringify(p)} alone (or start/end) for the rest]`;
      parts.push(`===== ${p} ${ok ? "" : "(FAILED)"} =====\n${body}`);
    }
    if (many.length > 12) parts.push(`…and ${many.length - 12} more files not read (12 per call)`);
    return [anyOk, parts.join("\n\n")];
  }
  if (!String(a.path || "").trim()) return [false, "error: read_file needs `path` (one file) or `paths` (several)"];
  const p = resolveP(a.path, cfg);
  if (isProtectedPath(p)) return [false, `error: could not read file '${a.path}' (no such file)`];
  let fd;
  try { fd = fs.openSync(p, "r"); }
  catch (e) { return [false, `error: could not read file '${a.path}' (${e.code || e.message})`]; }
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) return [false, `error: '${a.path}' is a directory — use shell (ls/dir) to list it`];
    const size = Math.min(st.size, 2_000_000);
    const b = Buffer.alloc(size);
    fs.readSync(fd, b, 0, size, 0);
    if (b.subarray(0, Math.min(size, 8000)).includes(0))
      return [false, `error: '${a.path}' looks like a binary file (${st.size} bytes) — not shown`];
    const lines = b.toString("utf8").split("\n");
    const total = lines.length;
    const s = Math.max(1, parseInt(a.start, 10) || 1);
    let e = Math.min(total, parseInt(a.end, 10) || total);
    if (e < s) e = Math.min(total, s);
    const seg = lines.slice(s - 1, e).join("\n");
    let info = a.start || a.end ? `[${total} lines total, showed ${s}-${e}]\n` : "";
    if (st.size > size) info += `[file is ${st.size} bytes; only the first ${size} bytes were read]\n`;
    return [true, info + (seg || "[empty file]")];
  } finally { fs.closeSync(fd); }
}
function toolStrReplace(a, cfg) {
  const p = resolveP(a.path, cfg);
  if (isProtectedPath(p)) return [false, `error: could not open file '${a.path}' (no such file)`];
  let original;
  try { original = fs.readFileSync(p, "utf8"); }
  catch (e) { return [false, `error: could not read file '${p}' (${e.code || e.message})`]; }
  // silently map any dummy tokens back to the real values before matching/writing
  const oldStr = restoreSecrets(String(a.old_str ?? a.old_string ?? ""));
  const newStr = restoreSecrets(String(a.new_str ?? a.new_string ?? ""));
  if (!oldStr) return [false, "error: old_str cannot be empty"];
  // Only the agent's own omission markers count — a file that merely contains the word
  // "truncated" (log handling, tests, this very agent) must stay editable.
  if (/…\[\d+ (chars|more chars)[^\]]*\]…?|\[\.\.\.middle omitted\.\.\.\]|…and \d+ more files not read/.test(oldStr)) {
    return [false, "error: old_str contains an omission marker from a previous tool result ('…[N chars truncated]…'). You cannot replace text you haven't read. Use `read_file` with `start`/`end` line numbers to read the exact lines, then try again."];
  }
  if (oldStr === newStr) return [false, "error: old_str and new_str are identical — nothing to change. If the file already looks right, move on."];
  const normOrig = original.replace(/\r\n/g, "\n");
  const normOld = oldStr.replace(/\r\n/g, "\n");
  const normNew = newStr.replace(/\r\n/g, "\n");
  let idx = normOrig.indexOf(normOld), len = normOld.length, note = "";
  if (idx >= 0) {
    if (normOrig.indexOf(normOld, idx + 1) >= 0) {
      const occurrences = normOrig.split(normOld).length - 1;
      return [false, `error: old_str matches ${occurrences} times. Include more context to make it unique.`];
    }
  } else {
    // second chance: trailing whitespace at line ends is the most common exact-match failure
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const loose = new RegExp(normOld.split("\n").map(l => esc(l.replace(/[ \t]+$/, "")) + "[ \\t]*").join("\n"), "g");
    const hits = [...normOrig.matchAll(loose)].filter(m => m[0].trim());
    if (hits.length === 1) { idx = hits[0].index; len = hits[0][0].length; note = " (matched ignoring trailing whitespace)"; }
    else if (hits.length > 1) return [false, `error: old_str matches ${hits.length} times. Include more context to make it unique.`];
    else return [false, `error: old_str not found in file. Ensure exact match (check indentation/whitespace).`];
  }
  // splice by index — String.replace would interpret $&, $', $$ … in new_str and corrupt the file
  const updated = normOrig.slice(0, idx) + normNew + normOrig.slice(idx + len);
  const finalContent = original.includes("\r\n") ? updated.replace(/\n/g, "\r\n") : updated;
  fs.writeFileSync(p, finalContent);
  return [true, `replaced 1 occurrence in ${displayPath(p)}${note}`];
}
function toolWrite(a, cfg) {
  const p = resolveP(a.path, cfg);
  if (isProtectedPath(p)) return [false, `error: could not write file '${a.path}' (no such directory)`];
  const content = restoreSecrets(String(a.content || ""));   // dummy -> real
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return [true, `wrote ${content.length} chars to ${p}`];
}
function toolRemember(a, cfg) {
  const mem = loadMemory();
  const entry = {
    id: Date.now().toString(36),
    type: a.type || "lesson",
    content: String(a.content || ""),
    keywords: extractKeywords(a.content),
    projectDir: cfg?.projectDir || "global",
    timestamp: Date.now(),
  };
  if (!mem.memories.some(m => m.content === entry.content && m.projectDir === entry.projectDir)) {
    mem.memories.push(entry);
    if (mem.memories.length > 500) mem.memories.shift();
    saveMemory(mem);
  }
  return [true, `saved to long-term memory (${entry.type}, id:${entry.id})`];
}
function toolForget(a) {
  const mem = loadMemory();
  const before = mem.memories.length;
  mem.memories = mem.memories.filter(m => m.id !== a.memory_id);
  if (mem.memories.length < before) { saveMemory(mem); return [true, `forgot memory ${a.memory_id}`]; }
  return [false, `memory ${a.memory_id} not found`];
}
// Tool arguments as the model sent them → a plain object. Invalid JSON is kept in `_raw`
// (some servers hand over a bare command string as the arguments).
function parseToolArgs(raw) {
  const s = raw == null ? "" : String(raw);
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
    return { _raw: typeof v === "string" ? v : s };
  } catch {
    // strings some models forget to escape, wrapped in one more pair of braces/fence
    const m = s.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
    if (m) return parseToolArgs(m[1]);
    return { _raw: s };
  }
}
function shellCommandOf(args) {
  if (args.command != null && String(args.command).trim()) return [String(args.command), null];
  if (typeof args.cmd === "string" && args.cmd.trim()) return [args.cmd, null];
  const raw = String(args._raw || "").trim();
  if (!raw) return [null, "error: shell needs a `command` string, e.g. {\"command\": \"ls -la\"}"];
  if (/^[{[]/.test(raw)) return [null, "error: the tool call arguments were not valid JSON — resend the call as {\"command\": \"<your command>\"}"];
  return [raw, null];
}
async function runTool(name, args, cfg) {
  try {
    if (!args || typeof args !== "object") args = {};
    let out;
    if (mcpRegistry.has(name)) {
      const { client, realName } = mcpRegistry.get(name);
      const mcpArgs = { ...args }; delete mcpArgs._raw;
      out = await client.callTool(realName, mcpArgs, (cfg.timeout || 180) * 1000);
    }
    else if (name === "update_plan") out = toolUpdatePlan(args, cfg);
    else if (name === "shell") {
      const [cmd, err] = shellCommandOf(args);
      out = err ? [false, err] : await runShell(cmd, cfg.timeout || 180, { background: args.background === true || args.background === "true", cwd: cfg.projectDir }, cfg);
    }
    else if (name === "read_file") out = toolRead(args, cfg);
    else if (name === "str_replace") out = toolStrReplace(args, cfg);
    else if (name === "write_file") out = toolWrite(args, cfg);
    else if (name === "remember") out = toolRemember(args, cfg);
    else if (name === "forget") out = toolForget(args);
    else return [false, `error: unknown tool '${name}'. Available: ${[...mcpRegistry.keys(), ...TOOLS.map(t => t.function.name)].join(", ")}`];
    if (!Array.isArray(out)) out = [true, String(out ?? "")];
    out[1] = maskSecrets(String(out[1] ?? ""), cfg);   // silent: real -> dummy before the model ever sees it
    if (PLAN) {
      PLAN.calls++;
      if (name === "shell") {
        const cmd = String(args.command || args._raw || "");
        noteShellRan(cmd, !!out[0]);
        if (!isReadOnlyCommand(cmd)) PLAN.mutations++;
      } else if (name === "write_file" || name === "str_replace") {
        PLAN.mutations++;
      }
    }
    return out;
  } catch (e) {
    return [false, `error: ${e.message}`];
  }
}

// ------------------------------------------------------------------ context mgmt / stats
const estTokens = h => Math.max(1, Math.floor(JSON.stringify(h).length / 4));
// Drop h[i] together with the tool results that answer it (if it is an assistant tool-call message).
function spliceExchange(h, i) {
  const m = h[i];
  h.splice(i, 1);
  if (m?.role === "assistant" && Array.isArray(m.tool_calls))
    while (i < h.length && h[i].role === "tool") h.splice(i, 1);
}
// Shrink the conversation to the context budget without losing the request being worked on:
//   1. drop whole exchanges from earlier turns (oldest first),
//   2. then shorten old tool outputs of the current turn to a stub,
//   3. only then drop the oldest steps of the current turn — the user message itself stays.
// `keep` is the user message that opened the current turn (kept by identity, so earlier
// removals cannot shift it away).
function trimHistory(h, cfg, keep = null) {
  const cap = Number(cfg.context) || 0;
  if (!cap) return;
  const budget = cap - 1024 - (Number(cfg.maxTokens) || 0);
  const over = () => estTokens(h) > budget;
  if (!over()) return;
  const keepIdx = () => (keep ? h.indexOf(keep) : -1);
  let k;
  while (over() && h.length > 2 && ((k = keepIdx()) < 0 ? h.length > 2 : k > 1)) spliceExchange(h, 1);
  // never leave the transcript opening with an assistant/tool message (some servers reject that)
  while (h.length > 2 && h[1].role !== "user" && h[1] !== keep) spliceExchange(h, 1);
  if (!over()) return;
  k = keepIdx();
  if (k < 0) return;
  const STUB = 600;
  for (let i = k + 1; i < h.length - 2 && over(); i++) {
    const m = h[i];
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > STUB)
      m.content = m.content.slice(0, STUB) + `\n…[${m.content.length - STUB} chars trimmed to free context — re-read if needed]`;
  }
  while (over() && h.length > k + 3) spliceExchange(h, k + 1);
}
const fmtK = n => {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (Math.round(n / 100000) / 10) + "M";
  if (n >= 1000) return (Math.round(n / 100) / 10) + "k";
  return String(n);
};
function ctxBar(used, cap, w = 10) {
  const pct = cap > 0 ? Math.min(1, used / cap) : 0;
  const n = Math.round(pct * w);
  return "[" + "█".repeat(n) + "░".repeat(w - n) + "] " + Math.round(pct * 100) + "%";
}
function showStats(cfg, history, usage) {
  const cap = Number(cfg.context) || 0;
  const ctxUsed = usage ? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) : estTokens(history);
  let s = usage
    ? `tok ↑${fmtK(usage.prompt_tokens || 0)} ↓${fmtK(usage.completion_tokens || 0)}`
    : `~${fmtK(estTokens(history))} tok (est)`;
  s += cap
    ? ` · ctx ${fmtK(ctxUsed)}/${fmtK(cap)} ${ctxBar(ctxUsed, cap)}`
    : ` · ctx ${fmtK(ctxUsed)} (limit unknown — /set context <n>)`;
  console.log(dim("─ " + s + " ─"));
}
// Make the transcript something every OpenAI-compatible server accepts again:
//   - every assistant tool_call has exactly one tool result right after it (an interrupted
//     turn leaves calls without results → HTTP 400 on every later request),
//   - no orphan tool results, no tool_calls with unparsable arguments,
//   - the first message after the system prompt is a user message.
// Returns the number of fixes applied.
function repairHistory(h) {
  let fixes = 0;
  const out = [];
  let i = 0;
  if (h[0]?.role === "system") { out.push(h[0]); i = 1; }
  while (i < h.length) {
    const m = h[i];
    if (!m || typeof m !== "object" || !m.role) { i++; fixes++; continue; }
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const calls = m.tool_calls.filter(tc => tc?.id && tc.function?.name && tryParse(tc.function.arguments || "{}") !== undefined);
      if (calls.length !== m.tool_calls.length) fixes++;
      // collect the tool results that immediately follow
      const results = new Map();
      let j = i + 1;
      while (j < h.length && h[j]?.role === "tool") { if (!results.has(h[j].tool_call_id)) results.set(h[j].tool_call_id, h[j]); else fixes++; j++; }
      if (!calls.length) {
        out.push({ role: "assistant", content: m.content || "(tool call omitted)" });
        fixes++;
      } else {
        out.push({ ...m, tool_calls: calls });
        for (const tc of calls) {
          const r = results.get(tc.id);
          if (r) out.push(r);
          else { out.push({ role: "tool", tool_call_id: tc.id, content: "error: no result — the call was interrupted before it finished. Re-run it if still needed." }); fixes++; }
        }
      }
      if (results.size > calls.length) fixes++;   // orphans for calls that were dropped
      i = j;
      continue;
    }
    if (m.role === "tool") { i++; fixes++; continue; }   // orphan result
    out.push(m);
    i++;
  }
  // some servers reject a conversation that opens with an assistant/tool message
  const first = out[0]?.role === "system" ? 1 : 0;
  if (out.length > first && out[first].role !== "user") {
    out.splice(first, 0, { role: "user", content: "(earlier messages were trimmed to fit the context window — continue from here)" });
    fixes++;
  }
  if (fixes) { h.length = 0; h.push(...out); }
  return fixes;
}
const sanitizeHistory = repairHistory;

// ------------------------------------------------------------------ /compact
async function compactHistory(cfg, history) {
  if (history.length <= 2) { console.log(dim("nothing to compact")); return; }
  spin.start("compacting context…");
  const sysContent = history[0]?.role === "system" ? history[0].content : systemPrompt(cfg);

  const transcript = history.slice(1).map(m => {
    if (m.role === "user") return `[USER]\n${m.content}`;
    if (m.role === "assistant") {
      let s = `[ASSISTANT]\n${m.content || "(no text)"}`;
      if (m.tool_calls?.length) s += "\ntool calls: " + m.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments})`).join("; ");
      return s;
    }
    if (m.role === "tool") return `[TOOL ${m.tool_call_id || ""}]\n${truncate(String(m.content || ""), 1500)}`;
    return "";
  }).join("\n\n");

  const maxChars = Math.max(20000, (Number(cfg.context) || 32000) * 3);
  let body = transcript;
  if (body.length > maxChars) {
    const head = body.slice(0, Math.floor(maxChars * 0.4));
    const tail = body.slice(-Math.floor(maxChars * 0.55));
    body = head + "\n\n[...middle omitted...]\n\n" + tail;
  }

  const req = "Summarize this coding-agent session into a compact context block so work can continue. " +
    "Preserve exactly: the original task, key decisions, all file paths touched, what is done, what is pending, " +
    "and any constraints/errors. Be factual and terse; no commentary.\n\n=== SESSION ===\n" + body;

  let summary = "";
  try {
    for await (const ev of streamChat(cfg, [
      { role: "system", content: "You are a precise technical summarizer. Output only the summary text." },
      { role: "user", content: req },
    ], [], null)) {
      if (ev.type === "delta") summary += ev.text;
    }
  } catch (e) {
    spin.stop();
    console.log(red("compact failed: " + e.message));
    return;
  }
  spin.stop();
  if (!summary.trim()) { console.log(red("compact failed: empty summary")); return; }

  history.length = 0;
  history.push({ role: "system", content: sysContent });
  history.push({ role: "user", content: "[COMPACTED CONTEXT — summary of the session so far]\n" + summary.trim() + "\n\nContinue the task from this point." });
  history.push({ role: "assistant", content: "Understood — continuing from the compacted context." });
  console.log(dim(`✓ context compacted to ${history.length} messages`));
}

// ------------------------------------------------------------------ XML tool-call fallback
// Some servers/models print tool calls as markup instead of native tool_calls:
// <tool_call> <function=shell> <parameter=command> dir … </parameter> </function> </tool_call>
// Convert that markup into real tool calls and strip it from the message.
function parseTextToolCalls(text) {
  const t = String(text || "");
  const calls = [];

  const safeName = /^[A-Za-z0-9_.-]+$/;

  const unescapeXml = s => String(s || "")
    .replace(/&lt;/g, "\x3c")
    .replace(/&gt;/g, "\x3e")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

  const normalizeToolName = name => {
    name = String(name || "").trim();
    if (!safeName.test(name)) return "";
    if (/^(bash|cmd|terminal|console)$/i.test(name)) return "shell";
    return name;
  };

  const pushCall = (name, args) => {
    name = normalizeToolName(name);
    if (!name) return;
    calls.push({
      id: "",
      name,
      arguments: JSON.stringify(args || {}),
    });
  };

  const parseChildTags = body => {
    const args = {};
    const tagRe = new RegExp("\\x3c([A-Za-z0-9_.-]+)\\b[^\\x3e]*\\x3e([\\s\\S]*?)(?:\\x3c\\/\\1\\x3e|$)", "gi");
    let m;
    while ((m = tagRe.exec(body))) {
      const key = m[1];
      if (!safeName.test(key)) continue;
      args[key] = unescapeXml(m[2].trim());
    }
    return args;
  };

  const parseToolBody = body => {
    const innerToolRe = new RegExp("\\x3c([A-Za-z0-9_.-]+)\\b[^\\x3e]*\\x3e([\\s\\S]*?)(?:\\x3c\\/\\1\\x3e|$)", "gi");
    let m;
    let found = false;

    while ((m = innerToolRe.exec(body))) {
      const rawName = m[1];
      if (!safeName.test(rawName)) continue;

      const lower = rawName.toLowerCase();
      if (["command", "path", "start", "end", "old_str", "new_str", "content", "input", "arguments"].includes(lower)) continue;

      const toolName = normalizeToolName(rawName);
      if (!toolName) continue;

      const inner = m[2];
      let args = parseChildTags(inner);

      if (args.arguments || args.input) {
        const maybeJson = args.arguments || args.input;
        try {
          const obj = JSON.parse(maybeJson);
          if (obj && typeof obj === "object") args = obj;
        } catch {}
      }

      if (toolName === "shell" && !args.command) {
        const cmdMatch = inner.match(new RegExp("\\x3ccommand\\b[^\\x3e]*\\x3e([\\s\\S]*?)(?:\\x3c\\/command\\x3e|$)", "i"));
        if (cmdMatch) args.command = unescapeXml(cmdMatch[1].trim());
        else {
          const flat = unescapeXml(inner.replace(new RegExp("\\x3c[^\\x3e]+\\x3e", "g"), "").trim());
          if (flat) args.command = flat;
        }
      }

      pushCall(toolName, args);
      found = true;
    }

    if (!found) {
      const args = parseChildTags(body);
      if (args.command) pushCall("shell", args);
    }
  };

  // Existing format: function=name with parameter children.
  if (/\x3cfunction=/i.test(t)) {
    const fnRe = new RegExp("\\x3cfunction=([A-Za-z0-9_.-]+)\\x3e([\\s\\S]*?)(?:\\x3c\\/function\\x3e|$)", "gi");
    let m;
    while ((m = fnRe.exec(t))) {
      const name = normalizeToolName(m[1]);
      if (!name) continue;

      const body = m[2];
      const args = {};
      const pRe = new RegExp("\\x3cparameter=([A-Za-z0-9_.-]+)\\x3e([\\s\\S]*?)(?:\\x3c\\/parameter\\x3e|$)", "gi");
      let pm;
      while ((pm = pRe.exec(body))) args[pm[1]] = unescapeXml(pm[2].trim());

      if (!Object.keys(args).length) {
        const flat = unescapeXml(body.replace(/\x3c\/?parameter\x3e?/gi, "").trim());
        if (flat) args.command = flat;
      }

      pushCall(name, args);
    }
  }

  // JSON block format.
  const jsonTagRe = new RegExp("\\x3ctool_call\\x3e\\s*(\\{[\\s\\S]*?\\})\\s*\\x3c\\/tool_call\\x3e", "gi");
  let jm;
  while ((jm = jsonTagRe.exec(t))) {
    try {
      const obj = JSON.parse(jm[1]);
      if (obj && typeof obj.name === "string") {
        pushCall(obj.name, obj.arguments ?? obj.input ?? obj.parameters ?? {});
      }
    } catch {}
  }

  // New format: tool wrapper with nested bash/shell/read_file/etc.
  const wrapperRe = new RegExp("\\x3ctool\\b[^\\x3e]*\\x3e([\\s\\S]*?)(?:\\x3c\\/tool\\x3e|$)", "gi");
  let wm;
  while ((wm = wrapperRe.exec(t))) parseToolBody(wm[1]);

  // Bare bash/shell blocks, in case model omits the outer wrapper.
  if (!calls.length) {
    const bareRe = new RegExp("\\x3c(bash|shell|cmd|terminal)\\b[^\\x3e]*\\x3e([\\s\\S]*?)(?:\\x3c\\/\\1\\x3e|$)", "gi");
    let bm;
    while ((bm = bareRe.exec(t))) {
      const args = parseChildTags(bm[2]);
      if (!args.command) {
        const flat = unescapeXml(bm[2].replace(new RegExp("\\x3c[^\\x3e]+\\x3e", "g"), "").trim());
        if (flat) args.command = flat;
      }
      pushCall("shell", args);
    }
  }

  // Plain JSON tool calls: the whole reply (or a ```json fence, or Mistral's [TOOL_CALLS] [...])
  // is {"name": "...", "arguments": {...}}. Only accepted for tools we actually offer, so a
  // final answer that happens to quote JSON is never executed.
  if (!calls.length) {
    const known = new Set([...TOOLS.map(x => x.function.name), ...mcpRegistry.keys(), "bash", "cmd", "terminal", "console"]);
    const candidates = [];
    const bare = t.trim().replace(/^\[TOOL_CALLS\]\s*/i, "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    if (/^[{[]/.test(bare)) candidates.push(bare);
    const fenceRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    let fm; while ((fm = fenceRe.exec(t))) candidates.push(fm[1]);
    for (const c of candidates) {
      let v; try { v = JSON.parse(c); } catch { continue; }
      const list = Array.isArray(v) ? v : [v];
      const ok = list.every(o => o && typeof o === "object" && typeof (o.name || o.tool || o.function?.name) === "string" && known.has(normalizeToolName(o.name || o.tool || o.function?.name)));
      if (!ok || !list.length) continue;
      for (const o of list) {
        let args = o.arguments ?? o.parameters ?? o.input ?? o.args ?? o.function?.arguments ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { _raw: args }; } }
        pushCall(o.name || o.tool || o.function?.name, args);
      }
      if (calls.length) break;
    }
  }

  return calls;
}
function stripToolMarkup(t) {
  return String(t || "")
    .replace(/\x3ctool\x3e[\s\S]*?(?:\x3c\/tool\x3e|$)/gi, "")
    .replace(/\x3ctool\b[^\x3e]*\x3e[\s\S]*?(?:\x3c\/tool\x3e|$)/gi, "")
    .replace(/\x3ctool_call\x3e[\s\S]*?(?:\x3c\/tool_call\x3e|$)/gi, "")
    .replace(/\x3cfunction=[\s\S]*?(?:\x3c\/function\x3e|$)/gi, "")
    .replace(/\x3c\/?(?:tool|tool_call|bash|shell|cmd|terminal|function|command|path|start|end|old_str|new_str|content|input|arguments|parameter)\b[^\x3e]*\x3e/gi, "")
    .replace(/^\[TOOL_CALLS\]\s*[\[{][\s\S]*$/i, "")
    .replace(/```(?:json)?\s*\{\s*"(?:name|tool)"\s*:[\s\S]*?\}\s*```/g, "")
    .replace(/^\s*\{\s*"(?:name|tool)"\s*:[\s\S]*\}\s*$/, "")
    .trim();
}

// ------------------------------------------------------------------ agent loop
let _callSeq = 0;   // session-unique ids for tool calls the server did not label
async function agentTurn(cfg, history, keys) {
  if (cfg.tools && !cfg._toolsUnsupported) await ensureMcp();
  let tools = cfg.tools && !cfg._toolsUnsupported ? allTools() : [];
  if (cfg.mode === "ask") tools = [];
  else if (cfg.mode === "plan") tools = tools.filter(t => ["read_file", "shell", "update_plan"].includes(t.function.name) || mcpRegistry.has(t.function.name));
  const turnMsg = [...history].reverse().find(m => m.role === "user") || null;   // the request being worked on
  const lastUserMsg = turnMsg?.content || "";
  // Auto-planning: derive a goal from the prompt and let the model decompose it into tasks.
  // Switched off with /set autoplan off — but an explicit `/plan goal <text>` still opts in,
  // so turning auto off does not lock you out of planning when you want it.
  const auto = cfg.autoPlan !== false;
  const wantPlan = cfg.mode !== "ask" && (auto || PLAN?.explicit === true);
  const plan = wantPlan ? startPlanTurn(auto ? seedGoal(lastUserMsg) : "") : null;
  if (!wantPlan) tools = tools.filter(t => t.function.name !== "update_plan");
  const hasSystem = history[0]?.role === "system";
  // Rebuilt on EVERY model call, not once per turn: the plan block has to track the live
  // task state, otherwise the model sees the checklist it wrote at the start and stops
  // following its own progress.
  const refreshSystem = () => { if (hasSystem) history[0].content = systemPrompt(cfg, lastUserMsg); };
  refreshSystem();
  if (plan?.fresh) {
    console.log(dim("⌾ goal: ") + dim(plan.goal));
    plan.fresh = false; plan.announced = true;
  }
  // an earlier interrupted turn may have left tool calls without results → fix before calling out
  if (repairHistory(history)) console.log(dim("· repaired an inconsistent conversation history"));

  const limit = Number(cfg.maxSteps) || 0;
  let step = 0;
  let failStreak = 0;
  const responseSigs = [];   // whole responses (text + tool calls), for verbatim resends
  const callLog = [];        // executed tool calls: { sig, res, mut }, for result-aware loop detection
  const stopWithLoop = (why, what) => {
    history.push({ role: "assistant", content:
      `I detected a repetition loop in my ${what} (${why}) and stopped. ` +
      "I appear to be repeating the same work without making progress. " +
      "Please rephrase your request, or tell me what specific outcome you need." });
    console.log(red(`! repetition loop detected in ${what} (${why}) — stopping`));
    if (planOpen()) printPlan();
  };
  for (;;) {
    step++;
    if (plan) plan.rounds = step;   // one model round trip per step
    if (limit > 0 && step > limit) {
      history.push({ role: "assistant", content: "(stopped: max tool steps reached)" });
      console.log(red(`! hit max tool steps (${limit}) — raise with /set max_steps <n>, or 0 for unlimited`));
      return;
    }
    if (limit === 0 && step % 25 === 0) {
      console.log(dim(`… still working (${step} tool steps) — ctrl+c to stop`));
    }

    refreshSystem();               // live goal + task state on every round trip
    trimHistory(history, cfg, turnMsg);
    const md = new MDStream();
    let shownThink = false, shownText = false, result = null;
    const ac = new AbortController();
    keys.onCtrlC = () => ac.abort();
    try {
      let attempts = 0;
      for (;;) {
        attempts++;
        spin.start(step === 1 ? "thinking…" : "continuing…");
        let firstVisible = true;
        try {
          for await (const ev of streamChat(cfg, history, tools, ac.signal)) {
            if (firstVisible && (ev.type === "thinking" || ev.type === "delta")) {
              spin.stop(); firstVisible = false;
            }
            if (ev.type === "thinking") {
              if (!shownThink) { process.stdout.write(dim("💭 ")); shownThink = true; }
              process.stdout.write(dim(ev.text));
            } else if (ev.type === "delta") {
              if (shownThink && !shownText) process.stdout.write("\n");
              shownText = true;
              md.feed(ev.text);
            } else {
              md.flush();
              if (shownThink || shownText) process.stdout.write("\n");
              result = ev.result;
            }
          }
          spin.stop();
          break;
        } catch (e) {
          spin.stop();
          if (e?.name === "AbortError") { process.stdout.write(dim("· interrupted\n")); return; }
          const msg = String(e?.message || e);
          const gotOutput = shownThink || shownText;
          if (!gotOutput && attempts < 4) {
            if (/stream_options|include_usage/i.test(msg)) {
              cfg._noStreamOpts = true;
              process.stdout.write(yellow("! usage reporting unsupported — retrying without it\n"));
              continue;
            }
            if (RETRYABLE(msg)) {
              process.stdout.write(yellow(`! ${msg} — retry ${attempts}/3 in ${attempts}s…\n`));
              await sleep(1000 * attempts);
              continue;
            }
            if (/(context|token|length|prompt)/i.test(msg) &&
                /(exceed|too (long|many|large)|maximum|limit|reduce|at most|overflow)/i.test(msg)) {
              // shrink for THIS session only — a permanently lowered context setting would keep
              // the agent crippled long after one oversized tool result
              const cur = Number(cfg.context) || estTokens(history);
              cfg.context = Math.max(2048, Math.floor(Math.min(cur, estTokens(history)) * 0.6));
              trimHistory(history, cfg, turnMsg);
              process.stdout.write(yellow(`! context overflow — trimmed history (working context now ${cfg.context} for this session); /set context <n> to fix it, /compact to summarize\n`));
              continue;
            }
            // history-shape complaints: the transcript can be repaired and resent
            if (/tool_call_id|tool_calls?.*(must|should|need)|did not have response|response messages|invalid tool call|tool call arguments|malformed tool|role ['"]?tool|messages with role/i.test(msg)) {
              const fixed = repairHistory(history);
              if (fixed || attempts === 1) {
                process.stdout.write(yellow("! repaired malformed tool-call history — retrying\n"));
                continue;
              }
            }
            // the endpoint does not do function calling at all → plain chat for this session
            if (tools.length && step === 1 && /tool|function/i.test(msg) &&
                /not support|unsupported|unknown|unrecognized|unexpected|invalid|not allowed|does not|doesn't|cannot|extra (field|input)|no such/i.test(msg)) {
              process.stdout.write(yellow("! tools rejected by endpoint — retrying as plain chat for this session (/set tools on to retry native tools)\n"));
              tools = []; cfg._toolsUnsupported = true;
              continue;
            }
          }
          throw e;
        }
      }
    } finally { keys.onCtrlC = null; spin.stop(); }

    if (!result) throw new ApiError("empty response from model");
    if (result.finish === "length") console.log(yellow("! response truncated (token limit)"));

    let tcs = result.toolCalls || [];
    // FIX: model printed tool calls as XML/JSON text (server without native tools)
    if (!tcs.length && result.content) {
      const xt = parseTextToolCalls(result.content);
      if (xt.length) {
        tcs = xt;
        result.content = stripToolMarkup(result.content);
      }
    }
    if (cfg.mode === "ask" && tcs.length) tcs = [];   // ask mode never executes anything
    if (!tcs.length) { // final message → done (1 round trip), unless the plan says otherwise
      const nudge = plan ? planGate(cfg) : null;
      if (nudge) {
        history.push({ role: "assistant", content: result.content || "" });
        history.push({ role: "user", content: nudge });
        console.log(yellow(`! plan incomplete — following up (${plan.nudges}/${MAX_PLAN_NUDGES})`));
        printPlan();
        continue;
      }
      history.push({ role: "assistant", content: result.content || "" });
      if (result.usage) showStats(cfg, history, result.usage);
      printPlanSummary(plan);
      return;
    }

    // --- loop detection, part 1: the exact same response (text + calls) sent again and again ---
    const toolSigs = tcs.map(t => toolCallSignature(t.name, t.arguments));
    responseSigs.push(contentSignature(result.content) + "\u0000" + toolSigs.join("\u0001"));
    if (responseSigs.length > LOOP_WINDOW) responseSigs.splice(0, responseSigs.length - LOOP_WINDOW);
    const respLoop = detectResponseLoop(responseSigs);
    if (respLoop) { stopWithLoop(respLoop, "output"); return; }

    const entries = tcs.map((t, i) => ({
      id: t.id || `call_${++_callSeq}_${step}_${i}`,
      type: "function",
      function: { name: t.name || "", arguments: t.arguments || "{}" },
    }));
    history.push({ role: "assistant", content: result.content || null, tool_calls: entries });

    // Every tool_call MUST get a tool result, even when we bail out half-way (ctrl+c, loop stop,
    // failure limit) — otherwise the next request is rejected by the server.
    const answered = new Set();
    const answer = (id, content) => { answered.add(id); history.push({ role: "tool", tool_call_id: id, content }); };
    const answerRest = (why) => { for (const e of entries) if (!answered.has(e.id)) answer(e.id, `error: not executed — ${why}`); };

    for (let ei = 0; ei < entries.length; ei++) {
      const e = entries[ei];
      const args = parseToolArgs(e.function.arguments);
      const sig = toolSigs[ei];
      console.log(yellow("⚙ ") + bold(e.function.name) + dim(" " + fmtCall(e.function.name, args)));

      let ok = null, res = null;
      if (cfg.intercept) {
        const verdict = classifyTool(e.function.name, args);
        if (verdict === "block") {
          console.log("  " + red("⛔ blocked by safety policy"));
          ok = false; res = "error: blocked by safety policy (dangerous command). Try a safer alternative.";
        } else if (verdict === "ask" && !cfg.autoYes) {
          const ans = await confirmTool(e.function.name, args, keys);
          if (ans === "always") cfg.autoYes = true;
          else if (ans === "no") {
            console.log("  " + red("✗ rejected by user"));
            ok = false; res = "error: rejected by user — do NOT retry this exact command";
          }
        }
      }
      if (ok === null) {
        keys.onCtrlC = () => { ac.abort(); try { currentChild?.kill(); } catch {} };
        [ok, res] = await runTool(e.function.name, args, cfg);
        keys.onCtrlC = null;
        if (ac.signal.aborted) {
          answer(e.id, /^error: interrupted/.test(res || "") ? truncate(res, 2000) : `error: interrupted by the user${res ? "\n" + truncate(res, 2000) : ""}`);
          answerRest("interrupted by the user");
          console.log(dim("· interrupted"));
          return;
        }
        const first = (res.trim().split("\n")[0] || "").slice(0, 140);
        const more = res.length > 140 ? dim(` …${res.length}ch`) : "";
        console.log(`  ${ok ? green("✓") : red("✗")} ${dim(first)}${more}`);
      }
      if (ok) failStreak = 0; else failStreak++;
      answer(e.id, truncate(res, cfg.maxout));

      // keep the user's checklist in view — after a plan update, or when a check cleared a flag
      if (e.function.name === "update_plan" || plan?.dirty) { printPlan(); if (plan) plan.dirty = false; }

      // --- loop detection, part 2: same call → same answer, nothing changed in between ---
      callLog.push({ sig, res: resultSignature(res), mut: ok && isMutatingCall(e.function.name, args),
                     wait: e.function.name === "shell" && /\b(sleep|timeout|wait|ping|watch|until|poll)\b/i.test(String(args.command || args._raw || "")) });
      if (callLog.length > LOOP_WINDOW) callLog.splice(0, callLog.length - LOOP_WINDOW);
      const toolLoop = detectToolLoop(callLog);
      if (toolLoop) {
        answerRest("stopped: repetition loop detected");
        stopWithLoop(toolLoop, "tool calls");
        return;
      }

      if (failStreak >= MAX_FAIL_STREAK) {
        answerRest(`stopped after ${MAX_FAIL_STREAK} consecutive failures`);
        history.push({ role: "assistant", content:
          `I hit ${MAX_FAIL_STREAK} consecutive failures and stopped to avoid making things worse. ` +
          "Here's where I'm stuck — please tell me how you'd like to proceed." });
        console.log(red(`! ${MAX_FAIL_STREAK} consecutive tool failures — stopping to avoid damage`));
        if (planOpen()) printPlan();
        return;
      }
    }
  }
}

// ------------------------------------------------------------------ key reader
class Keys {
  constructor(stdin) {
    this.buf = Buffer.alloc(0);
    this.w = null;
    this.onCtrlC = null;
    stdin.on("data", c => {
      if (this.onCtrlC && c.includes(0x03)) {
        c = Buffer.from(c.filter(b => b !== 0x03));
        try { this.onCtrlC(); } catch {}
      }
      if (c.length) {
        this.buf = Buffer.concat([this.buf, c]);
        const w = this.w; this.w = null; w?.();
      }
    });
  }
  _wait(ms) {
    return new Promise(r => {
      if (this.buf.length) return r();
      this.w = r;
      if (ms) setTimeout(() => { if (this.w === r) { this.w = null; r(); } }, ms);
    });
  }
  async key() {
    for (;;) {
      await this._wait();
      const b = this.buf;
      if (!b.length) continue;
      const c = b[0];
      if (c !== 0x1b) {
        this.buf = b.subarray(1);
        if (c === 0x0d || c === 0x0a) return ["enter"];
        if (c === 0x7f || c === 0x08) return ["backspace"];
        if (c === 0x09) return ["tab"];
        if (c === 0x03) return ["ctrl_c"];
        if (c === 0x04) return ["ctrl_d"];
        if (c === 0x0c) return ["ctrl_l"];
        if (c < 0x80) return ["char", String.fromCharCode(c)];
        const need = c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
        let tries = 0;
        while (this.buf.length < need && tries++ < 4) await this._wait(50);
        const take = Math.min(need, this.buf.length);
        const s = this.buf.subarray(0, take).toString("utf8");
        this.buf = this.buf.subarray(take);
        return ["char", s];
      }
      await this._wait(30);
      if (this.buf.length === 1) { this.buf = this.buf.subarray(1); return ["esc"]; }
      const b2 = this.buf;
      if (b2[1] === 0x0d || b2[1] === 0x0a) { this.buf = b2.subarray(2); return ["shift_enter"]; }
      if (b2[1] === 0x4f) {
        await this._wait(30);
        if (this.buf.length < 3) { this.buf = this.buf.subarray(2); return ["esc"]; }
        const f = String.fromCharCode(this.buf[2]);
        this.buf = this.buf.subarray(3);
        return [{ A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", M: "enter" }[f] || "esc"];
      }
      if (b2[1] !== 0x5b) { this.buf = b2.subarray(2); return ["esc"]; }
      let i = 2, tries = 0;
      for (;;) {
        while (i < this.buf.length && !(this.buf[i] >= 0x40 && this.buf[i] <= 0x7e)) i++;
        if (i < this.buf.length) break;
        if (++tries > 3) break;
        const before = this.buf.length;
        await this._wait(50);
        if (this.buf.length === before) break;
      }
      if (i >= this.buf.length) { this.buf = this.buf.subarray(i); return ["esc"]; }
      const params = this.buf.subarray(2, i).toString("ascii");
      const fin = String.fromCharCode(this.buf[i]);
      this.buf = this.buf.subarray(i + 1);
      const k = this._csi(params, fin);
      if (k[0] === "paste") return ["paste", await this._paste()];
      return k;
    }
  }
  _csi(p, f) {
    if (f === "u") {
      const parts = p.split(";");
      if (parts[0] === "13") {
        const mod = parts[1] ? parseInt(parts[1], 10) : 1;
        return [mod >= 2 && mod <= 4 ? "shift_enter" : "enter"];
      }
      return [{ "57352": "up", "57353": "down", "57354": "right", "57355": "left" }[parts[0]] || "esc"];
    }
    if (f === "~") {
      if (p === "200") return ["paste"];
      if (p.startsWith("27;")) {
        const parts = p.split(";");
        if (parts[2] === "13") return [["2", "3", "4"].includes(parts[1]) ? "shift_enter" : "enter"];
        return ["esc"];
      }
      return [{ "3": "delete", "1": "home", "4": "end", "7": "home", "8": "end" }[p] || "esc"];
    }
    if ("ABCD".includes(f)) return [{ A: "up", B: "down", C: "right", D: "left" }[f]];
    if (f === "H") return ["home"];
    if (f === "F") return ["end"];
    return ["esc"];
  }
  async _paste() {
    for (;;) {
      await this._wait(1000);
      const idx = this.buf.indexOf(Buffer.from("\x1b[201~"));
      if (idx >= 0) {
        const text = this.buf.subarray(0, idx).toString("utf8");
        this.buf = this.buf.subarray(idx + 6);
        return text;
      }
      if (!this.buf.length) return "";
    }
  }
}

// ------------------------------------------------------------------ file autocomplete
function findFiles(base, prefix) {
  const results = [];
  const ignore = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".venv", "venv", "__pycache__", ".aiterm", "target", "bin", "obj"]);
  let scanned = 0;
  const MAX_SCAN = 5000;
  function walk(d) {
    if (results.length >= 50 || scanned >= MAX_SCAN) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (ignore.has(e.name)) continue;
      if (e.name.startsWith(".") && e.name !== ".env" && e.name !== ".gitignore" && e.name !== ".npmrc") continue;
      const full = path.join(d, e.name);
      const rel = path.relative(base, full).replace(/\\/g, "/");
      scanned++;
      if (e.isDirectory()) {
        if (!prefix || rel.startsWith(prefix) || prefix.startsWith(rel + "/")) walk(full);
      } else {
        if (rel.startsWith(prefix)) results.push(rel);
      }
    }
  }
  walk(base);
  return results.sort();
}

// ------------------------------------------------------------------ line editor
class Editor {
  constructor(keys, cfg) { this.k = keys; this.cfg = cfg || {}; this.prev = 0; this.hist = []; this.hidx = null; }
  layout(buf, cur, w) {
    const full = PROMPT + buf.split("\n").join("\n" + CONT);
    const nlBefore = buf.slice(0, cur).split("\n").length - 1;
    const off = PROMPT.length + cur + CONT.length * nlBefore;
    const pos = i => {
      let r = 0, c = 0;
      for (let x = 0; x < i && x < full.length; x++) {
        if (full[x] === "\n") { r++; c = 0; }
        else { c++; if (c >= w) { r++; c = 0; } }
      }
      return [r, c];
    };
    const [er] = pos(full.length);
    const [cr, cc] = pos(off);
    return { full, er, cr, cc };
  }
  draw(buf, cur) {
    const w = Math.max(process.stdout.columns || 80, 16);
    const { full, er, cr, cc } = this.layout(buf, cur, w);
    let s = this.prev ? `\x1b[${this.prev}A` : "";
    s += "\r\x1b[J" + full;
    if (er > cr) s += `\x1b[${er - cr}A`;
    s += `\x1b[${cc + 1}G`;
    process.stdout.write(s);
    this.prev = cr;
  }
  finish(buf, cur, extra) {
    const w = Math.max(process.stdout.columns || 80, 16);
    const { er, cr } = this.layout(buf, cur, w);
    process.stdout.write((er > cr ? `\x1b[${er - cr}B` : "") + "\n" + (extra ? extra + "\n" : ""));
    this.prev = 0;
  }
  async read() {
    let buf = "", cur = 0;
    this.hidx = null;
    this.draw(buf, cur);
    for (;;) {
      const k = await this.k.key();
      const t = k[0];
      if (t === "char") { buf = buf.slice(0, cur) + k[1] + buf.slice(cur); cur += k[1].length; }
      else if (t === "paste") {
        const s = k[1].replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
        buf = buf.slice(0, cur) + s + buf.slice(cur); cur += s.length;
      }
      else if (t === "enter") {
        if (buf.endsWith("\\") && !buf.endsWith("\\\\")) { buf = buf.slice(0, -1) + "\n"; cur = buf.length; }
        else {
          this.finish(buf, cur, "");
          if (buf.trim() && this.hist[this.hist.length - 1] !== buf) this.hist.push(buf);
          return buf;
        }
      }
      else if (t === "shift_enter") { buf = buf.slice(0, cur) + "\n" + buf.slice(cur); cur++; }
      else if (t === "backspace") { if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; } }
      else if (t === "delete") { buf = buf.slice(0, cur) + buf.slice(cur + 1); }
      else if (t === "left") cur = Math.max(0, cur - 1);
      else if (t === "right") cur = Math.min(buf.length, cur + 1);
      else if (t === "home") cur = buf.lastIndexOf("\n", cur - 1) + 1;
      else if (t === "end") { const p = buf.indexOf("\n", cur); cur = p < 0 ? buf.length : p; }
      else if (t === "tab") {
        const wordStart = (() => {
          for (let i = cur - 1; i >= 0; i--) if (/\s/.test(buf[i])) return i + 1;
          return 0;
        })();
        const word = buf.slice(wordStart, cur);
        if (word.startsWith("@")) {
          const prefix = word.slice(1);
          const base = this.cfg.projectDir || process.cwd();
          const matches = findFiles(base, prefix);
          if (matches.length === 1) {
            const insert = matches[0].slice(prefix.length);
            buf = buf.slice(0, cur) + insert + buf.slice(cur); cur += insert.length;
          } else if (matches.length > 1) {
            let common = matches[0];
            for (const m of matches) {
              while (common && !m.startsWith(common)) common = common.slice(0, -1);
            }
            if (common.length > prefix.length) {
              const insert = common.slice(prefix.length);
              buf = buf.slice(0, cur) + insert + buf.slice(cur); cur += insert.length;
            } else {
              const opts = matches.slice(0, 10).map(m => cyan("  " + m)).join("\n");
              const more = matches.length > 10 ? dim(`\n  ...and ${matches.length - 10} more`) : "";
              this.finish(buf, cur, opts + more);
            }
          }
        } else {
          buf = buf.slice(0, cur) + "  " + buf.slice(cur); cur += 2;
        }
      }
      else if (t === "up") {
        if (!buf.includes("\n") && this.hist.length) {
          this.hidx = this.hidx === null ? this.hist.length - 1 : Math.max(0, this.hidx - 1);
          buf = this.hist[this.hidx]; cur = buf.length;
        }
      }
      else if (t === "down") {
        if (!buf.includes("\n") && this.hidx !== null) {
          this.hidx++;
          if (this.hidx >= this.hist.length) { this.hidx = null; buf = ""; }
          else buf = this.hist[this.hidx];
          cur = buf.length;
        }
      }
      else if (t === "ctrl_c") { this.finish(buf, cur, dim("^C")); buf = ""; cur = 0; }
      else if (t === "ctrl_d") {
        if (!buf) { this.finish(buf, cur, ""); return null; }
        buf = buf.slice(0, cur) + buf.slice(cur + 1);
      }
      else if (t === "ctrl_l") { process.stdout.write("\x1b[H\x1b[2J"); this.prev = 0; }
      if (t !== "up" && t !== "down") this.hidx = null;
      this.draw(buf, cur);
    }
  }
}
async function readSecretRaw(keys) {
  let s = "";
  for (;;) {
    const k = await keys.key();
    if (k[0] === "enter") { process.stdout.write("\n"); return s; }
    if (k[0] === "ctrl_c") { process.stdout.write("\n"); return null; }
    if (k[0] === "backspace") { s = s.slice(0, -1); continue; }
    if (k[0] === "char") s += k[1];
  }
}

// ------------------------------------------------------------------ commands
async function handleCommand(line, cfg, history, keys) {
  const parts = line.split(/\s+/);
  const cmd = parts[0], k = parts[1], v = parts.slice(2).join(" ").trim();
  switch (cmd) {
    case "/exit": case "/quit": case "/q":
      return false;
    case "/help": case "/?":
      console.log(HELP.trim()); break;
    case "/clear": case "/reset":
      history.length = 1; resetPlan(); console.log(dim("history cleared")); break;
    case "/plan": {
      const sub = (k || "").toLowerCase();
      if (sub === "clear" || sub === "reset") { resetPlan(); console.log(dim("plan cleared")); break; }
      if (sub === "goal") {
        if (!v) { console.log(dim("usage: /plan goal <one-sentence outcome>")); break; }
        const p = ensurePlan();
        p.goal = clean(v, 400);
        p.explicit = true;   // user chose this goal, so it survives autoplan=off
        p.announced = false; // show it on the next turn
        console.log(dim("goal set — the model will plan against it from the next turn"));
        if (cfg.autoPlan === false) console.log(dim("  (auto-planning is off; this explicit goal re-enables it)"));
        break;
      }
      if (!PLAN || !PLAN.tasks.length) {
        if (PLAN?.goal) console.log(dim("no tasks yet — goal: " + PLAN.goal));
        else if (cfg.autoPlan === false)
          console.log(dim("no active plan — auto-planning is off (/set autoplan on, or /plan goal <text>)"));
        else console.log(dim("no active plan (the agent sets one from your prompt)"));
        break;
      }
      console.log(renderPlan(PLAN, "  "));
      const done = PLAN.tasks.filter(t => t.status === "done").length;
      const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
      console.log(dim(`  ${done}/${PLAN.tasks.length} done · ${plural(PLAN.rounds, "round trip")} · ${plural(PLAN.calls, "tool call")}`));
      break;
    }
    case "/cd":
      setProjectDir(cfg, history, parts.slice(1).join(" "));
      break;
    case "/compact":
      await compactHistory(cfg, history);
      break;
    case "/mcp": {
      if (!mcpClients.size) { console.log(dim("no MCP servers connected (add them to " + MCP_PATH + ")")); break; }
      for (const [name, client] of mcpClients) {
        console.log(bold(`  ${name}`) + dim(`  ${client.tools.length} tools`));
        for (const t of client.tools)
          console.log("    - " + t.name + dim(t.description ? "  " + t.description.slice(0, 60) : ""));
      }
      break;
    }
    case "/blocked": {
      const list = cfg.blockedCommands || DEFAULT_BLOCKED;
      if (!list.length) { console.log(dim("no blocked patterns")); break; }
      console.log(bold("  blocked command patterns:"));
      list.forEach(p => console.log("   " + red(p)));
      break;
    }
    case "/block": {
      const pat = parts.slice(1).join(" ");
      if (!pat) { console.log(dim("usage: /block <regex>")); break; }
      try { new RegExp(pat); } catch (e) { console.log(red("invalid regex: " + e.message)); break; }
      cfg.blockedCommands = cfg.blockedCommands || [...DEFAULT_BLOCKED];
      if (!cfg.blockedCommands.includes(pat)) cfg.blockedCommands.push(pat);
      saveCfg(cfg);
      if (history.length) history[0].content = systemPrompt(cfg);
      console.log(dim(`✓ blocked: ${pat}`));
      break;
    }
    case "/unblock": {
      const pat = parts.slice(1).join(" ");
      cfg.blockedCommands = (cfg.blockedCommands || DEFAULT_BLOCKED).filter(p => p !== pat);
      saveCfg(cfg);
      if (history.length) history[0].content = systemPrompt(cfg);
      console.log(dim(`✓ unblocked: ${pat}`));
      break;
    }
    case "/commands": {
      const ledger = loadLedger();
      const worked = Object.entries(ledger.worked).sort((a,b)=>b[1]-a[1]);
      const failed = Object.entries(ledger.failed).sort((a,b)=>b[1]-a[1]);
      console.log(bold(`  working on ${process.platform}:`));
      console.log("   " + (worked.length ? worked.map(([kk,n]) => `${kk}(${n})`).join(", ") : "(none yet)"));
      console.log(bold("  failing (avoid):"));
      console.log("   " + (failed.length ? failed.map(([kk,n]) => `${kk}(${n})`).join(", ") : "(none)"));
      break;
    }
    case "/memories": {
      const mems = loadMemory().memories;
      if (!mems.length) { console.log(dim("no memories recorded yet")); break; }
      console.log(bold(`  ${mems.length} memories recorded:`));
      for (const m of mems.slice(-20).reverse()) {
        const date = new Date(m.timestamp).toLocaleDateString();
        console.log(`  ${cyan(`[${m.type}]`)} ${m.content} ${dim(`(${date}, id:${m.id})`)}`);
      }
      break;
    }
    case "/forget": {
      if (!k) { console.log(dim("usage: /forget <id>")); break; }
      const mem = loadMemory();
      const before = mem.memories.length;
      mem.memories = mem.memories.filter(m => m.id !== k);
      if (mem.memories.length < before) { saveMemory(mem); console.log(dim(`✓ forgot memory ${k}`)); }
      else console.log(red(`memory ${k} not found`));
      break;
    }
    case "/save": {
      const name = (k || `session-${Date.now()}`).replace(/\.json$/i, "");
      const dir = SESSIONS_DIR;
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const file = path.join(dir, name + ".json");
      const data = {
        model: cfg.model, apiUrl: cfg.apiUrl, projectDir: cfg.projectDir,
        draftModel: cfg.draftModel, temperature: cfg.temperature, reasoning: cfg.reasoning,
        savedAt: new Date().toISOString(), messages: history.slice(1),
      };
      try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        console.log(dim(`✓ session saved to ${displayPath(file)}`));
      } catch (e) { console.log(red(`failed to save: ${e.message}`)); }
      break;
    }
    case "/load": {
      if (!k) { console.log(dim("usage: /load <name>")); break; }
      const name = k.replace(/\.json$/i, "");
      const dir = SESSIONS_DIR;
      const file = path.join(dir, name + ".json");
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!Array.isArray(data.messages)) throw new Error("invalid session file");
        history.length = 1;
        history.push(...data.messages);
        console.log(dim(`✓ loaded ${data.messages.length} messages from ${displayPath(file)}`));
        if (data.model && data.model !== cfg.model) {
          console.log(yellow(`! session used '${data.model}', current is '${cfg.model}'`));
        }
      } catch (e) { console.log(red(`failed to load: ${e.message}`)); }
      break;
    }
    case "/sessions": {
      const dir = SESSIONS_DIR;
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch {}
      if (!files.length) { console.log(dim("no saved sessions found")); break; }
      for (const f of files.sort().reverse()) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          const msgs = d.messages?.length || 0;
          const date = d.savedAt ? new Date(d.savedAt).toLocaleString() : "unknown";
          console.log(`  ${bold(f.replace(/\.json$/, ""))} ${dim(`(${msgs} msgs, ${date})`)}`);
        } catch {
          console.log(`  ${f} ${dim("(corrupt)")}`);
        }
      }
      break;
    }
    case "/mode": {
    const m = (k || "").toLowerCase();
    if (!["code", "ask", "plan"].includes(m)) {
      console.log(dim("usage: /mode <code|ask|plan>"));
    } else {
      cfg.mode = m;
      saveCfg(cfg);
      if (history.length) history[0].content = systemPrompt(cfg);
      console.log(dim("✓ mode set to " + m));
    }
    break;
    }
    case "/redact": {
    const val = (k || "").toLowerCase();
    if (["on", "true", "1"].includes(val)) cfg.redact = true;
    else if (["off", "false", "0"].includes(val)) cfg.redact = false;
    else { console.log(dim("usage: /redact <on|off>")); break; }
    saveCfg(cfg);
    console.log(dim("✓ redact " + (cfg.redact ? "on" : "off")));
    break;
    }
    case "/config": {
      const key = cfg.apiKey || "";
      const masked = key.length > 12 ? key.slice(0, 7) + "…" + key.slice(-4) : (key ? "set" : "—");
      console.log(`  url      ${cfg.apiUrl}\n  model    ${cfg.model}\n  key      ${masked}` +
        `\n  draft    ${cfg.draftModel || "—"}\n  temp     ${cfg.temperature == null ? "default" : cfg.temperature}` +
        `\n  reasoning ${cfg.reasoning || "default"}
        mode     ${cfg.mode || "code"}` +
        `\n  dir      ${cfg.projectDir ? displayPath(cfg.projectDir) : "(process cwd: " + displayPath(process.cwd()) + ")"}` +
        `\n  context  ${cfg.context || "not set (no trimming)"}\n  maxout   ${cfg.maxout}` +
        `   max_tokens ${cfg.maxTokens || "default"}\n  intercept ${cfg.intercept ? "on" : "off"}` +
        `\n  autoplan ${cfg.autoPlan === false ? "off (no auto goal/tasks)" : "on (goal + tasks from prompt)"}` +
        `\n  max_steps ${cfg.maxSteps || "unlimited"}\n  blocked  ${(cfg.blockedCommands || DEFAULT_BLOCKED).length} pattern(s)` +
        `\n  stream   ${cfg.stream === false ? 'off ("stream": false, single JSON reply)' : "on (SSE chunks)"}` +
        `\n  mcp      ${mcpClients.size} server(s)\n  tools    ${cfg.tools ? "on" : "off"}` +
        `\n  data     ${DATA_DIR}`);
      break;
    }
    case "/set": {
      try {
        if (k === "url" && v) cfg.apiUrl = v;
        else if (k === "model" && v) cfg.model = v;
        else if (k === "draft_model") cfg.draftModel = v || "";
        else if (k === "temperature") {
          if (!v) cfg.temperature = null;
          else { const t = parseFloat(v); cfg.temperature = isNaN(t) ? null : t; }
        }
        else if (k === "reasoning") {
          if (!v || v === "off" || v === "none") cfg.reasoning = "";
          else cfg.reasoning = v;
        }
        else if (k === "mode") {
        const m = (v || "").toLowerCase();
        if (["code", "ask", "plan"].includes(m)) {
          cfg.mode = m;
          if (history.length) history[0].content = systemPrompt(cfg);
        } else {
          console.log(dim("usage: /set mode <code|ask|plan>"));
          return true;
        }
        }
        else if (k === "redact") cfg.redact = ["on","true","1"].includes(v);
        else if (k === "dir") {
          if (!v) { console.log(dim("usage: /set dir <path>   ('-' to clear)")); return true; }
          setProjectDir(cfg, history, v);
          return true;
        }
        else if (k === "key") {
          let val = v;
          if (!val) {
            process.stdout.write("API key: ");
            val = await readSecretRaw(keys);
            if (val === null) { console.log(dim("cancelled")); return true; }
          }
          cfg.apiKey = val;
        }
        else if (k === "context") { if (!v || v === "auto") await detectContext(cfg); else cfg.context = parseInt(v, 10); }
        else if (k === "maxout") cfg.maxout = parseInt(v, 10);
        else if (k === "max_tokens") cfg.maxTokens = v ? parseInt(v, 10) : 0;
        else if (k === "intercept") cfg.intercept = ["on","true","1"].includes(v);
        else if (k === "tools") {
          const t = (v || "").toLowerCase();
          if (["on","true","1","enable","enabled"].includes(t)) { cfg.tools = true; delete cfg._toolsUnsupported; }
          else if (["off","false","0","disable","disabled"].includes(t)) cfg.tools = false;
          else { console.log(dim("usage: /set tools <on|off>")); return true; }
        }
        else if (k === "stream") {
          const t = (v || "").toLowerCase();
          if (["on","true","1","enable","enabled"].includes(t)) cfg.stream = true;
          else if (["off","false","0","disable","disabled"].includes(t)) cfg.stream = false;
          else { console.log(dim("usage: /set stream <on|off>")); return true; }
          console.log(dim(cfg.stream
            ? "  requests use stream:true — SSE chunks as they arrive"
            : "  requests use stream:false — one JSON reply per model call"));
        }
        else if (k === "autoplan" || k === "auto_plan" || k === "plan") {
          const t = (v || "").toLowerCase();
          if (["on","true","1","enable","enabled"].includes(t)) cfg.autoPlan = true;
          else if (["off","false","0","disable","disabled"].includes(t)) {
            cfg.autoPlan = false;
            resetPlan();   // drop any auto-derived goal so the change takes effect immediately
          }
          else { console.log(dim("usage: /set autoplan <on|off>")); return true; }
          console.log(dim(cfg.autoPlan
            ? "  goals + tasks are derived from your prompt automatically"
            : "  no auto goal/tasks; set one yourself with /plan goal <text>"));
        }
        else if (k === "max_steps") cfg.maxSteps = v ? parseInt(v, 10) : 0;
        else if (k === "system" && v) { cfg.system = v; if (history.length) history[0].content = systemPrompt(cfg); }
        else { console.log(dim("usage: /set url|model|key|draft_model|temperature|reasoning|mode|redact|dir|context|max_tokens|maxout|intercept|tools|stream|autoplan|max_steps|system <value>")); return true; }
        saveCfg(cfg);
        console.log(dim(`✓ ${k} updated`));
      } catch (e) { console.log(red(String(e.message))); }
      break;
    }
    case "/models": case "/list":
      try {
        spin.start("listing models…");
        const ms = await fetchModels(cfg);
        spin.stop();
        for (const m of ms.slice(0, 80)) {
          const id = String(m.id || "?");
          console.log("  " + (id === cfg.model ? bold(id) : id));
        }
      } catch (e) { spin.stop(); console.log(red(e.message)); }
      break;
    default:
      console.log(dim(`unknown command '${cmd}' — /help`));
  }
  return true;
}

function banner(cfg) {
  const dir = cfg.projectDir ? displayPath(cfg.projectDir) : displayPath(process.cwd());
  const modeStr = cfg.mode && cfg.mode !== "code" ? "  ·  mode " + cfg.mode : "";
  console.log(bold("◆ ai-agent") + dim(`  ${cfg.model} @ ${cfg.apiUrl}  ·  ${osDescription()}  ·  ctx ${cfg.context ? fmtK(cfg.context) : "unknown"}  ·  key ${cfg.apiKey ? "✓" : "—"}` + (cfg.draftModel ? `  ·  draft ${cfg.draftModel}` : "") + (cfg.temperature != null ? `  ·  temp ${cfg.temperature}` : "") + (cfg.reasoning ? `  ·  reasoning ${cfg.reasoning}` : "") + (cfg.intercept ? "  ·  🔒 intercept" : "") + (cfg.stream === false ? "  ·  stream off" : "") + modeStr));
  console.log(dim(`  📁 ${dir}   ·   data: ${DATA_DIR}`));
  console.log(dim("  enter send · shift+enter newline (or \\+enter) · @file+Tab complete · ^C cancel · ^D exit · /help"));
}

// ------------------------------------------------------------------ args & main
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i], next = () => argv[++i];
    switch (x) {
      case "--url": a.url = next(); break;
      case "--model": a.model = next(); break;
      case "--key": a.key = next(); break;
      case "--dir": case "--cwd": case "-C": a.dir = next(); break;
      case "--context": a.context = parseInt(next(), 10); break;
      case "--system": a.system = next(); break;
      case "--maxout": a.maxout = parseInt(next(), 10); break;
      case "--max-tokens": a.maxTokens = parseInt(next(), 10); break;
      case "--max-steps": a.maxSteps = parseInt(next(), 10); break;
      case "--draft-model": a.draftModel = next(); break;
      case "--temperature": a.temperature = parseFloat(next()); break;
      case "--reasoning": a.reasoning = next(); break;
      case "--mode": a.mode = next(); break;
      case "--intercept": case "-i": a.intercept = true; break;
      case "--autoplan": case "--auto-plan": a.autoPlan = next(); break;
      case "--no-autoplan": case "--no-auto-plan": a.autoPlan = "off"; break;
      case "--no-tools": a.noTools = true; break;
      case "--tools": a.tools = true; break;
      case "--stream": a.stream = next(); break;
      case "--no-stream": a.noStream = true; break;
      case "--list": a.list = true; break;
      case "--save": a.save = true; break;
      case "-h": case "--help": a.help = true; break;
      default:
        // a mistyped flag must not silently become the prompt
        if (/^--?[a-z]/i.test(x) && x !== "-") { console.error(yellow(`! unknown option '${x}' ignored (see --help)`)); break; }
        if (!a.prompt) a.prompt = x;
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }

  initDataDir();

  const cfg = loadCfg();
  cfg.apiUrl = process.env.AI_URL || process.env.OPENAI_BASE_URL || cfg.apiUrl;
  cfg.apiKey = process.env.AI_KEY || process.env.OPENAI_API_KEY || cfg.apiKey;
  cfg.model = process.env.AI_MODEL || cfg.model;
  cfg.projectDir = process.env.AI_DIR || cfg.projectDir;
  if (process.env.AI_STREAM) cfg.stream = ["on","true","1"].includes(process.env.AI_STREAM.toLowerCase());
  if (args.url) cfg.apiUrl = args.url;
  if (args.model) cfg.model = args.model;
  if (args.key) cfg.apiKey = args.key;
  if (args.dir) cfg.projectDir = args.dir;
  if (args.context) cfg.context = args.context;
  if (args.system) cfg.system = args.system;
  if (args.maxout) cfg.maxout = args.maxout;
  if (args.maxTokens) cfg.maxTokens = args.maxTokens;
  if (args.noTools) cfg.tools = false;
  if (args.tools) cfg.tools = true;
  if (args.stream !== undefined) cfg.stream = ["on","true","1"].includes(String(args.stream).toLowerCase());
  if (args.noStream) cfg.stream = false;
  if (args.intercept) cfg.intercept = true;
  if (args.maxSteps !== undefined) cfg.maxSteps = args.maxSteps;
  if (args.draftModel) cfg.draftModel = args.draftModel;
  if (typeof args.temperature === "number" && !isNaN(args.temperature)) cfg.temperature = args.temperature;
  if (args.reasoning) cfg.reasoning = args.reasoning;
  if (args.autoPlan) cfg.autoPlan = ["on","true","1"].includes(String(args.autoPlan).toLowerCase());
  if (args.mode) cfg.mode = args.mode;
  if (args.save) saveCfg(cfg);

  if (args.list) {
    for (const m of await fetchModels(cfg)) console.log(m.id || "?");
    return;
  }

  if (!process.stdin.isTTY) {
    let text = "";
    for await (const c of process.stdin) text += c;
    text = text.trim();
    if (text) {
      if (!cfg.apiUrl || !cfg.model) { console.error("missing --url/--model (run interactively once to configure)"); process.exit(1); }
      try { applyProjectDir(cfg, true); }
      catch (e) { console.error(red("✗ " + e.message)); process.exit(1); }
      if (!cfg.context) await autoContext(cfg, null);
      const h = [{ role: "system", content: systemPrompt(cfg, text) }, { role: "user", content: text }];
      try { await agentTurn(cfg, h, {}); }
      catch (e) { console.error(red("✗ " + e.message)); process.exit(1); }
    }
    return;
  }

  if (!cfg.apiUrl) await setup(cfg);
  await resolveCfg(cfg);
  applyProjectDir(cfg, false);
  saveCfg(cfg);

  if (args.prompt) {
    const h = [{ role: "system", content: systemPrompt(cfg, args.prompt) }, { role: "user", content: args.prompt }];
    try { await agentTurn(cfg, h, {}); }
    catch (e) { console.error(red("✗ " + e.message)); process.exit(1); }
    return;
  }

  banner(cfg);
  await ensureMcp();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[>1u\x1b[?2004h");
  const keys = new Keys(process.stdin);
  const ed = new Editor(keys, cfg);
  process.on("exit", () => {
    for (const c of mcpClients.values()) c.stop();
    try { process.stdout.write("\x1b[?2004l\x1b[<u"); process.stdin.setRawMode(false); } catch {}
  });

  const history = [{ role: "system", content: systemPrompt(cfg) }];
  for (;;) {
    const line = await ed.read();
    if (line === null) break;
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("/")) { if (!(await handleCommand(t, cfg, history, keys))) break; continue; }
    // A closed-out plan belongs to the previous request — start the next one with a fresh goal.
    // An unfinished plan is kept: the user is following up, and the agent must still close it out.
    // An explicit goal with no tasks yet is also kept, so `/plan goal` survives until the turn
    // that actually uses it instead of being discarded before the model ever sees it.
    if (PLAN && !planOpen() && (PLAN.tasks.length || !PLAN.explicit)) resetPlan();
    const snap = history.length;
    history.push({ role: "user", content: t });
    try {
      await agentTurn(cfg, history, keys);
    } catch (e) {
      // Nothing happened yet → drop the request so it can simply be retried. Tools already ran →
      // keep that context (files may have changed) and just make the transcript consistent.
      const progressed = history.slice(snap + 1).some(m => m.role === "tool");
      if (!progressed) history.length = snap;
      else {
        repairHistory(history);
        history.push({ role: "assistant", content: `(stopped by an error: ${String(e.message).slice(0, 300)})` });
      }
      console.error(red("✗ " + e.message));
      if (/context|token/i.test(e.message)) console.log(dim("  hint: /set context <n> or /compact to free context"));
      if (progressed) console.log(dim("  the work done so far is kept in the conversation — say 'continue' to resume"));
    }
  }
  console.log(dim("bye"));
}

// Pure helpers exported for the unit tests (test/*.test.mjs import this file with
// AI_AGENT_NO_MAIN=1 so the REPL does not start).
export {
  canonicalJson, toolCallSignature, resultSignature, contentSignature, detectToolLoop, detectResponseLoop,
  repairHistory, trimHistory, estTokens, maskSecrets, restoreSecrets, parseTextToolCalls, stripToolMarkup,
  parseToolArgs, shellCommandOf, isReadOnlyCommand, checkCommandPolicy, classifyTool, mergeToolCallChunk,
  repairToolCalls, toolStrReplace, toolRead, toolWrite, applyPlanUpdate, planGate, startPlanTurn, resetPlan,
  newPlan, verifySeen, normalizeBase, seedGoal, parseArgs, runShell,
};

if (!process.env.AI_AGENT_NO_MAIN)
  main().catch(e => { console.error(red("fatal: " + (e.stack || e.message))); process.exit(1); });