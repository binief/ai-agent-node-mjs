#!/usr/bin/env node
/**
 * harness.mjs — a minimal coding harness, distilled from agent.mjs.
 * Node >= 18, ZERO dependencies (stdlib only — no `eventsource`, no node_modules needed).
 *
 * KEPT from agent.mjs (the parts that make coding work):
 *   - OpenAI-compatible client: SSE streaming AND `"stream": false` single-JSON mode
 *   - tool-call chunk accumulation + repair for sloppy/partial JSON arguments
 *   - the tool loop: retries, context trimming, fail-streak guard, repeat guard, ctrl+c abort
 *   - the coding tools: shell, read_file, write_file, str_replace, list_files
 *   - config precedence, aliases, project dir, one-shot / piped / interactive entry points
 *
 * DROPPED (everything that is not needed to write code):
 *   - MCP client, plan/goal gate, long-term memory, silent secret redaction, sessions,
 *     OS command ledger, draft model, ask/plan/code modes, approval interception,
 *     cycle-detection heuristics, XML tool-call fallback, the custom raw-mode line
 *     editor (plain `node:readline` instead), first-run migration.
 *
 * quick start:
 *   node harness.mjs                                        # interactive REPL
 *   node harness.mjs "add tests for parser.mjs"             # one-shot
 *   echo "explain this repo" | node harness.mjs             # piped one-shot
 *   node harness.mjs --url ollama --model qwen3-coder --dir ~/proj
 *   node harness.mjs --no-stream --model gpt-4o-mini "fix the build"
 *
 * config precedence: CLI flags > env > ~/.harness/config.json > ~/.aiterm/config.json
 *                    (agent.mjs settings, read-only) > built-in defaults
 * env: AI_URL / AI_MODEL / AI_KEY / AI_DIR / AI_STREAM / NO_COLOR
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { exec, spawn } from "node:child_process";
import process from "node:process";

const VERSION = "0.1.0";

// ------------------------------------------------------------------ ui helpers
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = code => s => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2"), bold = paint("1"), red = paint("31"),
      green = paint("32"), yellow = paint("33"), cyan = paint("36");

const PROMPT = "❯ ";
const TTY = !!process.stdout.isTTY;
const clearLine = () => { if (TTY) process.stdout.write("\r\x1b[K"); };
const IS_WIN = process.platform === "win32";
const SHELL_NAME = IS_WIN ? "cmd.exe" : (process.env.SHELL ? path.basename(process.env.SHELL) : "sh");

class ApiError extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tryParse = s => { try { return JSON.parse(s); } catch { return undefined; } };
const expandUser = p => (String(p ?? "").startsWith("~") ? path.join(os.homedir(), String(p).slice(1)) : String(p ?? ""));
const displayPath = p => {
  const s = String(p ?? ""), h = os.homedir();
  return s === h ? "~" : s.startsWith(h + path.sep) ? "~" + s.slice(h.length) : s;
};
const RETRYABLE = msg => /HTTP (429|5\d\d)|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang|overloaded|rate.?limit|temporar|unavailable/i.test(msg);

function osDescription() {
  const p = process.platform;
  if (p === "win32") return `Windows ${os.release()}`;
  if (p === "darwin") return `macOS ${os.release()}`;
  if (p === "linux") return `Linux ${os.release()}`;
  return `${os.type()} ${os.release()}`;
}

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

// ------------------------------------------------------------------ safety (small, always on)
const DEFAULT_BLOCKED = [
  "^\\s*powershell(\\.exe)?(\\s|$)",
  "^\\s*pwsh(\\.exe)?(\\s|$)",
];
const DANGEROUS = [
  /\brm\s+(-[a-z]+\s+)*-[a-z]*r[a-z]*\s+(\/|~|\$HOME)(\s|$)/i,
  /--no-preserve-root/i,
  /\bmkfs\b/i, /\bdd\b[^|;&]*\bof=\/dev\//i, />\s*\/dev\/sd/i,
  /\bformat\s+[a-z]:/i, /\brd\s+\/s\b/i, /\bdel\s+\/[sfq]+[a-z]:\\/i,
  /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/i,
];
function commandVerdict(cmd, cfg) {
  const c = String(cmd || "").trim();
  if (DANGEROUS.some(re => re.test(c))) return { allowed: false, why: "destructive command refused" };
  for (const pat of (cfg.blockedCommands || DEFAULT_BLOCKED)) {
    let re; try { re = new RegExp(pat, "i"); } catch { continue; }
    if (re.test(c)) return { allowed: false, why: `blocked by policy (${pat})` };
  }
  return { allowed: true };
}

// ------------------------------------------------------------------ system prompt
const SYS_PROMPT =
  "You are an expert coding agent working in the user's project through a terminal.\n" +
  "Work autonomously until the task is actually done — explore, edit, run, verify. Do not stop to ask permission; pick the most reasonable interpretation, state the assumption in one line, and continue.\n" +
  "\n" +
  "METHOD:\n" +
  "1. Understand before changing: use `shell` (grep/find/rg/git) and `list_files` to locate the relevant code, then `read_file` it. Never guess at file contents.\n" +
  "2. Batch every independent tool call into ONE response (pass `paths` to read_file to grab several files at once). Never re-read a file you just wrote, never re-run a command that already succeeded.\n" +
  "3. Edit precisely: `str_replace` for targeted edits (old_str must match exactly and uniquely); `write_file` only for new files or full rewrites — always complete content, never placeholders or omission markers.\n" +
  "4. Follow the project's existing conventions: language, framework versions, indentation, naming, test style.\n" +
  "5. Verify: run the build / tests / linter and confirm they pass. If a check fails, fix it in the same turn. Never claim success you did not observe.\n" +
  "6. Never repeat an identical tool call. If the same fix fails three times, stop and explain the blocker and the options.\n" +
  "\n" +
  "SHELL: use commands valid for the OS and shell named below; `background: true` for servers and watchers.\n" +
  "CODE: no filler or explanatory comments unless asked.\n" +
  "OUTPUT: terse, no preamble, no restating the task. Finish with 1-3 lines: what changed and how it was verified.";

function systemPrompt(cfg) {
  let s = cfg.system || SYS_PROMPT;
  s += `\nOperating system: ${osDescription()} · shell: ${SHELL_NAME}.`;
  s += `\nWorking directory: ${cfg.projectDir || process.cwd()} — resolve every path and run every command relative to it.`;
  const blocked = cfg.blockedCommands || DEFAULT_BLOCKED;
  if (blocked.length) s += `\nBlocked command patterns (never run these): ${blocked.join("  |  ")}`;
  s += `\nTool calls must be native JSON function calls, not XML or markdown.`;
  return s;
}

// ------------------------------------------------------------------ tools
const TOOLS = [
  { type: "function", function: {
      name: "shell",
      description: "Run a shell command in the project folder; returns exit code + stdout/stderr. Chain independent commands with && to save round trips. Use background=true for dev servers/watchers so it returns immediately.",
      parameters: { type: "object",
        properties: {
          command: { type: "string", description: "The command to run." },
          background: { type: "boolean", description: "true for processes that never exit (servers, watchers)." },
        },
        required: ["command"] } } },
  { type: "function", function: {
      name: "read_file",
      description: "Read a text file, optionally a line range. Pass `paths` (array) instead of `path` to read several files in ONE call.",
      parameters: { type: "object",
        properties: {
          path: { type: "string", description: "Single file to read." },
          paths: { type: "array", items: { type: "string" }, description: "Several files at once — cheaper than one call per file." },
          start: { type: "integer", description: "First line, 1-based (only with `path`)." },
          end: { type: "integer", description: "Last line inclusive (only with `path`)." },
        } } } },
  { type: "function", function: {
      name: "str_replace",
      description: "Replace one exact, contiguous block of text in a file. `old_str` must match the file exactly (including whitespace) and must be unique — add surrounding lines if it is not.",
      parameters: { type: "object",
        properties: {
          path: { type: "string" },
          old_str: { type: "string", description: "Exact text to find." },
          new_str: { type: "string", description: "Text to replace it with (empty string deletes it)." },
        },
        required: ["path", "old_str", "new_str"] } } },
  { type: "function", function: {
      name: "write_file",
      description: "Create a new file or completely overwrite an existing one. Provide the FULL content; parent directories are created automatically.",
      parameters: { type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"] } } },
  { type: "function", function: {
      name: "list_files",
      description: "List the files and folders under a path (default: the project root), ignoring node_modules/.git/build artefacts. Use it to get oriented before reading.",
      parameters: { type: "object",
        properties: {
          path: { type: "string", description: "Directory to list; defaults to the project root." },
          depth: { type: "integer", description: "How deep to recurse (1-8, default 3)." },
        } } } },
];

// Models name tools differently; accept the common aliases.
const TOOL_ALIASES = {
  bash: "shell", sh: "shell", cmd: "shell", run_shell: "shell", execute: "shell", terminal: "shell",
  read: "read_file", view: "read_file", cat: "read_file",
  write: "write_file", create_file: "write_file", save_file: "write_file",
  edit: "str_replace", edit_file: "str_replace", replace: "str_replace", apply_patch: "str_replace",
  ls: "list_files", list_dir: "list_files", list_directory: "list_files", tree: "list_files",
};
const canonicalTool = name => {
  const n = String(name || "").trim();
  return TOOLS.some(t => t.function.name === n) ? n : (TOOL_ALIASES[n.toLowerCase()] || n);
};

function fmtCall(name, args) {
  if (name === "shell") return "$ " + String(args.command || args._raw || "");
  if (name === "read_file") {
    if (Array.isArray(args.paths)) return `read ${args.paths.length} files: ${args.paths.join(", ")}`;
    let r = `read ${args.path || "?"}`;
    if (args.start || args.end) r += ` [${args.start || 1}-${args.end || "end"}]`;
    return r;
  }
  if (name === "str_replace") return `edit ${args.path || "?"} (${String(args.old_str ?? "").split("\n").length} lines)`;
  if (name === "write_file") return `write ${args.path || "?"} (${String(args.content ?? "").length} chars)`;
  if (name === "list_files") return `list ${args.path || "."} (depth ${args.depth || 3})`;
  return JSON.stringify(args).slice(0, 160);
}

// ------------------------------------------------------------------ tool implementations
const resolveP = (p, cfg) => path.resolve(cfg?.projectDir || process.cwd(), expandUser(p));

function truncate(s, cap) {
  cap = Number(cap) || 0;
  s = String(s ?? "");
  if (!cap || s.length <= cap) return s;
  const head = Math.floor(cap * 0.7);
  return s.slice(0, head) + `\n…[${s.length - cap} chars truncated]…\n` + s.slice(head - cap);
}

const ACTIVE = { ac: null, child: null };

function runShell(cmd, cfg) {
  const verdict = commandVerdict(cmd, cfg);
  if (!verdict.allowed) return Promise.resolve([false, `error: ${verdict.why}`]);
  const timeoutSec = Number(cfg.timeout) || 180;
  const cwd = cfg.projectDir || process.cwd();
  const shell = IS_WIN ? "cmd.exe" : undefined;

  return new Promise(resolve => {
    const child = exec(String(cmd), {
      timeout: timeoutSec * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, cwd,
      ...(shell ? { shell } : {}),
    }, (err, stdout, stderr) => {
      ACTIVE.child = null;
      if (err?.killed) return resolve([false,
        `error: terminated after ${timeoutSec}s. If this is a server or watcher, rerun with background=true.`]);
      let text = stdout || "";
      if (stderr) text += "\n[stderr]\n" + stderr;
      if (!text.trim()) text = "[no output]";
      if (err) {
        const code = typeof err.code === "number" ? err.code : 1;
        return resolve([false, (`[exit code ${code}]\n` + text).trim()]);
      }
      resolve([true, text.trim()]);
    });
    ACTIVE.child = child;
  });
}

function runBackground(cmd, cfg) {
  try {
    const child = spawn(String(cmd), {
      shell: IS_WIN ? "cmd.exe" : "/bin/sh",
      detached: true, stdio: "ignore", windowsHide: true,
      cwd: cfg.projectDir || process.cwd(),
    });
    child.unref();
    return [true, `started in background (pid ${child.pid}): ${cmd}`];
  } catch (e) {
    return [false, `error: ${e.message}`];
  }
}

function toolRead(a, cfg) {
  const many = Array.isArray(a.paths) ? a.paths.map(String).filter(Boolean) : [];
  if (many.length) {
    const cap = Math.max(2000, Math.floor((Number(cfg.maxout) || 24000) / many.length));
    const parts = [];
    let allOk = true;
    for (const p of many.slice(0, 12)) {
      const [ok, txt] = toolRead({ path: p }, cfg);
      if (!ok) allOk = false;
      parts.push(`===== ${p}${ok ? "" : " (FAILED)"} =====\n${ok ? txt.slice(0, cap) : txt}`);
    }
    if (many.length > 12) parts.push(`…and ${many.length - 12} more files not read (12 per call)`);
    return [allOk, parts.join("\n\n")];
  }
  if (!String(a.path || "").trim()) return [false, "error: read_file needs `path` (one file) or `paths` (several)"];
  const p = resolveP(a.path, cfg);
  let fd;
  try { fd = fs.openSync(p, "r"); }
  catch (e) { return [false, `error: could not read file '${a.path}' (${e.code || e.message})`]; }
  try {
    if (!fs.fstatSync(fd).isFile()) return [false, `error: '${a.path}' is not a file — try list_files`];
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

function toolWrite(a, cfg) {
  if (!String(a.path || "").trim()) return [false, "error: write_file needs `path` and `content`"];
  const p = resolveP(a.path, cfg);
  const content = String(a.content ?? "");
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  } catch (e) { return [false, `error: could not write file '${a.path}' (${e.code || e.message})`]; }
  return [true, `wrote ${content.length} chars to ${displayPath(p)}`];
}

function toolStrReplace(a, cfg) {
  if (!String(a.path || "").trim()) return [false, "error: str_replace needs `path`, `old_str`, `new_str`"];
  const p = resolveP(a.path, cfg);
  let original;
  try { original = fs.readFileSync(p, "utf8"); }
  catch (e) { return [false, `error: could not read file '${a.path}' (${e.code || e.message})`]; }
  const oldStr = String(a.old_str ?? a.old_string ?? "");
  const newStr = String(a.new_str ?? a.new_string ?? "");
  if (!oldStr) return [false, "error: old_str cannot be empty — use write_file to create or fully rewrite a file"];
  if (/chars truncated\]…/.test(oldStr)) {
    return [false, "error: old_str contains a truncation marker. Read the exact lines with read_file (start/end) first, then retry."];
  }
  const crlf = original.includes("\r\n");
  const normOrig = original.replace(/\r\n/g, "\n");
  const normOld = oldStr.replace(/\r\n/g, "\n");
  const normNew = newStr.replace(/\r\n/g, "\n");
  const occurrences = normOrig.split(normOld).length - 1;
  if (occurrences === 0) return [false, "error: old_str not found in the file. It must match exactly, including whitespace and indentation — read the file and copy the real text."];
  if (occurrences > 1) return [false, `error: old_str matches ${occurrences} times. Add surrounding lines to make it unique.`];
  const updated = normOrig.replace(normOld, normNew);
  try { fs.writeFileSync(p, crlf ? updated.replace(/\n/g, "\r\n") : updated); }
  catch (e) { return [false, `error: could not write file '${a.path}' (${e.code || e.message})`]; }
  return [true, `replaced 1 occurrence in ${displayPath(p)}`];
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".output",
  "coverage", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "target", "out", ".turbo", ".cache", ".parcel-cache", ".svelte-kit", ".tox", ".nox", "obj", "bin"]);

function toolList(a, cfg) {
  const base = resolveP(a.path || ".", cfg);
  if (!fs.existsSync(base)) return [false, `error: no such directory '${a.path}'`];
  const st = fs.statSync(base);
  if (st.isFile()) return [true, displayPath(base) + " (file)"];
  const maxDepth = Math.max(1, Math.min(8, parseInt(a.depth, 10) || 3));
  const MAX_ENTRIES = 400;
  const out = [];
  let hidden = 0;
  const walk = (dir, rel, depth) => {
    if (out.length >= MAX_ENTRIES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (out.length >= MAX_ENTRIES) return;
      const full = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) { hidden++; continue; }
        out.push(r + "/");
        if (depth < maxDepth) walk(full, r, depth + 1);
      } else {
        if (e.name.startsWith(".") && ![".env.example", ".gitignore", ".eslintrc.json"].includes(e.name)) { hidden++; continue; }
        out.push(r);
      }
    }
  };
  walk(base, "", 1);
  let text = out.join("\n") || "[empty directory]";
  if (out.length >= MAX_ENTRIES) text += `\n…(stopped at ${MAX_ENTRIES} entries — list a subfolder or use shell: find/grep)`;
  if (hidden) text += `\n[${hidden} ignored entries: node_modules, .git, build output, dotfiles]`;
  return [true, `${displayPath(base)}\n${text}`];
}

async function runTool(rawName, args, cfg) {
  const name = canonicalTool(rawName);
  try {
    if (name === "shell") {
      const cmd = String(args.command || args.cmd || args._raw || "");
      if (!cmd.trim()) return [false, "error: shell needs `command`"];
      return args.background ? runBackground(cmd, cfg) : await runShell(cmd, cfg);
    }
    if (name === "read_file") return toolRead(args, cfg);
    if (name === "write_file") return toolWrite(args, cfg);
    if (name === "str_replace") return toolStrReplace(args, cfg);
    if (name === "list_files") return toolList(args, cfg);
    return [false, `error: unknown tool '${rawName}'. Available: ${TOOLS.map(t => t.function.name).join(", ")}`];
  } catch (e) {
    return [false, `error: ${e.message}`];
  }
}

// ------------------------------------------------------------------ config
const CFG_CANDIDATES = [
  path.join(os.homedir(), ".harness", "config.json"),
  path.join(os.homedir(), ".aiterm", "config.json"),   // reuse agent.mjs settings (read-only)
];
const DEFAULTS = {
  apiUrl: "", model: "", apiKey: "", projectDir: "", system: "",
  context: 0, maxout: 10000, maxTokens: 0, timeout: 180, maxSteps: 0,
  tools: true, stream: true, temperature: null, reasoning: "",
  blockedCommands: DEFAULT_BLOCKED,
};

function loadCfg() {
  const cfg = { ...DEFAULTS, _source: "" };
  for (const p of CFG_CANDIDATES) {
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const k of Object.keys(DEFAULTS)) if (j[k] !== undefined) cfg[k] = j[k];
      cfg._source = p;
      break;
    } catch {}
  }
  const env = process.env;
  cfg.apiUrl = env.AI_URL || env.OPENAI_BASE_URL || cfg.apiUrl;
  cfg.apiKey = env.AI_KEY || env.OPENAI_API_KEY || cfg.apiKey;
  cfg.model = env.AI_MODEL || cfg.model;
  cfg.projectDir = env.AI_DIR || cfg.projectDir;
  if (env.AI_STREAM) cfg.stream = ["on", "true", "1"].includes(String(env.AI_STREAM).toLowerCase());
  if (env.AI_MAX_STEPS) cfg.maxSteps = parseInt(env.AI_MAX_STEPS, 10) || 0;
  if (env.AI_CONTEXT) cfg.context = parseInt(env.AI_CONTEXT, 10) || 0;
  return cfg;
}

function normalizeBase(u) {
  u = String(u || "").trim().replace(/\/+$/, "");
  u = ALIASES[u.toLowerCase()] || u;
  if (u.endsWith("/chat/completions")) u = u.slice(0, -"/chat/completions".length);
  if (!/\/v\d+$/.test(u)) u += "/v1";
  return u;
}
const completionUrl = u => normalizeBase(u) + "/chat/completions";
const modelsUrl = u => normalizeBase(u) + "/models";

function applyProjectDir(cfg, strict = false) {
  if (!cfg.projectDir) return false;
  const dir = path.resolve(expandUser(cfg.projectDir));
  let ok = false;
  try { ok = fs.statSync(dir).isDirectory(); } catch {}
  if (!ok) {
    if (strict) throw new ApiError(`project folder not found: ${dir}`);
    console.log(yellow(`! project folder not found: ${dir} — using ${process.cwd()}`));
    cfg.projectDir = "";
    return false;
  }
  cfg.projectDir = dir;
  return true;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i], next = () => argv[++i];
    switch (x) {
      case "--url": a.url = next(); break;
      case "--model": a.model = next(); break;
      case "--key": a.key = next(); break;
      case "--dir": case "--cwd": case "-C": a.dir = next(); break;
      case "--system": a.system = next(); break;
      case "--context": a.context = parseInt(next(), 10); break;
      case "--maxout": a.maxout = parseInt(next(), 10); break;
      case "--max-tokens": a.maxTokens = parseInt(next(), 10); break;
      case "--max-steps": a.maxSteps = parseInt(next(), 10); break;
      case "--timeout": a.timeout = parseInt(next(), 10); break;
      case "--temperature": a.temperature = parseFloat(next()); break;
      case "--reasoning": a.reasoning = next(); break;
      case "--stream": a.stream = next(); break;
      case "--no-stream": a.stream = "off"; break;
      case "--no-tools": a.tools = false; break;
      case "--tools": a.tools = true; break;
      case "--list": a.list = true; break;
      case "--print-system": a.printSystem = true; break;
      case "-h": case "--help": a.help = true; break;
      default: if (!a.prompt && !x.startsWith("-")) a.prompt = x;
    }
  }
  return a;
}

const USAGE = `harness ${VERSION} — minimal coding harness (Node >= 18, zero deps)
usage: node harness.mjs [options] ["one-shot prompt"]
  --url <base|alias>   API base URL (aliases: ${Object.keys(ALIASES).join(" ")})
  --model <name>       model id              --key <sk-...>   API key
  --dir <path>         project folder all tools work in (default: cwd)
  --stream <on|off>    SSE streaming, or a single JSON reply (--no-stream)
  --max-steps <n>      tool-step cap (0 = unlimited, default)
  --context <n>        context window in tokens (enables trimming)
  --max-tokens <n>     reply length cap      --maxout <n>  tool output cap (chars)
  --timeout <sec>      per-command timeout (default 180)
  --temperature <n>    --reasoning <low|medium|high>
  --system <prompt>    replace the system prompt
  --no-tools           plain chat, no tools  --tools   force tools on
  --list               print the models the endpoint offers
  --print-system       print the system prompt and exit
  -h, --help
env: AI_URL AI_MODEL AI_KEY AI_DIR AI_STREAM AI_MAX_STEPS AI_CONTEXT NO_COLOR
tools: ${TOOLS.map(t => t.function.name).join(", ")}`;

const HELP = `commands
  /model [name]      show or switch model        /url <base|alias>  switch endpoint
  /dir <path>        change the project folder   /stream <on|off>   SSE vs single JSON
  /steps <n>         tool-step cap (0 = unlimited)
  /context <n>       context window in tokens (enables trimming)
  /clear             reset the conversation      /stats  tokens + context usage
  /tools             list the available tools    /config show settings
  /help              this text                   /exit   quit (ctrl+d also works)
notes
  ctrl+c cancels the running request (twice when idle = quit)
  config files: ~/.harness/config.json, else ~/.aiterm/config.json (read-only)
  env: AI_URL AI_MODEL AI_KEY AI_DIR AI_STREAM`;

// ------------------------------------------------------------------ http
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
// Context window: API metadata first, then a small table of well-known models.
const KNOWN_CTX = [
  [/gpt-4o|gpt-4\.1|gpt-3\.5/, 128000], [/\bo[134]\b|o[134]-mini/, 200000],
  [/claude-/, 200000], [/gemini-2/, 1048576], [/deepseek-r1/, 128000], [/deepseek/, 65536],
  [/llama3[.-]?1|llama3[.-]?3/, 131072], [/qwen/, 131072], [/mixtral/, 32768], [/mistral/, 128000],
];
async function detectContext(cfg) {
  if (cfg.context) return "configured";
  let models = [];
  try { models = await fetchModels(cfg); } catch {}
  const m = models.find(x => x.id === cfg.model);
  const v = m && ["context_length", "context_window", "max_context_length", "max_context"]
    .map(k => m[k]).find(x => Number.isInteger(x) && x > 0);
  if (v) { cfg.context = v; return "API metadata"; }
  for (const [re, n] of KNOWN_CTX) if (re.test(cfg.model || "")) { cfg.context = n; return "known model"; }
  return null;
}

// ------------------------------------------------------------------ tool-call accumulation
// Streamed tool calls arrive as fragments; some servers resend whole objects. Merge them
// back into {id, index, name, arguments} slots.
function mergeToolCallChunk(slots, tc) {
  const id = tc.id ? String(tc.id) : "";
  const idx = tc.index !== undefined && tc.index !== null && tc.index !== "" ? Number(tc.index) : null;
  const name = tc.function?.name ? String(tc.function.name) : "";
  let args = tc.function?.arguments;
  if (args && typeof args === "object") args = JSON.stringify(args);
  args = args ? String(args) : "";

  let slot = id ? slots.find(s => s.id === id) || null : null;
  if (!slot && idx !== null && Number.isFinite(idx)) {
    const cands = slots.filter(s => s.index === idx && (!id || !s.id || s.id === id));
    slot = cands[cands.length - 1] || null;
    // a fresh, complete object on the same index = a new call, not a continuation
    if (slot && args && /^\s*[{[]/.test(args) && tryParse(slot.arguments) !== undefined && args !== slot.arguments) slot = null;
  }
  if (!slot) { slot = { id, index: idx, name: "", arguments: "" }; slots.push(slot); }
  if (id && !slot.id) slot.id = id;
  if (slot.index === null && idx !== null) slot.index = idx;
  if (name) slot.name = slot.name.endsWith(name) ? slot.name : slot.name + name;
  if (args && !(slot.arguments === args && tryParse(args) !== undefined)) slot.arguments += args;
}

// Split a string into top-level balanced JSON objects/arrays (ignoring braces inside strings).
function splitJsonObjects(text) {
  const parts = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
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
      if (depth === 0 && start >= 0) { parts.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return parts.filter(p => tryParse(p) !== undefined);
}
// One slot carrying several concatenated calls (a common streaming bug) → several slots.
function repairToolCalls(slots) {
  const out = [];
  for (const s of slots) {
    if (tryParse(s.arguments) !== undefined || !String(s.arguments).trim()) { out.push(s); continue; }
    const valid = splitJsonObjects(s.arguments);
    if (valid.length >= 2) {
      const names = splitRepeatedName(s.name, valid.length);
      valid.forEach((p, i) => out.push({ id: i === 0 ? s.id : "", index: s.index,
                                         name: names[i] || names[0] || "", arguments: p }));
    } else out.push(s);
  }
  return out;
}
function splitRepeatedName(name, k) {
  if (!name || k <= 1) return [name];
  for (let L = 1; L <= Math.floor(name.length / 2); L++) {
    if (name.length % L === 0) {
      const p = name.slice(0, L);
      if (p.repeat(name.length / L) === name) return Array(name.length / L).fill(p);
    }
  }
  return [name];
}

// ------------------------------------------------------------------ model call
// Yields {type:"thinking"} / {type:"delta"} / {type:"end", result} in both stream modes.
async function* streamChat(cfg, messages, tools, signal) {
  const nonStream = cfg.stream === false;
  const payload = { model: cfg.model, messages, stream: !nonStream };
  if (tools?.length) payload.tools = tools;
  if (cfg.maxTokens) payload.max_tokens = cfg.maxTokens;
  if (!nonStream && !cfg._noStreamOpts) payload.stream_options = { include_usage: true };
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

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (nonStream && ct.includes("text/event-stream")) { yield* sseChatEvents(res); return; }
  yield* (nonStream ? jsonChatEvents(res) : sseChatEvents(res));
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
  // Server ignored `stream: true` and replied with one JSON body.
  if (!content && !thinking && !tcs.length && buf.trim().startsWith("{")) {
    const j = tryParse(buf);
    const m = j?.choices?.[0]?.message;
    if (m) {
      content = m.content || "";
      thinking = m.reasoning_content || m.reasoning || m.thinking || "";
      finish = j.choices?.[0]?.finish_reason || finish;
      if (j.usage) usage = j.usage;
      for (const tc of m.tool_calls || []) {
        const a = tc.function?.arguments;
        tcs.push({ id: tc.id || "", index: tc.index ?? null, name: tc.function?.name || "",
                   arguments: typeof a === "object" ? JSON.stringify(a) : (a || "") });
      }
      // surface it like a streamed reply, otherwise the text never reaches the terminal
      if (thinking) yield { type: "thinking", text: thinking };
      if (content) yield { type: "delta", text: content };
    }
  }
  yield { type: "end", result: { content, thinking, finish, usage, toolCalls: repairToolCalls(tcs) } };
}

async function* jsonChatEvents(res) {
  const j = tryParse(await res.text());
  if (!j) throw new ApiError("invalid JSON response body (non-stream mode)");
  if (j.error) throw new ApiError(typeof j.error === "string" ? j.error : (j.error.message || JSON.stringify(j.error)));
  const ch = j.choices?.[0] || {};
  const m = ch.message || ch.delta || {};
  const think = m.reasoning_content || m.reasoning || m.thinking || "";
  if (think) yield { type: "thinking", text: think };
  if (m.content) yield { type: "delta", text: m.content };
  const tcs = (m.tool_calls || []).map(tc => {
    const a = tc.function?.arguments;
    return { id: tc.id || "", index: tc.index ?? null, name: tc.function?.name || "",
             arguments: typeof a === "object" ? JSON.stringify(a) : (a || "") };
  });
  yield { type: "end", result: { content: m.content || "", thinking: think,
    finish: ch.finish_reason || null, usage: j.usage || null, toolCalls: repairToolCalls(tcs) } };
}

// ------------------------------------------------------------------ context management
const estTokens = h => Math.max(1, Math.floor(JSON.stringify(h).length / 4));
const fmtK = n => {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (Math.round(n / 100000) / 10) + "M";
  if (n >= 1000) return (Math.round(n / 100) / 10) + "k";
  return String(n);
};
function trimHistory(h, cfg) {
  const cap = Number(cfg.context) || 0;
  if (!cap) return;
  const budget = cap - 1024 - (Number(cfg.maxTokens) || 0);
  while (h.length > 2 && estTokens(h) > budget) {
    h.splice(1, 1);
    while (h.length > 1 && h[1].role === "tool") h.splice(1, 1);
  }
}
// Drop orphan tool messages / unparseable tool calls so the endpoint accepts the history.
function sanitizeHistory(h) {
  const openIds = new Set();
  for (let i = 1; i < h.length; i++) {
    const m = h[i];
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      m.tool_calls = m.tool_calls.filter(tc => tryParse(tc.function?.arguments || "{}") !== undefined);
      if (!m.tool_calls.length) { delete m.tool_calls; m.content = m.content || "(tool call omitted)"; openIds.clear(); }
      else m.tool_calls.forEach(tc => openIds.add(tc.id));
    } else if (m.role === "tool") {
      if (!openIds.has(m.tool_call_id)) h[i] = null; else openIds.delete(m.tool_call_id);
    } else openIds.clear();
  }
  for (let i = h.length - 1; i >= 0; i--) if (h[i] === null) h.splice(i, 1);
}
function showStats(cfg, history, usage) {
  const cap = Number(cfg.context) || 0;
  const used = usage ? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) : estTokens(history);
  let s = usage ? `tok ↑${fmtK(usage.prompt_tokens || 0)} ↓${fmtK(usage.completion_tokens || 0)}`
                : `~${fmtK(estTokens(history))} tok (est)`;
  s += cap ? ` · ctx ${fmtK(used)}/${fmtK(cap)}` : ` · ctx ${fmtK(used)} (limit unknown — /context <n>)`;
  console.log(dim("─ " + s + " ─"));
}

// ------------------------------------------------------------------ the agent loop
const MAX_FAIL_STREAK = 3;
const MAX_REPEAT = 3;

// Stable fingerprint of a tool call: canonical name + key-sorted arguments.
function callSignature(t) {
  const raw = String(t.arguments || "{}");
  const j = tryParse(raw);
  const norm = j && typeof j === "object" && !Array.isArray(j)
    ? JSON.stringify(j, Object.keys(j).sort())
    : raw;
  return `${canonicalTool(t.name)}(${norm})`;
}

async function agentTurn(cfg, history) {
  let tools = cfg.tools ? TOOLS : [];
  const limit = Number(cfg.maxSteps) || 0;
  const hasSystem = history[0]?.role === "system";
  const refreshSystem = () => { if (hasSystem) history[0].content = systemPrompt(cfg); };
  refreshSystem();

  let step = 0, failStreak = 0;
  const recentCalls = [];   // signatures of the last steps' tool calls, for the repeat guard

  for (;;) {
    step++;
    if (limit > 0 && step > limit) {
      history.push({ role: "assistant", content: "(stopped: max tool steps reached)" });
      console.log(red(`! hit max tool steps (${limit}) — raise with /steps <n>, or 0 for unlimited`));
      return;
    }

    refreshSystem();
    trimHistory(history, cfg);
    let shownThink = false, shownText = false, result = null;
    const ac = new AbortController();
    ACTIVE.ac = ac;
    // one status line until the model produces its first visible token
    const clearStatus = () => { if (!shownThink && !shownText) clearLine(); };

    try {
      let attempts = 0;
      for (;;) {
        attempts++;
        if (TTY) process.stdout.write(dim(step === 1 ? "· thinking…" : attempts > 1 ? "· retrying…" : "· continuing…") + "\r");
        try {
          for await (const ev of streamChat(cfg, history, tools, ac.signal)) {
            if (ev.type === "thinking") { clearStatus(); shownThink = true; process.stdout.write(dim(ev.text)); }
            else if (ev.type === "delta") {
              clearStatus();
              if (!shownText) { shownText = true; if (shownThink) process.stdout.write("\n"); }
              process.stdout.write(ev.text);
            } else {
              clearStatus();
              if (shownThink || shownText) process.stdout.write("\n");
              result = ev.result;
            }
          }
          break;
        } catch (e) {
          clearLine();
          if (e?.name === "AbortError") { console.log(dim("· interrupted")); return; }
          const msg = String(e?.message || e);
          const gotOutput = shownText;
          if (!gotOutput && attempts < 3) {
            if (/stream_options|include_usage/i.test(msg)) {
              cfg._noStreamOpts = true;
              console.log(yellow("! usage reporting unsupported — retrying without it"));
              continue;
            }
            if (RETRYABLE(msg)) {
              console.log(yellow(`! ${msg} — retry ${attempts}/2 in ${attempts}s…`));
              await sleep(1000 * attempts);
              continue;
            }
            if (/(context|token|length)/i.test(msg) && /(exceed|too (long|many|large)|maximum|limit|reduce|at most)/i.test(msg)) {
              const cur = Number(cfg.context) || estTokens(history);
              cfg.context = Math.max(2048, Math.floor(cur * 0.6));
              trimHistory(history, cfg);
              console.log(yellow(`! context overflow — trimmed history (context now ${cfg.context})`));
              continue;
            }
            if (/invalid tool call|tool call arguments|malformed tool/i.test(msg)) {
              sanitizeHistory(history);
              console.log(yellow("! repaired malformed tool-call history — retrying"));
              continue;
            }
            if (tools.length && step === 1 && /tool|function/i.test(msg)) {
              console.log(yellow("! tools rejected by endpoint — retrying as plain chat"));
              tools = []; cfg.tools = false;
              continue;
            }
          }
          throw e;
        }
      }
    } finally { ACTIVE.ac = null; clearLine(); }

    if (!result) throw new ApiError("empty response from model");
    if (result.finish === "length") console.log(yellow("! response truncated (token limit)"));

    const tcs = result.toolCalls || [];
    if (!tcs.length) {
      history.push({ role: "assistant", content: result.content || "" });
      if (result.usage) showStats(cfg, history, result.usage);
      return;
    }

    // repeat guard: the same batch of calls several steps in a row means no progress
    const sig = tcs.map(callSignature).join("|");
    recentCalls.push(sig);
    if (recentCalls.length > MAX_REPEAT * 2) recentCalls.splice(0, recentCalls.length - MAX_REPEAT * 2);
    if (recentCalls.slice(-MAX_REPEAT).every(s => s === sig) && recentCalls.length >= MAX_REPEAT) {
      history.push({ role: "assistant", content: result.content || "" });
      console.log(red(`! the same tool call repeated ${MAX_REPEAT}x — stopping to avoid a loop`));
      return;
    }

    const entries = tcs.map((t, i) => ({
      id: t.id || `call_${step}_${i}`,
      type: "function",
      function: { name: canonicalTool(t.name), arguments: t.arguments || "{}" },
    }));
    history.push({ role: "assistant", content: result.content || null, tool_calls: entries });

    for (const e of entries) {
      let args; try { args = JSON.parse(e.function.arguments); } catch { args = { _raw: e.function.arguments }; }
      if (!args || typeof args !== "object") args = { _raw: e.function.arguments };
      const name = e.function.name;
      console.log(yellow("⚙ ") + bold(name) + dim(" " + fmtCall(name, args)));

      const [ok, out] = await runTool(name, args, cfg);
      if (ac.signal.aborted) { console.log(dim("· interrupted")); return; }
      const text = String(out ?? "");
      const first = (text.trim().split("\n")[0] || "").slice(0, 140);
      console.log(`  ${ok ? green("✓") : red("✗")} ${dim(first)}${text.length > 140 ? dim(` …${text.length}ch`) : ""}`);
      failStreak = ok ? 0 : failStreak + 1;
      history.push({ role: "tool", tool_call_id: e.id, content: truncate(text, cfg.maxout) });

      if (failStreak >= MAX_FAIL_STREAK) {
        history.push({ role: "assistant", content:
          `I hit ${MAX_FAIL_STREAK} consecutive tool failures and stopped to avoid making things worse. ` +
          "Here is where I am stuck — tell me how you would like to proceed." });
        console.log(red(`! ${MAX_FAIL_STREAK} consecutive tool failures — stopping`));
        return;
      }
    }
  }
}

// ------------------------------------------------------------------ interrupt handling
let lastSigint = 0;
function onSigint(quit) {
  const busy = ACTIVE.ac || ACTIVE.child;
  if (busy) {
    try { ACTIVE.ac?.abort(); } catch {}
    try { ACTIVE.child?.kill(IS_WIN ? undefined : "SIGKILL"); } catch {}
    ACTIVE.child = null;
    lastSigint = Date.now();
    return;
  }
  if (Date.now() - lastSigint < 1500) { lastSigint = 0; quit?.(); return; }
  lastSigint = Date.now();
  process.stdout.write(dim("\n· ctrl+c again to quit\n"));
}

// ------------------------------------------------------------------ entry points
async function ask(rl, q) { return (await rl.question(q)).trim(); }

async function setup(cfg, rl) {
  console.log(bold("◆ harness first-run setup") + dim("  (or set AI_URL / AI_MODEL / AI_KEY)"));
  cfg.apiUrl = (await ask(rl, `API base URL or alias (${Object.keys(ALIASES).join(" ")}): `)) || "openai";
  cfg.model = await ask(rl, "Model (blank = pick the first one the endpoint lists): ");
  const key = await ask(rl, "API key (blank to skip): ");
  if (key) cfg.apiKey = key;
  const dir = await ask(rl, `Project folder (blank = ${displayPath(process.cwd())}): `);
  if (dir) { cfg.projectDir = dir; applyProjectDir(cfg, false); }
  try {
    const p = path.join(os.homedir(), ".harness", "config.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ apiUrl: cfg.apiUrl, model: cfg.model, apiKey: cfg.apiKey,
                                         projectDir: cfg.projectDir }, null, 2), { mode: 0o600 });
    console.log(dim("✓ saved to " + displayPath(p)));
  } catch (e) { console.log(yellow("! could not save config: " + e.message)); }
}

async function resolveCfg(cfg) {
  if (!cfg.model) {
    let ids = [];
    try { ids = (await fetchModels(cfg)).map(m => m.id).filter(Boolean).sort(); }
    catch (e) { throw new ApiError(`cannot list models and none configured: ${e.message}`); }
    if (!ids.length) throw new ApiError("endpoint lists no models — pass --model <name>");
    cfg.model = ids[0];
    console.log(dim(`model: auto-selected '${ids[0]}' of ${ids.length} — change with /model <name>`));
  }
  const src = await detectContext(cfg);
  if (src) console.log(dim(`context: ${fmtK(cfg.context)} tokens (${src})`));
}

function banner(cfg) {
  const dir = displayPath(cfg.projectDir || process.cwd());
  console.log(bold("◆ harness") + dim(` ${VERSION}  ·  ${cfg.model} @ ${normalizeBase(cfg.apiUrl)}  ·  ${osDescription()}  ·  ctx ${cfg.context ? fmtK(cfg.context) : "unknown"}  ·  key ${cfg.apiKey ? "✓" : "—"}` +
    (cfg.stream === false ? "  ·  stream off" : "") + (cfg.tools ? "" : "  ·  tools off")));
  console.log(dim(`  📁 ${dir}   ·   ${TOOLS.map(t => t.function.name).join(" ")}`));
  console.log(dim("  /help for commands · ctrl+c cancels · ctrl+d exits"));
}

async function oneShot(cfg, prompt) {
  const history = [{ role: "system", content: systemPrompt(cfg) }, { role: "user", content: prompt }];
  await agentTurn(cfg, history);
}

async function repl(cfg) {
  banner(cfg);
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout, terminal: true, history: [],
  });
  rl.on("SIGINT", () => onSigint(() => { rl.close(); process.exit(0); }));
  const history = [{ role: "system", content: systemPrompt(cfg) }];

  for (;;) {
    let line;
    try { line = await rl.question(PROMPT); }
    catch { break; }                     // ctrl+d / closed stdin
    const t = String(line ?? "").trim();
    if (!t) continue;

    if (t.startsWith("/")) {
      const [cmd, ...rest] = t.split(/\s+/);
      const val = rest.join(" ").trim();
      const keepGoing = await handleCommand(cmd, val, cfg, history);
      if (!keepGoing) break;
      continue;
    }

    const snap = history.length;
    history.push({ role: "user", content: t });
    try { await agentTurn(cfg, history); }
    catch (e) {
      history.length = snap;
      console.error(red("✗ " + (e.message || e)));
      if (/context|token/i.test(String(e.message))) console.log(dim("  hint: /context <n> to enable trimming"));
    }
  }
  rl.close();
  console.log(dim("bye"));
}

async function handleCommand(cmd, val, cfg, history) {
  switch (cmd) {
    case "/exit": case "/quit": case "/q":
      return false;
    case "/help": case "/?":
      console.log(HELP.trim());
      console.log(dim("  project folder: " + displayPath(cfg.projectDir || process.cwd())));
      break;
    case "/clear": case "/reset":
      history.length = 1;
      history[0].content = systemPrompt(cfg);
      console.log(dim("history cleared"));
      break;
    case "/model":
      if (!val) console.log(dim("model: " + (cfg.model || "(none)")));
      else { cfg.model = val; console.log(dim("✓ model: " + val)); }
      break;
    case "/url":
      if (!val) console.log(dim("url: " + normalizeBase(cfg.apiUrl)));
      else { cfg.apiUrl = val; console.log(dim("✓ url: " + normalizeBase(cfg.apiUrl))); }
      break;
    case "/dir": case "/cd": {
      if (!val) { console.log(dim("dir: " + displayPath(cfg.projectDir || process.cwd()))); break; }
      const old = cfg.projectDir;
      cfg.projectDir = val;
      try { applyProjectDir(cfg, true); }
      catch (e) { cfg.projectDir = old; console.log(red(e.message)); break; }
      history[0].content = systemPrompt(cfg);
      console.log(dim("✓ project folder: " + displayPath(cfg.projectDir)));
      break;
    }
    case "/stream":
      cfg.stream = !["off", "false", "0"].includes(val.toLowerCase());
      console.log(dim("✓ stream " + (cfg.stream ? "on (SSE)" : "off (single JSON reply)")));
      break;
    case "/steps": {
      const n = parseInt(val, 10);
      cfg.maxSteps = Number.isFinite(n) && n >= 0 ? n : 0;
      console.log(dim("✓ max steps: " + (cfg.maxSteps || "unlimited")));
      break;
    }
    case "/context": {
      const n = parseInt(val, 10);
      cfg.context = Number.isFinite(n) && n > 0 ? n : 0;
      console.log(dim(cfg.context ? `✓ context: ${fmtK(cfg.context)} (trimming on)` : "✓ context: unknown (trimming off)"));
      break;
    }
    case "/tools":
      for (const t of TOOLS) console.log("  " + cyan(t.function.name.padEnd(12)) + dim(t.function.description.split(". ")[0]));
      break;
    case "/stats":
      showStats(cfg, history, null);
      break;
    case "/config": {
      const show = { ...cfg };
      show.apiKey = show.apiKey ? "•".repeat(Math.min(12, show.apiKey.length)) : "";
      delete show._source; delete show._noStreamOpts;
      console.log(dim(JSON.stringify(show, null, 2)));
      break;
    }
    default:
      console.log(dim("unknown command — /help"));
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }

  const cfg = loadCfg();
  if (args.url) cfg.apiUrl = args.url;
  if (args.model) cfg.model = args.model;
  if (args.key) cfg.apiKey = args.key;
  if (args.dir) cfg.projectDir = args.dir;
  if (args.system) cfg.system = args.system;
  if (args.context) cfg.context = args.context;
  if (args.maxout) cfg.maxout = args.maxout;
  if (args.maxTokens) cfg.maxTokens = args.maxTokens;
  if (args.maxSteps !== undefined) cfg.maxSteps = args.maxSteps;
  if (args.timeout) cfg.timeout = args.timeout;
  if (typeof args.temperature === "number" && !isNaN(args.temperature)) cfg.temperature = args.temperature;
  if (args.reasoning) cfg.reasoning = args.reasoning;
  if (args.stream !== undefined) cfg.stream = !["off", "false", "0"].includes(String(args.stream).toLowerCase());
  if (args.tools === true) cfg.tools = true;
  if (args.tools === false) cfg.tools = false;

  applyProjectDir(cfg, false);
  if (args.printSystem) { console.log(systemPrompt(cfg)); return; }

  process.on("SIGINT", () => onSigint(() => process.exit(130)));

  if (args.list) {
    for (const m of await fetchModels(cfg)) console.log(m.id || "?");
    return;
  }

  // piped one-shot: read the prompt from stdin
  if (!process.stdin.isTTY) {
    let text = "";
    for await (const c of process.stdin) text += c;
    text = text.trim();
    if (!text) return;
    if (!cfg.apiUrl || !cfg.model) { console.error("missing --url/--model (set AI_URL/AI_MODEL, or run interactively once)"); process.exit(1); }
    if (!cfg.context) await detectContext(cfg);
    try { await oneShot(cfg, text); }
    catch (e) { console.error(red("✗ " + (e.message || e))); process.exit(1); }
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!cfg.apiUrl) await setup(cfg, rl);
    if (!cfg.apiUrl || !cfg.model) { await resolveCfg(cfg); }
    else if (!cfg.context) await detectContext(cfg);
  } finally { rl.close(); }

  if (args.prompt) {
    try { await oneShot(cfg, args.prompt); }
    catch (e) { console.error(red("✗ " + (e.message || e))); process.exit(1); }
    return;
  }

  await repl(cfg);
}

main().catch(e => { console.error(red("✗ " + (e?.message || e))); process.exit(1); });
