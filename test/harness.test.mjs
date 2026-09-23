// End-to-end tests for harness.mjs — the minimal coding harness.
// Runs the REAL harness as a subprocess against the scripted mock LLM (test/mock-llm.mjs),
// so the whole loop is covered: streamChat, tool-call accumulation, tool execution,
// history repair, and the non-streaming JSON mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLLM } from "./mock-llm.mjs";

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness.mjs");

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const home = path.join(root, "home");
  const dir = path.join(root, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  return { root, home, dir };
}

// The harness's non-TTY entry point reads the prompt from stdin (piped one-shot mode).
function runHarness({ url, prompt, dir, home, extraArgs = [], env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      HARNESS,
      "--url", url,
      "--model", "mock-model",
      "--key", "test-key",
      "--dir", dir,
      ...extraArgs,
    ], {
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", c => (out += c));
    child.stderr.on("data", c => (out += c));
    child.on("close", code => resolve({ code, out }));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

test("--help and --print-system work without any endpoint", async () => {
  const { home, dir } = scratch();
  const help = await new Promise(resolve => {
    const c = spawn(process.execPath, [HARNESS, "--help"], { env: { ...process.env, HOME: home, NO_COLOR: "1" } });
    let out = ""; c.stdout.on("data", d => (out += d)); c.on("close", code => resolve({ code, out }));
  });
  assert.equal(help.code, 0);
  for (const tool of ["shell", "read_file", "write_file", "str_replace", "list_files"]) {
    assert.match(help.out, new RegExp(tool), "usage should advertise " + tool);
  }

  const sys = await new Promise(resolve => {
    const c = spawn(process.execPath, [HARNESS, "--print-system", "--dir", dir],
      { env: { ...process.env, HOME: home, NO_COLOR: "1" } });
    let out = ""; c.stdout.on("data", d => (out += d)); c.on("close", code => resolve({ code, out }));
  });
  assert.equal(sys.code, 0);
  assert.match(sys.out, /coding agent/i);
  assert.match(sys.out, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "system prompt names the project dir");
});

test("write_file creates the file, then the harness reports back", async () => {
  const { home, dir } = scratch();
  const mock = await startMockLLM([
    { toolCalls: [{ name: "write_file", arguments: { path: "src/hello.txt", content: "hi from the harness\n" } }] },
    { content: "Created src/hello.txt." },
  ]);
  try {
    const { code, out } = await runHarness({ url: mock.url, prompt: "create a hello file", dir, home });
    assert.equal(code, 0, out);
    assert.equal(fs.readFileSync(path.join(dir, "src", "hello.txt"), "utf8"), "hi from the harness\n");
    assert.match(out, /write_file/);
    assert.match(out, /wrote 20 chars/);
    assert.match(out, /Created src\/hello\.txt\./);
    // the coding tools are advertised as native function calls
    const names = (mock.requests[0].tools || []).map(t => t.function.name);
    assert.deepEqual(names, ["shell", "read_file", "str_replace", "write_file", "list_files"]);
    assert.equal(mock.requests[0].stream, true);
  } finally { await mock.close(); }
});

test("str_replace makes a unique, exact edit", async () => {
  const { home, dir } = scratch();
  fs.writeFileSync(path.join(dir, "app.js"), "const a = 1;\nconst b = 2;\n");
  const mock = await startMockLLM([
    { toolCalls: [{ name: "str_replace", arguments: { path: "app.js", old_str: "const b = 2;", new_str: "const b = 3;" } }] },
    { content: "Bumped b to 3." },
  ]);
  try {
    const { code, out } = await runHarness({ url: mock.url, prompt: "bump b", dir, home });
    assert.equal(code, 0, out);
    assert.equal(fs.readFileSync(path.join(dir, "app.js"), "utf8"), "const a = 1;\nconst b = 3;\n");
    assert.match(out, /replaced 1 occurrence/);
    assert.match(out, /Bumped b to 3\./);
  } finally { await mock.close(); }
});

test("str_replace rejects a non-matching old_str and the error reaches the model", async () => {
  const { home, dir } = scratch();
  fs.writeFileSync(path.join(dir, "app.js"), "const a = 1;\n");
  const mock = await startMockLLM([
    { toolCalls: [{ name: "str_replace", arguments: { path: "app.js", old_str: "const z = 9;", new_str: "x" } }] },
    { content: "No such line." },
  ]);
  try {
    const { code, out } = await runHarness({ url: mock.url, prompt: "edit it", dir, home });
    assert.equal(code, 0, out);
    assert.equal(fs.readFileSync(path.join(dir, "app.js"), "utf8"), "const a = 1;\n", "file untouched");
    assert.match(out, /✗ error: old_str not found/);
    const toolMsg = mock.requests[1].messages.find(m => m.role === "tool");
    assert.match(toolMsg.content, /old_str not found/);
  } finally { await mock.close(); }
});

test("read_file feeds file content back to the model (and accepts paths[])", async () => {
  const { home, dir } = scratch();
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "beta\n");
  const mock = await startMockLLM([
    { toolCalls: [{ name: "read_file", arguments: { paths: ["a.txt", "b.txt"] } }] },
    { content: "Read both." },
  ]);
  try {
    const { code, out } = await runHarness({ url: mock.url, prompt: "read them", dir, home });
    assert.equal(code, 0, out);
    assert.match(out, /read 2 files/);
    const toolMsg = mock.requests[1].messages.find(m => m.role === "tool");
    assert.match(toolMsg.content, /===== a\.txt =====/);
    assert.match(toolMsg.content, /alpha/);
    assert.match(toolMsg.content, /beta/);
  } finally { await mock.close(); }
});

test("shell runs a command and reports stdout, and failures carry the exit code", async () => {
  const { home, dir } = scratch();
  const mock = await startMockLLM([
    { toolCalls: [
      { name: "shell", arguments: { command: `${JSON.stringify(process.execPath)} -e "console.log('built ok')"` } },
      { name: "shell", arguments: { command: `${JSON.stringify(process.execPath)} -e "process.exit(3)"` } },
    ] },
    { content: "One passed, one failed." },
  ]);
  try {
    const { code, out } = await runHarness({ url: mock.url, prompt: "run the build", dir, home });
    assert.equal(code, 0, out);
    assert.match(out, /built ok/);
    assert.match(out, /\[exit code 3\]/);
    assert.match(out, /One passed, one failed\./);
    // both calls ran in the project folder, in one assistant turn
    assert.equal(mock.requests[0].messages.filter(m => m.role === "user").length, 1);
    assert.equal(mock.requests[1].messages.filter(m => m.role === "tool").length, 2);
  } finally { await mock.close(); }
});

test("shell refuses commands that match the blocklist", async () => {
  const { home, dir } = scratch();
  const mock = await startMockLLM([
    { toolCalls: [{ name: "shell", arguments: { command: "powershell -c get-process" } }] },
    { content: "Blocked." },
  ]);
  try {
    const { code, out } = await runHarness({ url: mock.url, prompt: "try powershell", dir, home });
    assert.equal(code, 0, out);
    assert.match(out, /blocked by policy/);
    assert.match(mock.requests[1].messages.find(m => m.role === "tool").content, /blocked by policy/);
  } finally { await mock.close(); }
});

test("list_files walks the project and skips node_modules", async () => {
  const { home, dir } = scratch();
  fs.mkdirSync(path.join(dir, "node_modules", "junk"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "// hi\n");
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
  const mock = await startMockLLM([
    { toolCalls: [{ name: "list_files", arguments: {} }] },
    { content: "Listed." },
  ]);
  try {
    const { code, out } = await runHarness({ url: mock.url, prompt: "what is here", dir, home });
    assert.equal(code, 0, out);
    const toolMsg = mock.requests[1].messages.find(m => m.role === "tool");
    assert.match(toolMsg.content, /src\/index\.js/);
    assert.match(toolMsg.content, /package\.json/);
    assert.equal(/node_modules/.test(toolMsg.content.split("\n").filter(l => !l.startsWith("[")).join("\n")), false);
    assert.match(toolMsg.content, /ignored entries/);
  } finally { await mock.close(); }
});

test("unknown tools are reported back instead of crashing the loop", async () => {
  const { home, dir } = scratch();
  const mock = await startMockLLM([
    { toolCalls: [{ name: "launch_missiles", arguments: { now: true } }] },
    { content: "No such tool." },
  ]);
  try {
    const { code, out } = await runHarness({ url: mock.url, prompt: "do it", dir, home });
    assert.equal(code, 0, out);
    assert.match(out, /unknown tool/);
    assert.match(mock.requests[1].messages.find(m => m.role === "tool").content, /unknown tool 'launch_missiles'/);
  } finally { await mock.close(); }
});

test("aliased tool names are accepted (bash → shell, edit_file → str_replace)", async () => {
  const { home, dir } = scratch();
  fs.writeFileSync(path.join(dir, "f.txt"), "one\n");
  const mock = await startMockLLM([
    { toolCalls: [{ name: "edit_file", arguments: { path: "f.txt", old_str: "one", new_str: "two" } }] },
    { toolCalls: [{ name: "bash", arguments: { command: `${JSON.stringify(process.execPath)} -e "console.log('aliased ok')"` } }] },
    { content: "Done." },
  ]);
  try {
    const { code, out } = await runHarness({ url: mock.url, prompt: "edit then run", dir, home });
    assert.equal(code, 0, out);
    assert.equal(fs.readFileSync(path.join(dir, "f.txt"), "utf8"), "two\n");
    assert.match(out, /aliased ok/);
  } finally { await mock.close(); }
});

test("--stream off sends \"stream\": false and handles the single JSON reply", async () => {
  const { home, dir } = scratch();
  const mock = await startMockLLM([
    { toolCalls: [{ name: "write_file", arguments: { path: "x.txt", content: "json mode" } }] },
    { content: "Wrote it without SSE." },
  ]);
  try {
    const { code, out } = await runHarness({
      url: mock.url, prompt: "write x.txt", dir, home, extraArgs: ["--no-stream"],
    });
    assert.equal(code, 0, out);
    assert.equal(mock.requests[0].stream, false);
    assert.equal(mock.requests[0].stream_options, undefined);
    assert.equal(fs.readFileSync(path.join(dir, "x.txt"), "utf8"), "json mode");
    assert.match(out, /Wrote it without SSE\./);
  } finally { await mock.close(); }
});

test("multi-step coding task: read → edit → verify in one run", async () => {
  const { home, dir } = scratch();
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a - b;\n");
  fs.writeFileSync(path.join(dir, "math.test.js"),
    "import assert from 'node:assert/strict';\nimport { add } from './math.js';\nassert.equal(add(2, 3), 5);\nconsole.log('tests pass');\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", type: "module" }, null, 2));

  const node = JSON.stringify(process.execPath);
  const mock = await startMockLLM([
    { toolCalls: [{ name: "list_files", arguments: {} }] },
    { toolCalls: [{ name: "read_file", arguments: { paths: ["math.js", "math.test.js"] } }] },
    { toolCalls: [{ name: "str_replace", arguments: { path: "math.js", old_str: "a - b", new_str: "a + b" } }] },
    { toolCalls: [{ name: "shell", arguments: { command: `${node} math.test.js` } }] },
    { content: "Fixed add() to use + and verified with math.test.js." },
  ]);
  try {
    const { code, out } = await runHarness({ url: mock.url, prompt: "make the test pass", dir, home });
    assert.equal(code, 0, out);
    assert.equal(fs.readFileSync(path.join(dir, "math.js"), "utf8"), "export const add = (a, b) => a + b;\n");
    assert.match(out, /tests pass/);
    assert.match(out, /Fixed add\(\)/);
    assert.equal(mock.used(), 5);
    assert.match(out, /tok ↑100 ↓20/, "usage from the endpoint is reported");
  } finally { await mock.close(); }
});

test("--max-steps caps the tool loop", async () => {
  const { home, dir } = scratch();
  const mock = await startMockLLM([
    { toolCalls: [{ name: "shell", arguments: { command: "echo step" } }] },
  ]);
  try {
    const { code, out } = await runHarness({
      url: mock.url, prompt: "loop forever", dir, home, extraArgs: ["--max-steps", "2"],
    });
    assert.equal(code, 0, out);
    assert.match(out, /hit max tool steps \(2\)/);
    assert.ok(mock.used() <= 2, `expected <= 2 model calls, got ${mock.used()}`);
  } finally { await mock.close(); }
});

test("config comes from flags/env, and a missing --dir is reported not fatal", async () => {
  const { home } = scratch();
  const mock = await startMockLLM([{ content: "ok" }]);
  try {
    const { code, out } = await runHarness({
      url: mock.url, prompt: "hi", dir: path.join(home, "does-not-exist"), home,
    });
    assert.equal(code, 0, out);
    assert.match(out, /project folder not found/);
    assert.match(out, /ok/);
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// Streaming robustness: mock-llm sends whole tool calls in one chunk, so these
// use a hand-rolled SSE server for the fragment/repair paths.
// ---------------------------------------------------------------------------
function sse(res, delta, finish) {
  res.write("data: " + JSON.stringify({
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  }) + "\n\n");
}

/** @param {Array<(res: any) => void>} scripts one function per request, in order */
async function startScriptedSSE(scripts) {
  const requests = [];
  let served = 0;
  const server = (await import("node:http")).default.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-model", context_length: 8000 }] }));
        return;
      }
      requests.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const script = scripts[Math.min(served, scripts.length - 1)];
      served++;
      script(res);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, used: () => served,
           close: () => new Promise(r => server.close(r)) };
}

test("tool-call fragments streamed across chunks are reassembled (split name + split args)", { timeout: 30000 }, async () => {
  const { home, dir } = scratch();
  const srv = await startScriptedSSE([
    res => {
      sse(res, { tool_calls: [{ index: 0, id: "call_frag", type: "function", function: { name: "write_", arguments: "" } }] });
      sse(res, { tool_calls: [{ index: 0, function: { name: "file", arguments: '{"path": "frag.txt", ' } }] });
      sse(res, { tool_calls: [{ index: 0, function: { arguments: '"content": "reassembled"}' } }] });
      sse(res, {}, "tool_calls");
    },
    res => { sse(res, { content: "Fragmented call worked." }); sse(res, {}, "stop"); },
  ]);
  try {
    const { code, out } = await runHarness({ url: srv.url, prompt: "write frag.txt", dir, home });
    assert.equal(code, 0, out);
    assert.equal(fs.readFileSync(path.join(dir, "frag.txt"), "utf8"), "reassembled");
    assert.match(out, /write_file write frag\.txt \(11 chars\)/);
    assert.match(out, /Fragmented call worked\./);
  } finally { await srv.close(); }
});

test("two concatenated tool calls in one slot are split and both run", { timeout: 30000 }, async () => {
  const { home, dir } = scratch();
  const srv = await startScriptedSSE([
    res => {
      sse(res, { tool_calls: [{ index: 0, id: "call_dup", type: "function",
        function: { name: "write_filewrite_file",
                    arguments: '{"path":"one.txt","content":"1"}{"path":"two.txt","content":"2"}' } }] });
      sse(res, {}, "tool_calls");
    },
    res => { sse(res, { content: "Both written." }); sse(res, {}, "stop"); },
  ]);
  try {
    const { code, out } = await runHarness({ url: srv.url, prompt: "write two files", dir, home });
    assert.equal(code, 0, out);
    assert.equal(fs.readFileSync(path.join(dir, "one.txt"), "utf8"), "1");
    assert.equal(fs.readFileSync(path.join(dir, "two.txt"), "utf8"), "2");
    assert.equal(srv.requests[1].messages.filter(m => m.role === "tool").length, 2);
    assert.match(out, /Both written\./);
  } finally { await srv.close(); }
});

test("a server that ignores stream:true and replies with one JSON body still drives the loop", { timeout: 30000 }, async () => {
  const { home, dir } = scratch();
  const http = (await import("node:http")).default;
  const requests = [];
  // This one must not pre-send SSE headers, so it gets its own tiny server.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-model", context_length: 8000 }] }));
        return;
      }
      requests.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { content: "Plain JSON answer." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const { code, out } = await runHarness({ url, prompt: "say something", dir, home });
    assert.equal(code, 0, out);
    assert.match(out, /Plain JSON answer\./);
    assert.match(out, /tok ↑7 ↓3/);
    assert.equal(requests[0].stream, true, "the harness asked for SSE and coped anyway");
  } finally { await new Promise(r => server.close(r)); }
});
