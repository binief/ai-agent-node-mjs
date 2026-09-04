#!/usr/bin/env node
/**
 * ai-agent.mjs — minimal, fully-working, self-learning terminal AI agent.
 * Node >= 18, ZERO dependencies (stdlib only).
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
 * temperature, reasoning level, /compact.
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
import { exec, spawn } from "node:child_process";
import process from "node:process";
import { EventSource } from "eventsource";

const VERSION = "2.9.0";

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
  "\n" +
  "WORK METHOD:\n" +
  "1. UNDERSTAND FIRST: infer the project type (language, framework, libraries) from the task and files. Explore before changing. Never assume — gather context, then act.\n" +
  "2. DECOMPOSE: break complex tasks into small concepts; identify which files each one needs.\n" +
  "3. GATHER CONTEXT EFFICIENTLY: prefer reading large meaningful chunks over many small reads. Use `shell` (grep/find/rg/dir) to locate code instead of guessing. Batch independent tool calls into one response.\n" +
  "4. EDIT CORRECTLY: use `str_replace` for targeted edits (exact match); use `write_file` only for new files or full rewrites (full content, never placeholders). Follow existing conventions — indentation, style, naming, framework versions.\n" +
  "5. USE ESTABLISHED LIBRARIES: if a well-known package solves a problem, install it properly (npm/pip/etc.) rather than reimplementing it.\n" +
  "6. OMITTED CONTENT: if context shows an omission marker (e.g. '...lines omitted...'), read the real content before editing; never pass the marker into an edit.\n" +
  "7. VALIDATE: after changes, run build/tests/linters via `shell` to confirm. Verify errors are actually fixed.\n" +
  "8. ERROR LIMIT: if the same fix fails repeatedly, STOP and explain the blocker + options to the user instead of looping.\n" +
  "9. ITERATE WITHOUT REPEATING: after each tool call, continue from where you left off.\n" +
  "\n" +
  "SHELLS: use cmd-style commands; PowerShell is blocked. Use background=true for dev servers/watchers.\n" +
  "NO COMMENTS: never add filler/explanatory comments to code unless asked.\n" +
  "MEMORY: use `remember` to persist lessons/preferences/workarounds; check recalled memories for past solutions to similar problems.\n" +
  "SAFETY: avoid destructive commands unless clearly required; never hardcode secrets; refuse harmful/illegal requests briefly.\n" +
  "TERSE: no preamble, no restating, no apologies.\n" +
  "FINISH: when done, reply with a 1-3 line summary of what changed and how it was validated.\n"+
  "TOOLS: tool calls should be in json format not xml.";

const MAX_FAIL_STREAK = 3;

const TOOLS = [
  { type: "function", function: {
      name: "shell",
      description: "Run a shell command; returns exit code + stdout/stderr. background=true for long-running processes (dev servers, watchers) so it returns immediately. Note: PowerShell is blocked; use cmd.",
      parameters: { type: "object",
        properties: {
          command: { type: "string" },
          background: { type: "boolean", description: "true for servers/watchers that never exit" }
        },
        required: ["command"] } } },
  { type: "function", function: {
      name: "read_file",
      description: "Read a text file (path relative to project folder), optionally a line range. Prefer large meaningful chunks.",
      parameters: { type: "object",
        properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } },
        required: ["path"] } } },
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
  /set max_steps <n>      tool-step cap (0 = unlimited; default)
  /set intercept <on|off> approval gate before mutating tools run
  /set system <prompt>    replace system prompt
  /mode <ask|plan|code>   agent mode (ask=chat, plan=read-only plan, code=full auto)
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
  - tools: shell, read_file, str_replace, write_file, remember, forget, + MCP tools
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
  --system <prompt>   --no-tools          --save   --list   -h`;

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

function loadSecretStore() {
  if (_secretStore) return;
  let d = {};
  try { d = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8")).dummies || {}; } catch {}
  _secretStore = d;
  _realToDummy = new Map();
  for (const [k, v] of Object.entries(_secretStore)) _realToDummy.set(v, k);
}
function saveSecretStore() {
  try { fs.writeFileSync(SECRETS_PATH, JSON.stringify({ dummies: _secretStore }, null, 2), { mode: 0o600 }); } catch {}
}
// length-preserving alphanumeric dummy (min 4) — looks natural in place
function genDummy(len) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const n = Math.max(len || 0, 4);
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function dummyFor(real) {
  loadSecretStore();
  let d = _realToDummy.get(real);
  if (!d) {
    do { d = genDummy(real.length); } while (_secretStore[d]);
    _secretStore[d] = real;
    _realToDummy.set(real, d);
    saveSecretStore();
  }
  return d;
}
function restoreSecrets(text) {
  loadSecretStore();
  let t = String(text);
  const entries = Object.entries(_secretStore).sort((a, b) => b[0].length - a[0].length);
  for (const [d, r] of entries) t = t.split(d).join(r);
  return t;
}
function maskSecrets(text, cfg) {
  if (!cfg || cfg.redact === false) return String(text);
  let t = String(text);
  t = t.replace(/(:\/\/[^:\s\/@]+:)([^@\s]+)(@)/g, (m, pre, pass, at) => pre + dummyFor(pass) + at);
  t = t.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, m => dummyFor(m));
  t = t.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, m => dummyFor(m));
  t = t.replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9]{16,}\b/g, m => dummyFor(m));
  t = t.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, m => dummyFor(m));
  t = t.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, m => dummyFor(m));
  t = t.replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi, (m, pre, tok) => pre + dummyFor(tok));
  const K = "password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|credential|session[_-]?id";
  t = t.replace(new RegExp(`((?:${K})["']?\\s*[:=]\\s*)(["'])([^"']+)\\2`, "gi"), (m, pre, q, val) => pre + q + dummyFor(val) + q);
  t = t.replace(new RegExp(`((?:${K})["']?\\s*[:=]\\s*)([^\\s"']+)`, "gi"), (m, pre, val) => pre + dummyFor(val));
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
function checkCommandPolicy(cmd, cfg) {
  const c = String(cmd).trim();
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
  /^(ls|ll|dir|pwd|cd|cat|type|echo|which|where|whoami|hostname|date|stat|file|wc|head|tail|tree|findstr)\b/i,
  /^git\s+(status|log|diff|show|branch|remote|ls-files)\b/i,
  /^(npm|yarn|pnpm)\s+(ls|list|outdated|view|why)\b/i,
  /^(node|python3?)\s+--version\b/i,
];
function classifyTool(name, args) {
  if (name === "read_file") return "auto";
  if (name === "shell") {
    const c = String(args.command || args._raw || "").trim();
    if (DANGEROUS.some(re => re.test(c))) return "block";
    if (READONLY.some(re => re.test(c))) return "auto";
    return "ask";
  }
  return "ask";
}
async function confirmTool(name, args, keys) {
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

class McpClient {
  constructor(name, cfg) {
    this.name = name; this.cfg = cfg;
    this.proc = null; this.buf = ""; this.nextId = 1;
    this.pending = new Map(); this.tools = [];
    this.transport = cfg.type || "stdio";
    this.httpSession = null;
    this.sseSource = null;
    this.sseEndpoint = null;
  }
  start() {
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
    } else if (this.transport === "sse" || this.transport === "http") {
      // SSE/HTTP transport - will connect via HTTP POST after SSE handshake
      this._connectHttp();
    }
  }
  async _connectHttp() {
    const url = new URL(this.cfg.url);
    // For SSE, we need to establish an SSE connection first to get the endpoint
    if (this.transport === "sse") {
      await this._establishSse(url.toString());
    } else {
      // Direct HTTP - use the URL as-is for tool calls
      this.sseEndpoint = url.toString();
      this._onReady();
    }
  }
  async _establishSse(baseUrl) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.sseSource) this.sseSource.close();
        reject(new Error("SSE connection timeout"));
      }, 30000);
      
      const sseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
      this.sseSource = new EventSource(sseUrl);
      
      this.sseSource.onerror = () => {
        clearTimeout(timeout);
        this.sseSource.close();
        reject(new Error("SSE connection failed"));
      };
      
      this.sseSource.addEventListener("endpoint", (e) => {
        clearTimeout(timeout);
        try {
          const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
          this.sseEndpoint = typeof data === "string" ? data : data.endpoint;
          if (!this.sseEndpoint.startsWith("http")) {
            this.sseEndpoint = new URL(this.sseEndpoint, baseUrl).toString();
          }
          this.sseSource.close();
          this._onReady();
          resolve();
        } catch (err) {
          clearTimeout(timeout);
          this.sseSource.close();
          reject(err);
        }
      });
      
      this.sseSource.onopen = () => {
        // Some servers send endpoint immediately on open
      };
    });
  }
  _onReady() {
    // HTTP/SSE transport ready, now initialize
    this.initialize().then(() => {
      this.listTools().then(tools => {
        mcpClients.set(this.name, this);
        for (const t of tools) {
          let exposed = t.name;
          if (TOOLS.some(x => x.function.name === exposed) || mcpRegistry.has(exposed))
            exposed = `${this.name}__${t.name}`;
          mcpRegistry.set(exposed, { client: this, realName: t.name, schema: t });
        }
        console.log(dim(`✓ MCP '${this.name}' connected (${tools.length} tools)`));
      }).catch(e => {
        console.log(yellow(`! MCP server '${this.name}' tool list failed: ${e.message}`));
      });
    }).catch(e => {
      console.log(yellow(`! MCP server '${this.name}' initialize failed: ${e.message}`));
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
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || "MCP error")) : resolve(msg.result);
      }
    }
  }
  _send(msg) {
    if (this.transport === "stdio") {
      try { this.proc.stdin.write(JSON.stringify(msg) + "\n"); } catch {}
    } else if (this.transport === "sse" || this.transport === "http") {
      this._sendHttp(msg);
    }
  }
  async _sendHttp(msg) {
    if (!this.sseEndpoint) {
      // Not yet connected
      return;
    }
    try {
      const res = await fetch(this.sseEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg),
      });
      const data = await res.json();
      if (data.id !== undefined && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        data.error ? reject(new Error(data.error.message || "MCP error")) : resolve(data.result);
      }
    } catch (e) {
      // Find pending request and reject
      for (const [id, { reject }] of this.pending) {
        if (id === msg.id) {
          this.pending.delete(id);
          reject(e);
          break;
        }
      }
    }
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
    if (this.transport === "stdio") {
      this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
    } else {
      // For HTTP/SSE, send initialized notification too
      this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
    }
  }
  async listTools() { this.tools = (await this.request("tools/list", {})).tools || []; return this.tools; }
  async callTool(name, args, timeoutMs) {
    const res = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const parts = (res.content || []).map(c =>
      c.type === "text" ? c.text : `[${c.type}] ` + JSON.stringify(c));
    return [!res.isError, parts.join("\n") || "[no output]"];
  }
  stop() {
    if (this.transport === "stdio") {
      try { this.proc?.kill(); } catch {}
    } else if (this.transport === "sse" || this.transport === "http") {
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
      client.start();
      // For stdio transport, initialize and list tools synchronously
      // For SSE/HTTP, initialization happens asynchronously in _onReady()
      if (client.transport === "stdio") {
        await client.initialize();
        const tools = await client.listTools();
        mcpClients.set(sname, client);
        for (const t of tools) {
          let exposed = t.name;
          if (TOOLS.some(x => x.function.name === exposed) || mcpRegistry.has(exposed))
            exposed = `${sname}__${t.name}`;
          mcpRegistry.set(exposed, { client, realName: t.name, schema: t });
        }
        console.log(dim(`✓ MCP '${sname}' connected (${tools.length} tools)`));
      }
      // For SSE/HTTP, the connection is handled asynchronously in _onReady()
    } catch (e) {
      console.log(yellow(`! MCP server '${sname}' failed: ${e.message}`));
      client.stop();
    }
  }
}
async function ensureMcp() { if (!mcpReady) { mcpReady = true; await connectMcp(); } }

function allTools() {
  const list = [...TOOLS];
  for (const [exposed, { schema }] of mcpRegistry) {
    list.push({ type: "function", function: {
      name: exposed,
      description: schema.description || "",
      parameters: schema.inputSchema || { type: "object", properties: {} },
    }});
  }
  return list;
}

// ------------------------------------------------------------------ config
function loadCfg() {
  const cfg = { apiUrl: "", model: "", apiKey: "", context: 0, maxout: 10000,
                maxTokens: 0, tools: true, system: "", timeout: 180, projectDir: "",
                intercept: false, autoYes: false, maxSteps: 0,
                blockedCommands: DEFAULT_BLOCKED,
                draftModel: "", temperature: null,
                reasoning: "", redact: true, mode: "code" };
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_PATH, "utf8"))); } catch {}
  return cfg;
}
function saveCfg(cfg) {
  try { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch {}
}
// NOTE: intentionally says NOTHING about secret masking — the model must never
// learn that values are substituted. Round-tripping handles it transparently.
const systemPrompt = (cfg, userPrompt = "") => {
  let s = "";
  if (cfg.mode === "ask") {
    s = "You are an expert AI assistant. The user is in ASK mode. Answer questions directly and conversationally. Do NOT use any tools, do NOT read or write files, and do NOT execute commands. Just provide helpful text responses.";
  } else if (cfg.mode === "plan") {
    s = "You are an expert autonomous software-engineering agent. The user is in PLAN mode. Your goal is to analyze the project and create a detailed, step-by-step plan to solve the user's task. You may use read-only tools (like read_file and shell for searching) to gather context, but DO NOT write, edit, or execute any mutating commands. Output a clear, actionable plan.";
  } else {
    s = cfg.system || SYS_PROMPT;
  }
  s += `\nOperating system: ${osDescription()} · shell: ${SHELL_NAME}. Use ONLY commands valid for this OS and shell.`;
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
async function* streamChat(cfg, messages, tools, signal) {
  const payload = { model: cfg.model, messages, stream: true };
  if (tools?.length) payload.tools = tools;
  if (cfg.maxTokens) payload.max_tokens = cfg.maxTokens;
  if (!cfg._noStreamOpts) payload.stream_options = { include_usage: true };
  if (cfg.draftModel) payload.draft_model = cfg.draftModel;
  if (typeof cfg.temperature === "number" && !isNaN(cfg.temperature)) payload.temperature = cfg.temperature;
  if (cfg.reasoning) payload.reasoning_effort = cfg.reasoning;

  let res;
  try {
    res = await fetch(completionUrl(cfg.apiUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
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
  if (name === "read_file") {
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

  return new Promise(resolve => {
    const child = exec(cmd, {
      timeout: timeoutSec * 1000, maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, cwd: opts.cwd || process.cwd(),
      ...(shell ? { shell } : {}),
    }, (err, stdout, stderr) => {
      currentChild = null;
      if (err?.killed) return resolve([false,
        `error: terminated after ${timeoutSec}s. If this is a server/watcher, rerun with background=true.`]);
      let text = stdout || "";
      if (stderr) text += "\n[stderr]\n" + stderr;
      if (!text.trim()) text = "[no output]";
      if (err) {
        const code = typeof err.code === "number" ? err.code : 1;
        recordCommand(cmd, false, text);
        return resolve([false, (`[exit code ${code}]\n` + text).trim()]);
      }
      recordCommand(cmd, true, text);
      resolve([true, text.trim()]);
    });
    currentChild = child;
  });
}
function toolRead(a, cfg) {
  const p = resolveP(a.path, cfg);
  if (isProtectedPath(p)) return [false, `error: could not read file '${a.path}' (no such file)`];
  const fd = fs.openSync(p, "r");
  try {
    const size = Math.min(fs.fstatSync(fd).size, 2_000_000);
    const b = Buffer.alloc(size);
    fs.readSync(fd, b, 0, size, 0);
    const lines = b.toString("utf8").split("\n");
    const total = lines.length;
    const s = Math.max(1, parseInt(a.start, 10) || 1);
    const e = Math.min(total, parseInt(a.end, 10) || total);
    const seg = lines.slice(s - 1, e).join("\n");
    const info = a.start || a.end ? `[${total} lines total, showed ${s}-${e}]\n` : "";
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
  const oldStr = restoreSecrets(String(a.old_str || a.old_string || ""));
  const newStr = restoreSecrets(String(a.new_str || a.new_string || ""));
  if (!oldStr) return [false, "error: old_str cannot be empty"];
  if (oldStr.includes("chars truncated]…") || oldStr.includes("truncated")) {
    return [false, "error: old_str contains truncation markers ('…[...chars truncated]…'). You cannot replace text you haven't read. Use `read_file` with `start`/`end` line numbers to read the exact lines, then try again."];
  }
  const normOrig = original.replace(/\r\n/g, "\n");
  const normOld = oldStr.replace(/\r\n/g, "\n");
  const normNew = newStr.replace(/\r\n/g, "\n");
  const occurrences = normOrig.split(normOld).length - 1;
  if (occurrences === 0) return [false, `error: old_str not found in file. Ensure exact match (check indentation/whitespace).`];
  if (occurrences > 1) return [false, `error: old_str matches ${occurrences} times. Include more context to make it unique.`];
  const updated = normOrig.replace(normOld, normNew);
  const finalContent = original.includes("\r\n") ? updated.replace(/\n/g, "\r\n") : updated;
  fs.writeFileSync(p, finalContent);
  return [true, `replaced 1 occurrence in ${displayPath(p)}`];
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
async function runTool(name, args, cfg) {
  try {
    let out;
    if (mcpRegistry.has(name)) {
      const { client, realName } = mcpRegistry.get(name);
      out = await client.callTool(realName, args, (cfg.timeout || 180) * 1000);
    }
    else if (name === "shell") out = await runShell(String(args.command || args._raw || ""), cfg.timeout || 180, { background: args.background, cwd: cfg.projectDir }, cfg);
    else if (name === "read_file") out = toolRead(args, cfg);
    else if (name === "str_replace") out = toolStrReplace(args, cfg);
    else if (name === "write_file") out = toolWrite(args, cfg);
    else if (name === "remember") out = toolRemember(args, cfg);
    else if (name === "forget") out = toolForget(args);
    else return [false, `unknown tool '${name}'`];
    out[1] = maskSecrets(out[1], cfg);   // silent: real -> dummy before the model ever sees it
    return out;
  } catch (e) {
    return [false, `error: ${e.message}`];
  }
}

// ------------------------------------------------------------------ context mgmt / stats
const estTokens = h => Math.max(1, Math.floor(JSON.stringify(h).length / 4));
function trimHistory(h, cfg) {
  const cap = Number(cfg.context) || 0;
  if (!cap) return;
  const budget = cap - 1024 - (Number(cfg.maxTokens) || 0);
  while (h.length > 2 && estTokens(h) > budget) {
    h.splice(1, 1);
    while (h.length > 1 && h[1].role === "tool") h.splice(1, 1);
  }
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
function sanitizeHistory(h) {
  const openIds = new Set();
  for (let i = 1; i < h.length; i++) {
    const m = h[i];
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      m.tool_calls = m.tool_calls.filter(tc => tryParse(tc.function?.arguments || "{}") !== undefined);
      if (!m.tool_calls.length) { delete m.tool_calls; m.content = m.content || "(tool call omitted)"; openIds.clear(); }
      else m.tool_calls.forEach(tc => openIds.add(tc.id));
    } else if (m.role === "tool") {
      if (!openIds.has(m.tool_call_id)) h[i] = null;
      else openIds.delete(m.tool_call_id);
    } else if (m.role === "assistant" || m.role === "user") {
      openIds.clear();
    }
  }
  for (let i = h.length - 1; i >= 0; i--) if (h[i] === null) h.splice(i, 1);
}

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

  return calls;
}
function stripToolMarkup(t) {
  return String(t || "")
    .replace(/\x3ctool\x3e[\s\S]*?(?:\x3c\/tool\x3e|$)/gi, "")
    .replace(/\x3ctool\b[^\\x3e]*\x3e[\s\S]*?(?:\x3c\/tool\x3e|$)/gi, "")
    .replace(/\x3ctool_call\x3e[\s\S]*?(?:\x3c\/tool_call\x3e|$)/gi, "")
    .replace(/\x3cfunction=[\s\S]*?(?:\x3c\/function\x3e|$)/gi, "")
    .replace(/\x3c\/?(?:tool|tool_call|bash|shell|cmd|terminal|function|command|path|start|end|old_str|new_str|content|input|arguments|parameter)\b[^\x3e]*\x3e/gi, "")
    .trim();
}

// ------------------------------------------------------------------ agent loop
async function agentTurn(cfg, history, keys) {
  if (cfg.tools) await ensureMcp();
  let tools = cfg.tools ? allTools() : [];
  if (cfg.mode === "ask") tools = [];
  else if (cfg.mode === "plan") tools = tools.filter(t => ["read_file", "shell"].includes(t.function.name));
  const lastUserMsg = [...history].reverse().find(m => m.role === "user")?.content || "";
  if (history[0]?.role === "system") history[0].content = systemPrompt(cfg, lastUserMsg);

  const limit = Number(cfg.maxSteps) || 0;
  let step = 0;
  let failStreak = 0;
  for (;;) {
    step++;
    if (limit > 0 && step > limit) {
      history.push({ role: "assistant", content: "(stopped: max tool steps reached)" });
      console.log(red(`! hit max tool steps (${limit}) — raise with /set max_steps <n>, or 0 for unlimited`));
      return;
    }
    if (limit === 0 && step % 25 === 0) {
      console.log(dim(`… still working (${step} tool steps) — ctrl+c to stop`));
    }

    trimHistory(history, cfg);
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
          if (!gotOutput && attempts < 3) {
            if (/stream_options|include_usage/i.test(msg)) {
              cfg._noStreamOpts = true;
              process.stdout.write(yellow("! usage reporting unsupported — retrying without it\n"));
              continue;
            }
            if (RETRYABLE(msg)) {
              process.stdout.write(yellow(`! ${msg} — retry ${attempts}/2 in ${attempts}s…\n`));
              await sleep(1000 * attempts);
              continue;
            }
            if (/(context|token|length)/i.test(msg) &&
                /(exceed|too (long|many|large)|maximum|limit|reduce|at most)/i.test(msg)) {
              const cur = Number(cfg.context) || estTokens(history);
              cfg.context = Math.max(2048, Math.floor(cur * 0.6));
              trimHistory(history, cfg);
              saveCfg(cfg);
              process.stdout.write(yellow(`! context overflow — trimmed history (context now ${cfg.context}); you can also run /compact\n`));
              continue;
            }
            if (/invalid tool call|tool call arguments|malformed tool/i.test(msg)) {
              sanitizeHistory(history);
              process.stdout.write(yellow("! repaired malformed tool-call history — retrying\n"));
              continue;
            }
            if (tools.length && step === 1 && /tool|function/i.test(msg)) {
              process.stdout.write(yellow("! tools rejected by endpoint — retrying as plain chat\n"));
              tools = []; cfg.tools = false;
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
    // FIX: model printed tool calls as XML text (server without native tools)
    if (!tcs.length && result.content) {
      const xt = parseTextToolCalls(result.content);
      if (xt.length) {
        tcs = xt;
        result.content = stripToolMarkup(result.content);
      }
    }
    if (!tcs.length) { // final message → done (1 round trip)
      history.push({ role: "assistant", content: result.content || "" });
      if (result.usage) showStats(cfg, history, result.usage);
      return;
    }

    const entries = tcs.map((t, i) => ({
      id: t.id || `call_${step}_${i}`,
      type: "function",
      function: { name: t.name || "", arguments: t.arguments || "{}" },
    }));
    history.push({ role: "assistant", content: result.content || null, tool_calls: entries });

    for (const e of entries) {
      let args; try { args = JSON.parse(e.function.arguments); } catch { args = { _raw: e.function.arguments }; }
      console.log(yellow("⚙ ") + bold(e.function.name) + dim(" " + fmtCall(e.function.name, args)));

      if (cfg.intercept) {
        const verdict = classifyTool(e.function.name, args);
        if (verdict === "block") {
          console.log("  " + red("⛔ blocked by safety policy"));
          history.push({ role: "tool", tool_call_id: e.id,
                         content: "error: blocked by safety policy (dangerous command). Try a safer alternative." });
          failStreak++;
        } else {
          let run = true;
          if (verdict === "ask" && !cfg.autoYes) {
            const ans = await confirmTool(e.function.name, args, keys);
            if (ans === "always") cfg.autoYes = true;
            else if (ans === "no") {
              run = false;
              console.log("  " + red("✗ rejected by user"));
              history.push({ role: "tool", tool_call_id: e.id,
                             content: "error: rejected by user — do NOT retry this exact command" });
            }
          }
          if (run) {
            keys.onCtrlC = () => { ac.abort(); currentChild?.kill(); };
            const [ok, res] = await runTool(e.function.name, args, cfg);
            keys.onCtrlC = null;
            if (ac.signal.aborted) { console.log(dim("· interrupted")); return; }
            const first = (res.trim().split("\n")[0] || "").slice(0, 140);
            const more = res.length > 140 ? dim(` …${res.length}ch`) : "";
            console.log(`  ${ok ? green("✓") : red("✗")} ${dim(first)}${more}`);
            if (ok) failStreak = 0; else failStreak++;
            history.push({ role: "tool", tool_call_id: e.id, content: truncate(res, cfg.maxout) });
          }
        }
      } else {
        keys.onCtrlC = () => { ac.abort(); currentChild?.kill(); };
        const [ok, res] = await runTool(e.function.name, args, cfg);
        keys.onCtrlC = null;
        if (ac.signal.aborted) { console.log(dim("· interrupted")); return; }
        const first = (res.trim().split("\n")[0] || "").slice(0, 140);
        const more = res.length > 140 ? dim(` …${res.length}ch`) : "";
        console.log(`  ${ok ? green("✓") : red("✗")} ${dim(first)}${more}`);
        if (ok) failStreak = 0; else failStreak++;
        history.push({ role: "tool", tool_call_id: e.id, content: truncate(res, cfg.maxout) });
      }

      if (failStreak >= MAX_FAIL_STREAK) {
        history.push({ role: "assistant", content:
          `I hit ${MAX_FAIL_STREAK} consecutive failures and stopped to avoid making things worse. ` +
          "Here's where I'm stuck — please tell me how you'd like to proceed." });
        console.log(red(`! ${MAX_FAIL_STREAK} consecutive tool failures — stopping to avoid damage`));
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
      history.length = 1; console.log(dim("history cleared")); break;
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
        `\n  max_steps ${cfg.maxSteps || "unlimited"}\n  blocked  ${(cfg.blockedCommands || DEFAULT_BLOCKED).length} pattern(s)` +
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
        else if (k === "max_steps") cfg.maxSteps = v ? parseInt(v, 10) : 0;
        else if (k === "system" && v) { cfg.system = v; if (history.length) history[0].content = systemPrompt(cfg); }
        else { console.log(dim("usage: /set url|model|key|draft_model|temperature|reasoning|mode|redact|dir|context|max_tokens|maxout|intercept|max_steps|system <value>")); return true; }
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
  console.log(bold("◆ ai-agent") + dim(`  ${cfg.model} @ ${cfg.apiUrl}  ·  ${osDescription()}  ·  ctx ${cfg.context ? fmtK(cfg.context) : "unknown"}  ·  key ${cfg.apiKey ? "✓" : "—"}` + (cfg.draftModel ? `  ·  draft ${cfg.draftModel}` : "") + (cfg.temperature != null ? `  ·  temp ${cfg.temperature}` : "") + (cfg.reasoning ? `  ·  reasoning ${cfg.reasoning}` : "") + (cfg.intercept ? "  ·  🔒 intercept" : "") + modeStr));
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
      case "--no-tools": a.noTools = true; break;
      case "--list": a.list = true; break;
      case "--save": a.save = true; break;
      case "-h": case "--help": a.help = true; break;
      default: if (!a.prompt) a.prompt = x;
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
  if (args.url) cfg.apiUrl = args.url;
  if (args.model) cfg.model = args.model;
  if (args.key) cfg.apiKey = args.key;
  if (args.dir) cfg.projectDir = args.dir;
  if (args.context) cfg.context = args.context;
  if (args.system) cfg.system = args.system;
  if (args.maxout) cfg.maxout = args.maxout;
  if (args.maxTokens) cfg.maxTokens = args.maxTokens;
  if (args.noTools) cfg.tools = false;
  if (args.intercept) cfg.intercept = true;
  if (args.maxSteps !== undefined) cfg.maxSteps = args.maxSteps;
  if (args.draftModel) cfg.draftModel = args.draftModel;
  if (typeof args.temperature === "number" && !isNaN(args.temperature)) cfg.temperature = args.temperature;
  if (args.reasoning) cfg.reasoning = args.reasoning;
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
    const snap = history.length;
    history.push({ role: "user", content: t });
    try {
      await agentTurn(cfg, history, keys);
    } catch (e) {
      history.length = snap;
      console.error(red("✗ " + e.message));
      if (/context|token/i.test(e.message)) console.log(dim("  hint: /set context <n> or /compact to free context"));
    }
  }
  console.log(dim("bye"));
}

main().catch(e => { console.error(red("fatal: " + (e.stack || e.message))); process.exit(1); });