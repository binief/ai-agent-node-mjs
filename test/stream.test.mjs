// End-to-end tests for the configurable stream true/false option.
// Runs the REAL agent.mjs as a subprocess against a scripted mock LLM, asserting that
// the request body honors cfg.stream (stream:true SSE vs "stream": false single JSON)
// and that both response shapes drive the full agent loop (text, tool calls, usage).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLLM } from "./mock-llm.mjs";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent.mjs");

// The agent's non-TTY entry point reads the prompt from stdin (piped one-shot mode).
function runAgent({ url, prompt, dir, home, extraArgs = [], env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      AGENT,
      "--url", url,
      "--model", "mock-model",
      "--key", "test-key",
      "--dir", dir,
      "--context", "8000",
      ...extraArgs,
    ], {
      env: { ...process.env, HOME: home, NO_COLOR: "1", ...env },
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

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-stream-test-"));
  return { root, home: path.join(root, "home"), dir: path.join(root, "proj") };
}

test("default mode sends stream:true and renders the streamed reply", async () => {
  const { home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([{ content: "Hello from streaming mode" }]);
  try {
    const { code, out } = await runAgent({
      url: mock.url, prompt: "say hi", dir, home,
    });
    assert.equal(code, 0, out);
    assert.match(out, /Hello from streaming mode/);
    assert.equal(mock.requests.length >= 1, true);
    assert.equal(mock.requests[0].stream, true);
    assert.deepEqual(mock.requests[0].stream_options, { include_usage: true });
  } finally { await mock.close(); }
});

test("--stream off sends \"stream\": false and handles the single JSON reply", async () => {
  const { home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([{ content: "Connected" }]);
  try {
    const { code, out } = await runAgent({
      url: mock.url,
      prompt: "Hello! Confirm connectivity with one word.",
      dir, home,
      extraArgs: ["--stream", "off"],
    });
    assert.equal(code, 0, out);
    assert.match(out, /Connected/);
    assert.equal(mock.requests.length >= 1, true);
    assert.equal(mock.requests[0].stream, false);
    assert.equal(mock.requests[0].stream_options, undefined);
    // usage from the JSON body is still reported
    assert.match(out, /↑100\s*↓20/);
  } finally { await mock.close(); }
});

test("--no-stream drives the full tool loop (tool call → tool result → final reply)", async () => {
  const { home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([
    { toolCalls: [{ name: "write_file", arguments: { path: "hello.txt", content: "hi\n" } }] },
    { content: "wrote hello.txt" },
  ]);
  try {
    const { code, out } = await runAgent({
      url: mock.url, prompt: "write hello.txt", dir, home,
      extraArgs: ["--no-stream"],
    });
    assert.equal(code, 0, out);
    assert.match(out, /write_file/);          // tool call shown
    assert.match(out, /wrote hello\.txt/);    // final reply
    assert.equal(fs.readFileSync(path.join(dir, "hello.txt"), "utf8"), "hi\n");
    assert.equal(mock.requests[0].stream, false);
    assert.equal(mock.requests[1].stream, false);
    // the tool result must have been sent back in the follow-up non-stream request
    const toolMsg = mock.requests[1].messages.find(m => m.role === "tool");
    assert.match(String(toolMsg?.content), /hello\.txt/);
  } finally { await mock.close(); }
});

test("AI_STREAM=off env var enables non-streaming mode", async () => {
  const { home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([{ content: "env says no streaming" }]);
  try {
    const { code, out } = await runAgent({
      url: mock.url, prompt: "hi", dir, home,
      env: { AI_STREAM: "off" },
    });
    assert.equal(code, 0, out);
    assert.match(out, /env says no streaming/);
    assert.equal(mock.requests[0].stream, false);
  } finally { await mock.close(); }
});

test("server that replies with SSE despite stream:false is still parsed (fallback)", async () => {
  const { home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  // Raw server: ignores the requested mode and always answers with SSE chunks.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-model", context_length: 8000 }] }));
        return;
      }
      const payload = JSON.parse(body);
      assert.equal(payload.stream, false); // agent really did ask for non-streaming
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"sse "}}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{"content":"anyway"}}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;

  try {
    const { code, out } = await runAgent({
      url, prompt: "hi", dir, home, extraArgs: ["--stream", "off"],
    });
    assert.equal(code, 0, out);
    assert.match(out, /sse anyway/);
  } finally { await new Promise(r => server.close(r)); }
});
