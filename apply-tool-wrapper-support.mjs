#!/usr/bin/env node
/**
 * apply-agent-modes.mjs
 *
 * Patches agent.mjs to add:
 *   - modes: ask / plan / code
 *   - /mode command
 *   - /set mode support
 *   - --mode CLI flag
 *   - /redact command in /help and as a command
 *   - mode shown in /config and banner
 *
 * Usage:
 *   node apply-agent-modes.mjs agent.mjs
 */

import fs from "node:fs";

const target = process.argv[2] || "agent.mjs";

if (!fs.existsSync(target)) {
  console.error("File not found: " + target);
  process.exit(1);
}

let src = fs.readFileSync(target, "utf8");
let changed = false;
const problems = [];

function ok(label) {
  changed = true;
  console.log("✓ " + label);
}

function skip(label) {
  console.log("· already patched: " + label);
}

function fail(label, detail) {
  const msg = label + (detail ? " — " + detail : "");
  problems.push(msg);
  console.error("✗ " + msg);
}

function indentOf(line) {
  const m = String(line).match(/^[\t ]*/);
  return m ? m[0] : "";
}

function replaceExact(search, replacement, label, marker) {
  if (marker && src.includes(marker)) return skip(label);

  const idx = src.indexOf(search);
  if (idx === -1) return fail(label, "search text not found");

  src = src.slice(0, idx) + replacement + src.slice(idx + search.length);
  ok(label);
}

function insertAfterLine(anchor, block, label, marker) {
  if (marker && src.includes(marker)) return skip(label);

  const lines = src.split("\n");
  const idx = lines.findIndex(l => l.includes(anchor));

  if (idx === -1) return fail(label, "anchor line not found: " + anchor);

  const indent = indentOf(lines[idx]);
  const insert = String(block)
    .split("\n")
    .map(l => (l.length ? indent + l : l));

  lines.splice(idx + 1, 0, ...insert);
  src = lines.join("\n");
  ok(label);
}

function insertBeforeLine(anchor, block, label, marker) {
  if (marker && src.includes(marker)) return skip(label);

  const lines = src.split("\n");
  const idx = lines.findIndex(l => l.includes(anchor));

  if (idx === -1) return fail(label, "anchor line not found: " + anchor);

  const indent = indentOf(lines[idx]);
  const insert = String(block)
    .split("\n")
    .map(l => (l.length ? indent + l : l));

  lines.splice(idx, 0, ...insert);
  src = lines.join("\n");
  ok(label);
}

function replaceLineContaining(anchor, block, label, marker) {
  if (marker && src.includes(marker)) return skip(label);

  const lines = src.split("\n");
  const idx = lines.findIndex(l => l.includes(anchor));

  if (idx === -1) return fail(label, "anchor line not found: " + anchor);

  const indent = indentOf(lines[idx]);
  const insert = String(block)
    .split("\n")
    .map(l => (l.length ? indent + l : l));

  lines.splice(idx, 1, ...insert);
  src = lines.join("\n");
  ok(label);
}

const SYSTEM_MODE_BLOCK = `let s = "";
if (cfg.mode === "ask") {
  s = "You are an expert AI assistant. The user is in ASK mode. Answer questions directly and conversationally. Do NOT use any tools, do NOT read or write files, and do NOT execute commands. Just provide helpful text responses.";
} else if (cfg.mode === "plan") {
  s = "You are an expert autonomous software-engineering agent. The user is in PLAN mode. Your goal is to analyze the project and create a detailed, step-by-step plan to solve the user's task. You may use read-only tools (like read_file and shell for searching) to gather context, but DO NOT write, edit, or execute any mutating commands. Output a clear, actionable plan.";
} else {
  s = cfg.system || SYS_PROMPT;
}`;

const TOOL_MODE_BLOCK = `if (cfg.mode === "ask") tools = [];
else if (cfg.mode === "plan") tools = tools.filter(t => ["read_file", "shell"].includes(t.function.name));`;

const HELP_MODE_BLOCK = `/mode <ask|plan|code>   agent mode (ask=chat, plan=read-only plan, code=full auto)
/redact <on|off>        toggle silent secret redaction (default: on)`;

const USAGE_MODE_LINE = `--mode <ask|plan|code> agent mode (default: code)`;

const SET_MODE_BLOCK = `else if (k === "mode") {
const m = (v || "").toLowerCase();
if (["code", "ask", "plan"].includes(m)) {
  cfg.mode = m;
  if (history.length) history[0].content = systemPrompt(cfg);
} else {
  console.log(dim("usage: /set mode <code|ask|plan>"));
  return true;
}
}`;

const COMMAND_MODE_REDACT_BLOCK = `case "/mode": {
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
}`;

const MODE_STR_LINE = `const modeStr = cfg.mode && cfg.mode !== "code" ? "  ·  mode " + cfg.mode : "";`;

// ------------------------------------------------------------------ apply

// 1. Add mode to config defaults.
replaceExact(
  'reasoning: "", redact: true };',
  'reasoning: "", redact: true, mode: "code" };',
  "add mode to config defaults",
  'reasoning: "", redact: true, mode: "code" };'
);

// 2. Replace system prompt base logic with mode-aware logic.
replaceLineContaining(
  "let s = cfg.system || SYS_PROMPT;",
  SYSTEM_MODE_BLOCK,
  "add ask/plan/code system prompt logic",
  'if (cfg.mode === "ask") {'
);

// 3. Filter tools by mode.
insertAfterLine(
  "let tools = cfg.tools ? allTools() : [];",
  TOOL_MODE_BLOCK,
  "add mode-based tool filtering",
  'if (cfg.mode === "ask") tools = [];'
);

// 4. Add /mode and /redact to /help.
insertAfterLine(
  "/set system <prompt>    replace system prompt",
  HELP_MODE_BLOCK,
  "add /mode and /redact to /help",
  "/mode <ask|plan|code>"
);

// 5. Add --mode to usage text.
insertAfterLine(
  "--reasoning <lvl>     reasoning effort (low|medium|high)",
  USAGE_MODE_LINE,
  "add --mode to usage",
  "--mode <ask|plan|code>"
);

// 6. Add --mode CLI parsing.
insertAfterLine(
  'case "--reasoning": a.reasoning = next(); break;',
  'case "--mode": a.mode = next(); break;',
  "add --mode argument parsing",
  'case "--mode": a.mode = next(); break;'
);

// 7. Apply --mode in main().
insertAfterLine(
  "if (args.reasoning) cfg.reasoning = args.reasoning;",
  "if (args.mode) cfg.mode = args.mode;",
  "apply --mode from CLI",
  "if (args.mode) cfg.mode = args.mode;"
);

// 8. Add /set mode support.
insertBeforeLine(
  'else if (k === "redact") cfg.redact = ["on","true","1"].includes(v);',
  SET_MODE_BLOCK,
  "add /set mode handler",
  'else if (k === "mode")'
);

// 9. Update /set usage text.
replaceExact(
  "reasoning|redact|dir",
  "reasoning|mode|redact|dir",
  "add mode to /set usage text",
  "reasoning|mode|redact|dir"
);

// 10. Add /mode and /redact command handlers.
insertBeforeLine(
  'case "/config": {',
  COMMAND_MODE_REDACT_BLOCK,
  "add /mode and /redact command handlers",
  'case "/mode":'
);

// 11. Add mode to /config output.
function addModeToConfigOutput() {
  const label = "add mode to /config output";
  const marker = "mode     ${cfg.mode";

  if (src.includes(marker)) return skip(label);

  const anchor = "reasoning ${cfg.reasoning || \"default\"}` +";
  const lines = src.split("\n");
  const idx = lines.findIndex(l => l.includes(anchor));

  if (idx === -1) return fail(label, "anchor line not found");

  const indent = indentOf(lines[idx]);
  const replacement =
    "reasoning ${cfg.reasoning || \"default\"}\n" +
    indent +
    "mode     ${cfg.mode || \"code\"}` +";

  lines[idx] = lines[idx].replace(anchor, () => replacement);
  src = lines.join("\n");
  ok(label);
}

addModeToConfigOutput();

// 12. Show mode in banner.
insertBeforeLine(
  'console.log(bold("◆ ai-agent")',
  MODE_STR_LINE,
  "add mode string to banner",
  'const modeStr = cfg.mode && cfg.mode !== "code"'
);

replaceExact(
  '+ (cfg.intercept ? "  ·  🔒 intercept" : "")));',
  '+ (cfg.intercept ? "  ·  🔒 intercept" : "") + modeStr));',
  "show mode in banner",
  "+ modeStr));"
);

// ------------------------------------------------------------------ verify

const postCheck = [
  'mode: "code"',
  'if (cfg.mode === "ask")',
  'if (cfg.mode === "ask") tools = [];',
  "/mode <ask|plan|code>",
  "/redact <on|off>",
  "--mode <ask|plan|code>",
  'case "--mode": a.mode = next(); break;',
  "if (args.mode) cfg.mode = args.mode;",
  'else if (k === "mode")',
  'case "/mode":',
  'case "/redact":',
  "mode     ${cfg.mode",
  'const modeStr = cfg.mode && cfg.mode !== "code"',
  "+ modeStr));"
];

for (const marker of postCheck) {
  if (!src.includes(marker)) {
    problems.push("post-check missing marker: " + marker);
  }
}

if (problems.length) {
  console.error("\nPatch aborted. No file was written.");
  process.exit(1);
}

if (!changed) {
  console.log("\nNo changes needed.");
  process.exit(0);
}

const backup = target + ".bak";
if (!fs.existsSync(backup)) {
  fs.copyFileSync(target, backup);
}

fs.writeFileSync(target, src);

console.log("\nUpdated " + target);
console.log("Backup: " + backup);