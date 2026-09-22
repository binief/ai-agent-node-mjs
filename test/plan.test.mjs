// End-to-end tests for the goal → tasks → follow-up loop.
// Runs the REAL agent.mjs as a subprocess against a scripted mock LLM, so every
// assertion below goes through streamChat, agentTurn, runTool and planGate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLLM } from "./mock-llm.mjs";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent.mjs");

// The agent's non-TTY entry point reads the prompt from stdin (piped one-shot mode).
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

test("sets a goal from the prompt, splits it into tasks, and blocks stopping until they are done", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dir, "b.js"), "export const b = 2;\n");

  const mock = await startMockLLM([
    // 1. decompose the prompt into a goal + verifiable tasks
    { toolCalls: [{ name: "update_plan", arguments: {
      goal: "Add a sum helper to the project",
      tasks: [
        { id: "t1", content: "write sum.js", status: "in_progress", verify: "node sum.js prints 3" },
        { id: "t2", content: "cover it with a test", status: "pending", verify: "node test.js passes" },
      ],
    } }] },
    // 2. tries to stop early with work still open -> the gate must push back
    { content: "All done!" },
    // 3. batched round: write both files in one response
    { toolCalls: [
      { name: "write_file", arguments: { path: "sum.js", content: "console.log(1 + 2);\n" } },
      { name: "write_file", arguments: { path: "test.js", content: "console.log('ok');\n" } },
    ] },
    // 4. run the verification checks
    { toolCalls: [{ name: "shell", arguments: { command: "node sum.js && node test.js" } }] },
    // 5. close out the plan
    { toolCalls: [{ name: "update_plan", arguments: {
      goal: "Add a sum helper to the project",
      tasks: [
        { id: "t1", content: "write sum.js", status: "done", verify: "node sum.js prints 3" },
        { id: "t2", content: "cover it with a test", status: "done", verify: "node test.js passes" },
      ],
    } }] },
    // 6. final summary
    { content: "Added sum.js and test.js; both verified by running them." },
  ]);

  try {
    const { code, out } = await runAgent({
      url: mock.url, home, dir,
      prompt: "Add a sum helper to the project and make sure it works.",
    });

    assert.equal(code, 0, "agent exited cleanly\n" + out);

    // the plan tool actually ran and its checklist reached the user
    assert.match(out, /update_plan goal: Add a sum helper/);
    assert.match(out, /GOAL: Add a sum helper to the project/);
    assert.match(out, /\[t1\] write sum\.js/);

    // the follow-up gate refused to let it stop with tasks open
    assert.match(out, /plan incomplete — following up \(1\/2\)/);

    // both files were written in a single batched assistant response
    assert.ok(fs.existsSync(path.join(dir, "sum.js")), "sum.js written");
    assert.ok(fs.existsSync(path.join(dir, "test.js")), "test.js written");

    // round-trip accounting is reported
    assert.match(out, /round trips? · \d+ tool calls?/);
    assert.match(out, /plan 2\/2 done/);

    // the goal and task list were injected into the system prompt on a later turn
    const last = mock.requests.at(-1);
    assert.match(last.messages[0].content, /YOUR CURRENT PLAN/);
    assert.match(last.messages[0].content, /GOAL: Add a sum helper to the project/);
    assert.match(last.messages[0].content, /✓ \[t1\] write sum\.js/);
    assert.match(last.messages[0].content, /Batch every independent tool call into one response/);

    // the gate nudge reached the model as a user message
    const nudge = mock.requests.at(2).messages.at(-1);
    assert.equal(nudge.role, "user");
    assert.match(nudge.content, /NOT DONE YET/);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("challenges tasks marked done whose verification never ran", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "test.js"), "console.log('pass');\n");

  const mock = await startMockLLM([
    { toolCalls: [{ name: "update_plan", arguments: {
      goal: "Fix the build",
      tasks: [{ id: "t1", content: "patch index.js", status: "pending", verify: "node test.js passes" }],
    } }] },
    // marks it done with no check run -> must be flagged unverified
    { toolCalls: [{ name: "update_plan", arguments: {
      updates: [{ id: "t1", status: "done" }],
    } }] },
    { content: "Fixed." },
    // after the nudge, actually run the check — and this time it passes
    { toolCalls: [{ name: "shell", arguments: { command: "node test.js" } }] },
    { content: "Build fixed and tests pass." },
  ]);

  try {
    const { code, out } = await runAgent({ url: mock.url, home, dir, prompt: "Fix the build." });
    assert.equal(code, 0, out);
    assert.match(out, /verify PENDING: node test\.js passes/);
    assert.match(out, /following up \(1\/2\)/);
    // the nudge itself is delivered to the model, not the terminal
    const nudge = mock.requests[3].messages.at(-1);
    assert.equal(nudge.role, "user");
    assert.match(nudge.content, /marked done but never verified/);
    assert.match(nudge.content, /run node test\.js passes/);
    // running the real check cleared the flag and released the gate
    assert.match(out, /verified: node test\.js passes/);
    assert.doesNotMatch(out, /following up \(2\/2\)/);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read_file reads several files in one call", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "one.txt"), "ALPHA-MARKER\n");
  fs.writeFileSync(path.join(dir, "two.txt"), "BETA-MARKER\n");

  const mock = await startMockLLM([
    { toolCalls: [{ name: "read_file", arguments: { paths: ["one.txt", "two.txt"] } }] },
    { content: "Read both." },
  ]);

  try {
    const { out } = await runAgent({ url: mock.url, home, dir, prompt: "What is in the text files?" });
    assert.match(out, /read 2 files: one\.txt, two\.txt/);

    // prove the batched read really returned both bodies to the model
    const second = mock.requests[1];
    const toolMsg = second.messages.filter(m => m.role === "tool").at(-1);
    assert.match(toolMsg.content, /ALPHA-MARKER/);
    assert.match(toolMsg.content, /BETA-MARKER/);
    assert.equal(mock.used(), 2, "one round trip for both files");
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the update_plan tool schema the agent advertises is well-formed", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([{ content: "ok" }]);
  try {
    await runAgent({ url: mock.url, home, dir, prompt: "hi" });

    const tools = mock.requests[0].tools;
    assert.ok(Array.isArray(tools) && tools.length, "tools were advertised");
    const names = tools.map(t => t.function.name);
    assert.ok(names.includes("update_plan"), "update_plan is advertised: " + names.join(", "));

    const plan = tools.find(t => t.function.name === "update_plan").function;
    assert.equal(plan.parameters.type, "object");
    assert.deepEqual(Object.keys(plan.parameters.properties).sort(), ["goal", "tasks", "updates"]);
    assert.deepEqual(plan.parameters.properties.tasks.items.properties.status.enum,
      ["pending", "in_progress", "done", "blocked", "skipped"]);
    assert.deepEqual(plan.parameters.properties.tasks.items.required, ["content", "status"]);
    // an empty `required` array is legal JSON Schema but some strict endpoints reject it
    assert.ok(!("required" in plan.parameters), "no empty required[] on the top-level schema");

    const read = tools.find(t => t.function.name === "read_file").function;
    assert.equal(read.parameters.properties.paths.type, "array", "read_file accepts paths[]");
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the goal is shown to the user even when the model never opens a task list", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");

  const mock = await startMockLLM([
    // never calls update_plan — the goal still has to be visible
    { toolCalls: [{ name: "read_file", arguments: { path: "a.js" } }] },
    { content: "It exports a constant." },
  ]);

  try {
    const { out } = await runAgent({ url: mock.url, home, dir, prompt: "Make the export clearer." });
    assert.match(out, /goal: Make the export clearer\./);
    // the derived goal is also carried into the system prompt for the model
    assert.match(mock.requests.at(-1).messages[0].content, /YOUR CURRENT PLAN/);
    assert.match(mock.requests.at(-1).messages[0].content, /no tasks yet/);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-planning can be switched off, and then plans nothing", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");

  const mock = await startMockLLM([
    { toolCalls: [{ name: "read_file", arguments: { path: "a.js" } }] },
    { content: "It exports a constant." },
  ]);

  try {
    const { out } = await runAgent({
      url: mock.url, home, dir, extraArgs: ["--no-autoplan"],
      prompt: "Make the export clearer, step by step.",
    });

    // no derived goal shown, no plan block, no gate
    assert.doesNotMatch(out, /goal:/i);
    assert.doesNotMatch(out, /following up/);
    assert.doesNotMatch(out, /GOAL:/);

    // the tool is not even offered
    const names = mock.requests[0].tools.map(t => t.function.name);
    assert.ok(!names.includes("update_plan"), "update_plan withheld: " + names.join(", "));

    // and the model is told explicitly not to plan
    assert.match(mock.requests[0].messages[0].content, /auto-planning is OFF/);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-planning is on by default and offers update_plan", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([{ content: "ok" }]);
  try {
    const { out } = await runAgent({ url: mock.url, home, dir, prompt: "Do a multi-step refactor." });
    assert.match(out, /goal: Do a multi-step refactor\./);
    assert.ok(mock.requests[0].tools.some(t => t.function.name === "update_plan"));
    assert.doesNotMatch(mock.requests[0].messages[0].content, /auto-planning is OFF/);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a plain question needs no plan and no follow-up nudge", async () => {  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([{ content: "It is a Node CLI." }]);

  try {
    const { out } = await runAgent({ url: mock.url, home, dir, prompt: "What kind of project is this?" });
    assert.match(out, /It is a Node CLI\./);
    assert.doesNotMatch(out, /following up/);
    assert.equal(mock.used(), 1, "answered in a single round trip");
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("multi-step file changes with no task list are sent back to plan first", async () => {
  const { root, home, dir } = scratch();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([
    // 1. two writes with no update_plan first
    { toolCalls: [
      { name: "write_file", arguments: { path: "one.txt", content: "1\n" } },
      { name: "write_file", arguments: { path: "two.txt", content: "2\n" } },
    ] },
    // 2. tries to stop without any tasks -> gate must demand a plan
    { content: "Done!" },
    // 3. creates the list after the nudge (already written, nothing left to check)
    { toolCalls: [{ name: "update_plan", arguments: {
      goal: "Write two text files",
      tasks: [
        { id: "t1", content: "write one.txt", status: "done" },
        { id: "t2", content: "write two.txt", status: "done" },
      ],
    } }] },
    // 4. final summary
    { content: "Wrote both files." },
  ]);

  try {
    const { code, out } = await runAgent({ url: mock.url, home, dir, prompt: "Write one.txt and two.txt." });
    assert.equal(code, 0, out);
    assert.match(out, /following up \(1\/2\)/);
    const nudge = mock.requests[2].messages.at(-1);
    assert.equal(nudge.role, "user");
    assert.match(nudge.content, /NO PLAN YET/);
    assert.ok(fs.existsSync(path.join(dir, "one.txt")));
    assert.ok(fs.existsSync(path.join(dir, "two.txt")));
    assert.match(out, /plan 2\/2 done/);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
