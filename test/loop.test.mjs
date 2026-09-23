// End-to-end tests for loop detection and the completion gate, run against the REAL agent.mjs
// with a scripted mock LLM. The mock repeats its last scripted turn forever, so any scenario
// that ends in a repeated turn is a genuine infinite loop unless the agent stops it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLLM } from "./mock-llm.mjs";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent.mjs");

function runAgent({ url, prompt, dir, home, extraArgs = [] }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      AGENT, "--url", url, "--model", "mock-model", "--key", "test-key", "--dir", dir, "--context", "8000", ...extraArgs,
    ], { env: { ...process.env, HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", c => (out += c));
    child.stderr.on("data", c => (out += c));
    const killer = setTimeout(() => { out += "\n[TEST: agent killed after 25s — it did not stop on its own]"; child.kill("SIGKILL"); }, 25000);
    child.on("close", code => { clearTimeout(killer); resolve({ code, out }); });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-test-"));
  const home = path.join(root, "home"), dir = path.join(root, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  return { root, home, dir };
}
const READ = { name: "read_file", arguments: { path: "a.txt" } };

test("the same preamble before different tool calls is not a loop", async () => {
  const { root, home, dir } = scratch();
  for (const f of ["b", "c", "d", "e"]) fs.writeFileSync(path.join(dir, f + ".txt"), f);
  const mock = await startMockLLM([
    ...["a", "b", "c", "d", "e"].map(f => ({ content: "Let me check.", toolCalls: [{ name: "read_file", arguments: { path: f + ".txt" } }] })),
    { content: "All five files read." },
  ]);
  try {
    const { code, out } = await runAgent({ url: mock.url, home, dir, prompt: "read all the txt files" });
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /repetition loop/);
    assert.match(out, /All five files read\./);
    assert.equal(mock.used(), 6);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("edit → verify → edit → verify is not a loop, even with 4 identical verify commands", async () => {
  const { root, home, dir } = scratch();
  fs.writeFileSync(path.join(dir, "x.txt"), "v0\n");
  const V = { name: "shell", arguments: { command: "cat x.txt" } };
  const edit = n => ({ toolCalls: [{ name: "str_replace", arguments: { path: "x.txt", old_str: "v" + n, new_str: "v" + (n + 1) } }] });
  const mock = await startMockLLM([
    { toolCalls: [V] }, edit(0), { toolCalls: [V] }, edit(1), { toolCalls: [V] }, edit(2), { toolCalls: [V] },
    { content: "Iterated to v3." },
  ]);
  try {
    const { code, out } = await runAgent({ url: mock.url, home, dir, prompt: "iterate x.txt to v3" });
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /repetition loop/);
    assert.match(out, /Iterated to v3\./);
    assert.equal(fs.readFileSync(path.join(dir, "x.txt"), "utf8"), "v3\n");
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("working through a checklist with many update_plan status flips is not a loop", async () => {
  const { root, home, dir } = scratch();
  const tasks = ["t1", "t2", "t3", "t4"].map((id, i) => ({ id, content: "write f" + i + ".txt", status: "pending", verify: "cat f" + i + ".txt" }));
  const turns = [{ toolCalls: [{ name: "update_plan", arguments: { goal: "write four files", tasks } }] }];
  tasks.forEach((t, i) => {
    turns.push({ toolCalls: [{ name: "update_plan", arguments: { updates: [{ id: t.id, status: "in_progress" }] } }] });
    turns.push({ toolCalls: [{ name: "write_file", arguments: { path: `f${i}.txt`, content: `file ${i}\n` } }] });
    turns.push({ toolCalls: [{ name: "shell", arguments: { command: `cat f${i}.txt` } }] });
    turns.push({ toolCalls: [{ name: "update_plan", arguments: { updates: [{ id: t.id, status: "done" }] } }] });
  });
  turns.push({ content: "Wrote and verified all four files." });
  const mock = await startMockLLM(turns);
  try {
    const { code, out } = await runAgent({ url: mock.url, home, dir, prompt: "write four files" });
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /repetition loop/);
    assert.match(out, /plan 4\/4 done/);
    assert.equal(mock.used(), turns.length);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a model that re-reads the same file forever is stopped within a few round trips", async () => {
  const { root, home, dir } = scratch();
  const mock = await startMockLLM([{ content: "Reading the file.", toolCalls: [READ] }]);
  try {
    const { code, out } = await runAgent({ url: mock.url, home, dir, prompt: "what is in a.txt?" });
    assert.equal(code, 0, out);
    assert.match(out, /repetition loop detected in tool calls \(same call \+ same result 3x in a row\)/);
    assert.ok(mock.used() <= 4, `stopped after ${mock.used()} requests`);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("an A-B-A-B tool cycle with unchanging results is stopped", async () => {
  const { root, home, dir } = scratch();
  const mock = await startMockLLM([
    { toolCalls: [READ] }, { toolCalls: [{ name: "shell", arguments: { command: "cat a.txt" } }] },
    { toolCalls: [READ] }, { toolCalls: [{ name: "shell", arguments: { command: "cat a.txt" } }] },
    { toolCalls: [READ] }, { toolCalls: [{ name: "shell", arguments: { command: "cat a.txt" } }] },
    { toolCalls: [READ] }, { toolCalls: [{ name: "shell", arguments: { command: "cat a.txt" } }] },
    { toolCalls: [READ] }, { toolCalls: [{ name: "shell", arguments: { command: "cat a.txt" } }] },
  ]);
  try {
    const { out } = await runAgent({ url: mock.url, home, dir, prompt: "go" });
    assert.match(out, /repetition loop detected in tool calls \(cycle of 2 calls repeated 3x/);
    assert.ok(mock.used() <= 7);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("the completion gate gives up after MAX nudges when the model makes no progress (no infinite nudge loop)", async () => {
  const { root, home, dir } = scratch();
  const turns = [{ toolCalls: [{ name: "update_plan", arguments: { goal: "G", tasks: [{ id: "t1", content: "impossible", status: "pending", verify: "x" }] } }] }];
  // every nudge is answered with a cosmetic status flip and another "Done." — forever
  for (let i = 0; i < 20; i++) {
    turns.push({ content: "Done." });
    turns.push({ toolCalls: [{ name: "update_plan", arguments: { updates: [{ id: "t1", status: "in_progress", note: "attempt " + i }] } }] });
  }
  const mock = await startMockLLM(turns);
  try {
    const { code, out } = await runAgent({ url: mock.url, home, dir, prompt: "do the impossible" });
    assert.equal(code, 0, out);
    assert.match(out, /following up \(1\/2\)/);
    assert.match(out, /following up \(2\/2\)/);
    assert.doesNotMatch(out, /following up \(3\//);
    assert.doesNotMatch(out, /repetition loop/, "ends via the gate, not via the loop detector");
    assert.ok(mock.used() <= 7, `served ${mock.used()}`);
    assert.match(out, /1 open · 2 follow-ups needed/);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("plan mode records the plan and stops — open tasks are not nudged", async () => {
  const { root, home, dir } = scratch();
  const mock = await startMockLLM([
    { toolCalls: [{ name: "update_plan", arguments: { goal: "Refactor", tasks: [
      { id: "t1", content: "split module", status: "pending", verify: "npm test" },
      { id: "t2", content: "update docs", status: "pending", verify: "docs build" },
    ] } }] },
    { content: "Here is the plan." },
  ]);
  try {
    const { code, out } = await runAgent({ url: mock.url, home, dir, prompt: "refactor the module", extraArgs: ["--mode", "plan"] });
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /following up/);
    assert.match(out, /Here is the plan\./);
    assert.equal(mock.used(), 2);
    // plan mode only offers read-only tools
    const names = mock.requests[0].tools.map(t => t.function.name).sort();
    assert.deepEqual(names, ["read_file", "shell", "update_plan"]);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a plain-JSON tool call in the text reply (server without native tools) is executed", async () => {
  const { root, home, dir } = scratch();
  const mock = await startMockLLM([
    { content: '{"name": "read_file", "arguments": {"path": "a.txt"}}' },
    { content: "a.txt says hello." },
  ]);
  try {
    const { code, out } = await runAgent({ url: mock.url, home, dir, prompt: "what is in a.txt?" });
    assert.equal(code, 0, out);
    assert.match(out, /⚙ read_file read a\.txt/);
    assert.match(out, /a\.txt says hello\./);
    const toolMsg = mock.requests[1].messages.find(m => m.role === "tool");
    assert.match(String(toolMsg?.content), /hello/);
  } finally { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a JSON reply to a stream request (pretty-printed) is parsed instead of being dropped", async () => {
  const { root, home, dir } = scratch();
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "mock-model" }] })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "json body answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }, null, 2));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const { code, out } = await runAgent({ url: `http://127.0.0.1:${server.address().port}/v1`, home, dir, prompt: "hi" });
    assert.equal(code, 0, out);
    assert.match(out, /json body answer/);
  } finally { await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); }
});

test("an endpoint that rejects tools falls back to plain chat without persisting tools=off", async () => {
  const { root, home, dir } = scratch();
  const http = await import("node:http");
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "mock-model" }] })); return; }
      const p = JSON.parse(body); n++;
      if (p.tools) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "This model does not support tools/function calling" } })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "plain chat works" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const { code, out } = await runAgent({ url: `http://127.0.0.1:${server.address().port}/v1`, home, dir, prompt: "hi" });
    assert.equal(code, 0, out);
    assert.match(out, /tools rejected by endpoint/);
    assert.match(out, /plain chat works/);
    assert.equal(n, 2);
    const cfgFile = path.join(home, ".aiterm", "config.json");
    if (fs.existsSync(cfgFile)) {
      const saved = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
      assert.notEqual(saved.tools, false, "tools stay enabled in the saved config");
      assert.ok(!("_toolsUnsupported" in saved));
    }
  } finally { await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); }
});
