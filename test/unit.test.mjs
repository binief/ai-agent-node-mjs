// Unit tests for the pure helpers in agent.mjs (imported with AI_AGENT_NO_MAIN so the REPL
// does not start). Every case here is a regression for a bug that made the agent loop,
// corrupt a file, or feed the model garbage.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// the data folder (~/.aiterm) is derived from HOME at import time → point it at a scratch dir
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-unit-home-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.AI_AGENT_NO_MAIN = "1";
fs.mkdirSync(path.join(HOME, ".aiterm"), { recursive: true });
const A = await import("../agent.mjs");

const R = (p = "a.txt") => ({ sig: A.toolCallSignature("read_file", JSON.stringify({ path: p })), res: "hello", mut: false });
const T = (out = "ok") => ({ sig: A.toolCallSignature("shell", JSON.stringify({ command: "npm test" })), res: A.resultSignature(out), mut: true });
const E = (n) => ({ sig: A.toolCallSignature("str_replace", JSON.stringify({ path: "x.js", old_str: "v" + n, new_str: "v" + (n + 1) })), res: "replaced", mut: true });
const U = (id, status) => ({ sig: A.toolCallSignature("update_plan", JSON.stringify({ updates: [{ id, status }] })), res: "plan updated " + id + status, mut: false });

test("tool-call signatures keep nested content (the old whitelist bug collapsed every update_plan to the same key)", () => {
  const a = A.toolCallSignature("update_plan", JSON.stringify({ updates: [{ id: "t1", status: "in_progress" }] }));
  const b = A.toolCallSignature("update_plan", JSON.stringify({ updates: [{ id: "t2", status: "done" }] }));
  assert.notEqual(a, b);
  assert.match(a, /t1/);
  // key order is irrelevant at every level
  assert.equal(A.canonicalJson({ b: [{ y: 1, x: 2 }], a: 1 }), A.canonicalJson({ a: 1, b: [{ x: 2, y: 1 }] }));
  // non-JSON arguments do not throw
  assert.equal(A.toolCallSignature("shell", "ls -la"), "shell(ls -la)");
});

test("result signatures ignore numbers and whitespace (durations, pids, byte counts)", () => {
  assert.equal(A.resultSignature("3 passed (152ms)\n"), A.resultSignature("3 passed  (161ms)"));
  assert.notEqual(A.resultSignature("passed"), A.resultSignature("failed"));
});

test("loop detector: productive patterns are NOT loops", () => {
  // edit → verify → edit → verify … (4 identical test runs, different edits between)
  assert.equal(A.detectToolLoop([T("fail"), E(0), T("fail"), E(1), T("fail"), E(2), T("ok")]), null);
  // the plan checklist being worked through (12 status flips)
  const flips = [];
  for (let i = 1; i <= 6; i++) flips.push(U("t" + i, "in_progress"), U("t" + i, "done"));
  assert.equal(A.detectToolLoop(flips), null);
  // reading many different files
  assert.equal(A.detectToolLoop(["a", "b", "c", "d", "e", "f"].map(R)), null);
  // same read repeated but with a mutation in between each time
  assert.equal(A.detectToolLoop([R(), E(0), R(), E(1), R(), E(2), R()]), null);
  // two identical reads in a row is not yet a loop
  assert.equal(A.detectToolLoop([R(), R()]), null);
});

test("loop detector: genuine loops ARE caught", () => {
  assert.match(A.detectToolLoop([R(), R(), R()]), /same call \+ same result 3x/);
  assert.match(A.detectToolLoop([R(), T("ok"), R(), T("ok"), R(), T("ok")]), /cycle of 2 calls repeated 3x/);
  assert.match(A.detectToolLoop([R(), U("t1", "in_progress"), R(), U("t1", "in_progress"), R(), U("t1", "in_progress"), R()]),
    /same call \+ same result 4x with no changes in between|cycle/);
  // same call, results keep changing (polling without a wait) → still a loop after 5
  const poll = (n) => ({ sig: "shell(date)", res: "t" + String.fromCharCode(97 + n), mut: false });
  assert.equal(A.detectToolLoop([0, 1, 2, 3].map(poll)), null);
  assert.match(A.detectToolLoop([0, 1, 2, 3, 4].map(poll)), /same call 5x in a row/);
  // an explicit wait/poll command gets the lenient threshold
  const w = { sig: "shell(sleep 2 && curl localhost:3000)", res: "refused", mut: false, wait: true };
  assert.equal(A.detectToolLoop([w, w, w, w]), null);
  assert.match(A.detectToolLoop([w, w, w, w, w]), /same call \+ same result 5x/);
});

test("response-level loop detector needs 4 verbatim resends", () => {
  assert.equal(A.detectResponseLoop(["x", "x", "x"]), null);
  assert.match(A.detectResponseLoop(["y", "x", "x", "x", "x"]), /identical response 4x/);
  assert.equal(A.detectResponseLoop(["x", "x", "x", "y"]), null);
});

test("repairHistory gives every tool_call a result and drops orphans (ctrl+c mid-batch used to poison the session)", () => {
  const h = [
    { role: "system", content: "s" },
    { role: "user", content: "do it" },
    { role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "shell", arguments: "{\"command\":\"ls\"}" } },
      { id: "c2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } },
      { id: "c3", type: "function", function: { name: "shell", arguments: "{not json" } },
    ] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    // c2 never got a result (interrupted); c3 has unparsable args
    { role: "tool", tool_call_id: "zzz", content: "orphan" },
    { role: "assistant", content: "done" },
  ];
  const fixes = A.repairHistory(h);
  assert.ok(fixes > 0);
  const asst = h[2];
  assert.deepEqual(asst.tool_calls.map(t => t.id), ["c1", "c2"]);
  assert.equal(h[3].tool_call_id, "c1");
  assert.equal(h[4].tool_call_id, "c2");
  assert.match(h[4].content, /interrupted/);
  assert.ok(!h.some(m => m.tool_call_id === "zzz"));
  assert.equal(h.at(-1).content, "done");
  // already-consistent history is left alone
  assert.equal(A.repairHistory(h), 0);
  // a transcript that starts with an assistant message gets a user opener
  const h2 = [{ role: "system", content: "s" }, { role: "assistant", content: "hi" }];
  A.repairHistory(h2);
  assert.equal(h2[1].role, "user");
});

test("trimHistory keeps the current request and shrinks old tool output before dropping steps", () => {
  const big = "x".repeat(4000);
  const turn = { role: "user", content: "current request" };
  const h = [
    { role: "system", content: "sys" },
    { role: "user", content: "old request " + big },
    { role: "assistant", content: "old answer" },
    turn,
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "shell", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: big },
    { role: "assistant", content: null, tool_calls: [{ id: "b", type: "function", function: { name: "shell", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "b", content: big },
    { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "shell", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c", content: "latest" },
  ];
  A.trimHistory(h, { context: 2600, maxTokens: 0 }, turn);
  assert.ok(h.includes(turn), "current user message survives");
  assert.equal(h[1], turn, "older exchange dropped first");
  assert.ok(A.estTokens(h) <= 2600 - 1024);
  assert.equal(h.at(-1).content, "latest", "the newest result is untouched");
  // no orphaned tool results
  const ids = new Set(h.flatMap(m => m.tool_calls?.map(t => t.id) || []));
  for (const m of h) if (m.role === "tool") assert.ok(ids.has(m.tool_call_id));
});

test("secret masking leaves ordinary code alone but still hides real secrets", () => {
  const cfg = { redact: true };
  const code = [
    "interface Session { token: string; password: string; }",
    "const token = lexer.next();",
    "const pwd = process.cwd();",
    "headers: { authorization: `Bearer ${token}` }",
    "const apiKey = process.env.API_KEY;",
    "PWD=/home/user/project",
    "const secret = getSecret();",
    "password: ${DB_PASSWORD}",
    "token: null",
  ].join("\n");
  assert.equal(A.maskSecrets(code, cfg), code);

  const secrets = [
    "api_key = sk-live-9f8e7d6c5b4a3210fedcba9876543210",
    "DATABASE_PASSWORD=supersecret",
    'password: "hunter2"',
    "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "postgres://app:p4ssw0rd!@db.internal:5432/app",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
  ];
  const masked = A.maskSecrets(secrets.join("\n"), cfg).split("\n");
  assert.doesNotMatch(masked[0], /9f8e7d6c/);
  assert.doesNotMatch(masked[1], /supersecret/);
  assert.doesNotMatch(masked[2], /hunter2/);
  assert.doesNotMatch(masked[3], /ghp_ABCDEF/);
  assert.doesNotMatch(masked[4], /eyJhbGci/);
  assert.match(masked[4], /Bearer /);
  assert.doesNotMatch(masked[5], /p4ssw0rd/);
  assert.match(masked[5], /^postgres:\/\/app:.+@db\.internal:5432\/app$/);
  assert.doesNotMatch(masked[6], /AKIAIOSFODNN7EXAMPLE/);
  // dummies are long enough not to collide with real file content, and round-trip back
  for (const line of masked) for (const tok of line.match(/[A-Za-z0-9]{8,}/g) || []) assert.ok(tok.length >= 8);
  assert.equal(A.restoreSecrets(masked.join("\n")), secrets.join("\n"));
  // redaction off → untouched
  assert.equal(A.maskSecrets(secrets[1], { redact: false }), secrets[1]);
});

test("str_replace never interprets $ patterns, edits lines containing 'truncated', and tolerates trailing whitespace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-unit-sr-"));
  const cfg = { projectDir: dir, redact: true };
  const f = path.join(dir, "s.sh");
  fs.writeFileSync(f, "echo PID\nlog 'output truncated here'   \nend\n");

  let [ok, msg] = A.toolStrReplace({ path: "s.sh", old_str: "echo PID", new_str: "echo $$ and $& and $' and $1 ok" }, cfg);
  assert.ok(ok, msg);
  assert.equal(fs.readFileSync(f, "utf8"), "echo $$ and $& and $' and $1 ok\nlog 'output truncated here'   \nend\n");

  // spans a line whose trailing spaces the model did not reproduce → exact match fails, loose match works
  [ok, msg] = A.toolStrReplace({ path: "s.sh", old_str: "log 'output truncated here'\nend", new_str: "log 'done'\nend" }, cfg);
  assert.ok(ok, msg);
  assert.match(msg, /ignoring trailing whitespace/);
  assert.equal(fs.readFileSync(f, "utf8"), "echo $$ and $& and $' and $1 ok\nlog 'done'\nend\n");

  // the agent's own omission marker is still refused
  [ok, msg] = A.toolStrReplace({ path: "s.sh", old_str: "end\n…[120 chars truncated]…\n", new_str: "x" }, cfg);
  assert.ok(!ok); assert.match(msg, /omission marker/);
  // no-op edits are reported instead of "succeeding" forever
  [ok, msg] = A.toolStrReplace({ path: "s.sh", old_str: "end", new_str: "end" }, cfg);
  assert.ok(!ok); assert.match(msg, /identical/);
  // ambiguous matches are refused
  fs.writeFileSync(f, "a\na\n");
  [ok, msg] = A.toolStrReplace({ path: "s.sh", old_str: "a", new_str: "b" }, cfg);
  assert.ok(!ok); assert.match(msg, /matches 2 times/);
  // CRLF files keep CRLF
  fs.writeFileSync(f, "one\r\ntwo\r\n");
  [ok] = A.toolStrReplace({ path: "s.sh", old_str: "two", new_str: "2" }, cfg);
  assert.ok(ok);
  assert.equal(fs.readFileSync(f, "utf8"), "one\r\n2\r\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("read_file: batch reads isolate failures and flag truncation; missing files are errors, not crashes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-unit-rd-"));
  const cfg = { projectDir: dir, maxout: 4000 };
  fs.writeFileSync(path.join(dir, "ok.txt"), "fine\n");
  fs.writeFileSync(path.join(dir, "big.txt"), "y".repeat(5000));
  const [ok, out] = A.toolRead({ paths: ["ok.txt", "missing.txt", "big.txt"] }, cfg);
  assert.ok(ok, "partial success is still a success");
  assert.match(out, /===== ok\.txt {2}=====\nfine/);
  assert.match(out, /missing\.txt \(FAILED\)/);
  assert.match(out, /more chars not shown/);
  const [ok2, msg2] = A.toolRead({ path: "nope.txt" }, cfg);
  assert.ok(!ok2); assert.match(msg2, /ENOENT|could not read/);
  const [ok3, msg3] = A.toolRead({ path: "." }, cfg);
  assert.ok(!ok3); assert.match(msg3, /directory/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("text tool-call fallback parses plain JSON / fenced / [TOOL_CALLS] but never a quoted unknown tool", () => {
  let c = A.parseTextToolCalls('{"name": "shell", "arguments": {"command": "ls -la"}}');
  assert.equal(c.length, 1); assert.equal(c[0].name, "shell"); assert.deepEqual(JSON.parse(c[0].arguments), { command: "ls -la" });
  c = A.parseTextToolCalls('Sure.\n```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n```');
  assert.equal(c.length, 1); assert.equal(c[0].name, "read_file");
  c = A.parseTextToolCalls('[TOOL_CALLS] [{"name": "shell", "arguments": {"command": "pwd"}}]');
  assert.equal(c.length, 1);
  c = A.parseTextToolCalls('<tool_call>\n{"name": "bash", "arguments": {"command": "pwd"}}\n</tool_call>');
  assert.equal(c.length, 1); assert.equal(c[0].name, "shell");
  // a final answer that merely shows some JSON with an unknown "name" must not run anything
  c = A.parseTextToolCalls('Here is the config:\n```json\n{"name": "my-app", "arguments": {"port": 3000}}\n```');
  assert.equal(c.length, 0);
  assert.equal(A.parseTextToolCalls("All done. The function=foo pattern is not a call.").length, 0);
  assert.equal(A.stripToolMarkup('{"name": "shell", "arguments": {"command": "ls"}}'), "");
});

test("malformed tool arguments are never executed as a shell command", () => {
  assert.deepEqual(A.parseToolArgs('{"command":"ls"}'), { command: "ls" });
  assert.deepEqual(A.parseToolArgs('```json\n{"command":"ls"}\n```'), { command: "ls" });
  assert.deepEqual(A.parseToolArgs('"ls -la"'), { _raw: "ls -la" });
  assert.deepEqual(A.parseToolArgs("ls -la"), { _raw: "ls -la" });
  assert.deepEqual(A.parseToolArgs(""), {});
  assert.deepEqual(A.shellCommandOf({ _raw: "ls -la" }), ["ls -la", null]);
  const [cmd, err] = A.shellCommandOf({ _raw: '{"command": "rm -rf x' });
  assert.equal(cmd, null); assert.match(err, /not valid JSON/);
  assert.match(A.shellCommandOf({})[1], /needs a `command`/);
});

test("read-only command classification understands redirections and chains", () => {
  assert.ok(A.isReadOnlyCommand("cat a.txt"));
  assert.ok(A.isReadOnlyCommand("git status && git diff"));
  assert.ok(A.isReadOnlyCommand("grep -rn foo src | head -20"));
  assert.ok(!A.isReadOnlyCommand("cat a.txt > b.txt"));
  assert.ok(!A.isReadOnlyCommand("echo hi >> log"));
  assert.ok(!A.isReadOnlyCommand("ls && rm -rf dist"));
  assert.ok(!A.isReadOnlyCommand("npm test"));
  assert.ok(A.isReadOnlyCommand("ls 2>&1"), "stderr redirect is not a file write");
  assert.equal(A.classifyTool("shell", { command: "rm -rf / --no-preserve-root" }), "block");
  assert.equal(A.classifyTool("shell", { command: "npm test" }), "ask");
  assert.equal(A.classifyTool("shell", { command: "git log -3" }), "auto");
  assert.equal(A.classifyTool("update_plan", {}), "auto");
});

test("curl to a local dev server is never blocked (no web MCP is registered here)", () => {
  assert.deepEqual(A.checkCommandPolicy("curl http://localhost:3000/health", {}), { allowed: true });
  assert.deepEqual(A.checkCommandPolicy("curl https://example.com", {}), { allowed: true });
  assert.equal(A.checkCommandPolicy("powershell -c Get-Date", {}).allowed, false);
});

test("completion gate: no more than MAX nudges without progress, patience only on real progress", () => {
  A.resetPlan();
  A.startPlanTurn("ship it");
  A.applyPlanUpdate({ goal: "ship it", tasks: [
    { id: "t1", content: "a", status: "pending" }, { id: "t2", content: "b", status: "pending" }, { id: "t3", content: "c", status: "pending" },
  ] }, {});
  const cfg = { mode: "code" };
  assert.match(A.planGate(cfg), /NOT DONE YET/);
  // the model "responds" with a status flip that resolves nothing — that used to reset the counter
  A.applyPlanUpdate({ updates: [{ id: "t1", status: "in_progress" }] }, {});
  assert.match(A.planGate(cfg), /NOT DONE YET/);
  A.applyPlanUpdate({ updates: [{ id: "t1", status: "in_progress", note: "again" }] }, {});
  assert.equal(A.planGate(cfg), null, "third pushback without progress is refused");
  // real progress (a task resolved) earns another round of pushbacks …
  A.applyPlanUpdate({ updates: [{ id: "t1", status: "done" }] }, {});
  assert.match(A.planGate(cfg), /2 task\(s\) still open/);
  assert.match(A.planGate(cfg), /NOT DONE YET/);
  assert.equal(A.planGate(cfg), null);
  // … but never in plan mode, where open tasks are the expected end state
  assert.equal(A.planGate({ mode: "plan" }), null);
  A.resetPlan();
});

test("the hard cap on nudges holds even with steady progress", () => {
  A.resetPlan();
  A.startPlanTurn("many");
  const tasks = Array.from({ length: 20 }, (_, i) => ({ id: "t" + (i + 1), content: "task " + (i + 1), status: "pending" }));
  A.applyPlanUpdate({ goal: "many", tasks }, {});
  let n = 0;
  for (let i = 1; i <= 20; i++) {
    if (A.planGate({ mode: "code" })) n++;
    A.applyPlanUpdate({ updates: [{ id: "t" + i, status: "done" }] }, {});
  }
  assert.ok(n <= 6, `nudged ${n} times`);
  A.resetPlan();
});

test("mergeToolCallChunk handles OpenAI-style deltas and whole-call resends", () => {
  const slots = [];
  A.mergeToolCallChunk(slots, { index: 0, id: "c1", function: { name: "shell", arguments: "" } });
  A.mergeToolCallChunk(slots, { index: 0, function: { arguments: '{"comm' } });
  A.mergeToolCallChunk(slots, { index: 0, function: { arguments: 'and":"ls"}' } });
  A.mergeToolCallChunk(slots, { index: 1, id: "c2", function: { name: "read_file", arguments: '{"path":"a"}' } });
  assert.equal(slots.length, 2);
  assert.deepEqual(JSON.parse(slots[0].arguments), { command: "ls" });
  // ollama-style: two complete calls both with index 0
  const s2 = [];
  A.mergeToolCallChunk(s2, { index: 0, function: { name: "shell", arguments: { command: "a" } } });
  A.mergeToolCallChunk(s2, { index: 0, function: { name: "shell", arguments: { command: "b" } } });
  assert.equal(s2.length, 2);
  // concatenated JSON objects in one slot get split into separate calls
  const fixed = A.repairToolCalls([{ id: "x", index: 0, name: "shellshell", arguments: '{"command":"a"}{"command":"b"}' }]);
  assert.equal(fixed.length, 2);
  assert.equal(fixed[1].name, "shell");
});

test("CLI: a mistyped flag is not swallowed as the prompt", () => {
  const a = A.parseArgs(["--modle", "x", "hello"]);
  assert.equal(a.prompt, "x");           // the flag itself is dropped with a warning; its value is the first positional
  assert.equal(A.parseArgs(["--no-stream", "hi"]).prompt, "hi");
  assert.equal(A.normalizeBase("http://localhost:8000"), "http://localhost:8000/v1");
  assert.equal(A.normalizeBase("ollama"), "http://localhost:11434/v1");
});

test("shell timeout kills the whole process tree instead of waiting for grandchildren", async () => {
  const t0 = Date.now();
  // nested shell + sleep: killing only `sh -c` used to leave `sleep` holding the pipe for 20s
  const [ok, out] = await A.runShell("sh -c 'sleep 20; echo late'", 1, {}, {});
  const secs = (Date.now() - t0) / 1000;
  assert.equal(ok, false);
  assert.match(out, /terminated after 1s/);
  assert.ok(secs < 6, `took ${secs}s`);
  // normal commands still report exit codes and output
  const [ok2, out2] = await A.runShell("echo hi && exit 3", 10, {}, {});
  assert.equal(ok2, false); assert.match(out2, /\[exit code 3\]\nhi/);
  const [ok3, out3] = await A.runShell("printf 'a\\nb'", 10, {}, {});
  assert.ok(ok3); assert.equal(out3, "a\nb");
  const [ok4] = await A.runShell("powershell -c Get-Date", 10, {}, {});
  assert.equal(ok4, false);
});
