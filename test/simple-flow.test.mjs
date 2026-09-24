// Tests for the simple one-request → one-turn flow (v2.13.0).
// The goal/tasks/update_plan planning layer was removed: the agent must offer no plan
// tool, never inject a synthetic "NOT DONE YET" user message, and end the turn as soon
// as the model replies without tool calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLLM } from "./mock-llm.mjs";

const hasScript = spawnSync("script", ["--version"]).status === 0;
const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent.mjs");

function runAgent({ url, prompt, dir, home, extraArgs = [] }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      AGENT,
      "--url", url,
      "--model", "mock-model",
      "--key", "test-key",
      "--dir", dir,
      "--context", "8000",
      ...extraArgs,
    ], { env: { ...process.env, HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", c => (out += c));
    child.stderr.on("data", c => (out += c));
    child.on("close", code => resolve({ code, out }));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
  return { root, home: path.join(root, "home"), dir: path.join(root, "proj") };
}

test("a multi-step request ends at the first final reply — no follow-up gate", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");

  const mock = await startMockLLM([
    { toolCalls: [{ name: "read_file", arguments: { path: "a.js" } }] },
    { content: "Done: a.js exports a constant." },
  ]);

  try {
    const { out } = await runAgent({ url: mock.url, home, dir,
                                     prompt: "Refactor the project step by step and verify it." });
    assert.match(out, /Done: a\.js exports a constant\./);
    // exactly two model round trips: the tool call, then the final answer
    assert.equal(mock.used(), 2, "turn ends on the first non-tool reply");
    // no planning vocabulary anywhere in the transcript or the outgoing payloads
    assert.doesNotMatch(out, /update_plan|GOAL:|goal:|following up|plan incomplete/i);
    for (const req of mock.requests) {
      const names = (req.tools || []).map(t => t.function.name);
      assert.ok(!names.includes("update_plan"), "update_plan is not advertised");
      assert.ok(!req.messages.some(m => m.role === "user" && /NOT DONE YET/i.test(String(m.content))),
                "no synthetic nudge user messages");
    }
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the advertised toolset is exactly the simple-flow tools", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([{ content: "ok" }]);
  try {
    await runAgent({ url: mock.url, home, dir, prompt: "hello there" });
    const names = mock.requests[0].tools.map(t => t.function.name).sort();
    assert.deepEqual(names, ["forget", "read_file", "remember", "shell", "str_replace", "write_file"]);
    // stable system prompt: nothing about plans/tasks is injected
    assert.doesNotMatch(mock.requests[0].messages[0].content, /update_plan|task list|YOUR CURRENT PLAN/i);
    assert.equal(mock.used(), 1, "plain chat answers take a single round trip");
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The REPL (slash commands) only exists on a TTY, so drive it through a pty.
async function runRepl({ url, dir, home, lines, waitMs = 1200 }) {
  const { spawn } = await import("node:child_process");
  const cmd = `node ${AGENT} --url ${url} --model mock-model --key k --dir ${dir} --context 8000`;
  const child = spawn("script", ["-qec", cmd, "/dev/null"],
    { env: { ...process.env, HOME: home, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", c => (out += c));
  child.stderr.on("data", c => (out += c));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(1500);
  for (const l of lines) { child.stdin.write(l + "\r"); await sleep(waitMs); }
  child.stdin.write("/exit\r");
  await sleep(1000);
  try { child.kill("SIGKILL"); } catch {}
  return out.replace(/\r/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

test({ name: "removed plan commands report as unknown instead of crashing",
       skip: !hasScript && "needs `script` for a pty" }, async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([{ content: "ok" }]);
  try {
    const plain = await runRepl({ url: mock.url, home, dir,
                                  lines: ["/plan", "/plan clear", "/set autoplan off", "/mode plan"] });
    // the planning commands are gone
    assert.match(plain, /unknown command '\/plan'/);
    assert.match(plain, /unknown command '\/plan clear'/);
    // /set autoplan now falls through to the generic /set usage line (no autoplan key)
    assert.match(plain, /usage: \/set/);
    assert.doesNotMatch(plain, /autoplan updated|auto-planning/i);
    // and "plan" is no longer a valid mode
    assert.match(plain, /usage: \/mode <code\|ask>/);
  } finally {
    try { mock.close && await mock.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("--autoplan flags are gone; --mode only accepts ask|code", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([{ content: "fine" }]);
  try {
    // unknown flags fall through to being treated as the prompt — so just check USAGE
    const help = await new Promise((resolve) => {
      const child = spawn(process.execPath, [AGENT, "--help"],
                          { env: { ...process.env, HOME: home, NO_COLOR: "1" } });
      let out = "";
      child.stdout.on("data", c => (out += c));
      child.stderr.on("data", c => (out += c));
      child.on("close", () => resolve(out));
    });
    assert.doesNotMatch(help, /autoplan/);
    assert.match(help, /--mode <ask\|code>/);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
