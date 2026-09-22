// Interactive REPL test. The /plan command is only reachable when stdin is a TTY,
// so this drives the real terminal UI through a pty (via `script`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLLM } from "./mock-llm.mjs";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent.mjs");
const hasScript = spawnSync("script", ["--version"]).status === 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

test({ name: "/set autoplan off stops auto goals; /plan goal opts back in", skip: !hasScript && "needs `script` for a pty" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pty2-"));
  const home = path.join(root, "home");
  const dir = path.join(root, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([
    { content: "First answer." },
    { content: "Second answer." },
    { content: "Third answer." },
  ]);

  const cmd = `node ${AGENT} --url ${mock.url} --model mock-model --key k --dir ${dir} --context 8000`;
  const child = spawn("script", ["-qec", cmd, "/dev/null"], {
    env: { ...process.env, HOME: home, NO_COLOR: "1", TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", c => (out += c));
  child.stderr.on("data", c => (out += c));

  try {
    await sleep(1500);
    child.stdin.write("/set autoplan off\r");
    await sleep(700);
    child.stdin.write("refactor the thing\r");
    await sleep(2200);
    child.stdin.write("/plan\r");
    await sleep(700);
    child.stdin.write("/plan goal Fix the parser\r");
    await sleep(700);
    child.stdin.write("do it\r");
    await sleep(2200);
    child.stdin.write("/exit\r");
    await sleep(1000);
    child.kill();
    await sleep(300);

    const plain = out.replace(/\r/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

    // the setting was accepted
    assert.match(plain, /autoplan updated/);
    assert.match(plain, /no auto goal\/tasks/);

    // with it off, the prompt produced no derived goal
    const firstTurn = plain.slice(plain.indexOf("refactor the thing"), plain.indexOf("/plan"));
    assert.doesNotMatch(firstTurn, /goal:/i);

    // and /plan explains why there is no plan
    assert.match(plain, /auto-planning is off/);

    // an explicit goal opts back in even though autoplan is still off
    assert.match(plain, /goal set/);
    const secondTurn = plain.slice(plain.indexOf("do it"));
    assert.match(secondTurn, /goal: Fix the parser/);
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test({ name: "/plan shows the live goal and checklist in the REPL", skip: !hasScript && "needs `script` for a pty" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pty-"));
  const home = path.join(root, "home");
  const dir = path.join(root, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "x.js"), "console.log(1);\n");

  const mock = await startMockLLM([
    { toolCalls: [{ name: "update_plan", arguments: {
      goal: "Inspect the project",
      tasks: [
        { id: "t1", content: "read x.js", status: "done", verify: "node x.js runs" },
        { id: "t2", content: "summarise it", status: "pending", verify: "summary written" },
      ],
    } }] },
    { content: "Here is the summary." },
    { content: "Sure." },
  ]);

  const cmd = `node ${AGENT} --url ${mock.url} --model mock-model --key k --dir ${dir} --context 8000`;
  const child = spawn("script", ["-qec", cmd, "/dev/null"], {
    env: { ...process.env, HOME: home, NO_COLOR: "1", TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", c => (out += c));
  child.stderr.on("data", c => (out += c));

  try {
    await sleep(1500);
    child.stdin.write("inspect the project and tell me about it\r");
    await sleep(3000);
    child.stdin.write("/plan\r");
    await sleep(1200);
    child.stdin.write("/plan clear\r");
    await sleep(700);
    child.stdin.write("/plan\r");
    await sleep(700);
    child.stdin.write("/exit\r");
    await sleep(1000);
    child.kill();
    await sleep(300);

    const plain = out.replace(/\r/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

    // /plan rendered the live goal + checklist, between the two later commands
    const shown = plain.slice(plain.indexOf("/plan"), plain.indexOf("/plan clear"));
    assert.match(shown, /GOAL: Inspect the project/);
    assert.match(shown, /☐ \[t2\] summarise it/);
    assert.match(shown, /1\/2 done · \d+ round trips? · \d+ tool calls?/);

    // /plan clear dropped it, and a bare /plan then reports no plan
    assert.match(plain, /plan cleared/);
    const afterClear = plain.slice(plain.indexOf("/plan clear"));
    assert.match(afterClear, /no active plan/);

    // the gate held the turn open while t2 was still pending
    assert.match(plain, /plan incomplete — following up/);
    assert.match(plain, /plan 1\/2 done · 1 open/);
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test({ name: "/plan goal drafts tasks immediately and /plan edits them", skip: !hasScript && "needs `script` for a pty" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pty3-"));
  const home = path.join(root, "home");
  const dir = path.join(root, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([
    // planner call for "/plan goal ...": returns a real task list via update_plan
    { toolCalls: [{ name: "update_plan", arguments: {
      goal: "Add a health check",
      tasks: [
        { id: "t1", content: "add health endpoint", status: "pending", verify: "curl localhost:3000/health returns ok" },
        { id: "t2", content: "cover it with a test", status: "pending", verify: "npm test passes" },
      ],
    } }] },
  ]);

  const cmd = `node ${AGENT} --url ${mock.url} --model mock-model --key k --dir ${dir} --context 8000`;
  const child = spawn("script", ["-qec", cmd, "/dev/null"], {
    env: { ...process.env, HOME: home, NO_COLOR: "1", TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", c => (out += c));
  child.stderr.on("data", c => (out += c));

  try {
    await sleep(1500);
    child.stdin.write("/plan goal Add a health check\r");
    await sleep(2500);
    child.stdin.write("/plan add Document the endpoint | README mentions \/health\r");
    await sleep(800);
    child.stdin.write("/plan status t1 in_progress\r");
    await sleep(800);
    child.stdin.write("/plan\r");
    await sleep(800);
    child.stdin.write("/exit\r");
    await sleep(1000);
    child.kill();
    await sleep(300);

    const plain = out.replace(/\r/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

    // tasks were drafted by the planner call the moment the goal was set
    assert.match(plain, /goal set/);
    assert.match(plain, /GOAL: Add a health check/);
    assert.match(plain, /\[t1\] add health endpoint/);
    assert.match(plain, /\[t2\] cover it with a test/);
    // the planner is a dedicated call that may READ (to see what already exists) but never write
    assert.equal(mock.requests.length >= 1, true);
    const plannerTools = mock.requests[0].tools.map(t => t.function.name).sort();
    assert.deepEqual(plannerTools, ["read_file", "shell", "update_plan"]);
    assert.ok(!plannerTools.includes("write_file") && !plannerTools.includes("str_replace"),
      "planning must not be offered mutating tools");
    // and it is handed real facts about the project before it drafts anything
    assert.match(mock.requests[0].messages[1].content, /PROJECT FACTS/);

    // edits landed
    assert.match(plain, /added \[t3\]/);
    assert.match(plain, /\[t3\] Document the endpoint/);
    assert.match(plain, /\[t1\] → in_progress/);

    // the list is still there at the end, awaiting confirmation
    const tail = plain.slice(plain.lastIndexOf("/plan"));
    assert.match(tail, /awaiting confirmation/);
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test({ name: "explicit goals pause for confirmation before the first change", skip: !hasScript && "needs `script` for a pty" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pty4-"));
  const home = path.join(root, "home");
  const dir = path.join(root, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const mock = await startMockLLM([
    // planner call for "/plan goal ...": draft the list
    { toolCalls: [{ name: "update_plan", arguments: {
      goal: "Write hello.txt",
      tasks: [
        { id: "t1", content: "write hello.txt", status: "pending", verify: "hello.txt exists" },
      ],
    } }] },
    // audit of the draft against the scanned facts: nothing to reject
    { content: '{"invalid":[]}' },
    // first "do it": tries to write -> user rejects at the prompt
    { toolCalls: [{ name: "write_file", arguments: { path: "hello.txt", content: "hi\n" } }] },
    // second "go": tries again -> user accepts, the write runs
    { toolCalls: [{ name: "write_file", arguments: { path: "hello.txt", content: "hi\n" } }] },
    // close out (verify cleared: nothing left to check after the write)
    { toolCalls: [{ name: "update_plan", arguments: {
      tasks: [{ id: "t1", content: "write hello.txt", status: "done", verify: "" }],
    } }] },
    { content: "Wrote hello.txt." },
  ]);

  const cmd = `node ${AGENT} --url ${mock.url} --model mock-model --key k --dir ${dir} --context 8000`;
  const child = spawn("script", ["-qec", cmd, "/dev/null"], {
    env: { ...process.env, HOME: home, NO_COLOR: "1", TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", c => (out += c));
  child.stderr.on("data", c => (out += c));

  try {
    await sleep(1500);
    child.stdin.write("/plan goal Write hello.txt\r");
    await sleep(2500);
    child.stdin.write("do it\r");
    await sleep(2500);   // let the turn reach the confirmation prompt
    child.stdin.write("n");
    await sleep(1500);
    assert.ok(!fs.existsSync(path.join(dir, "hello.txt")), "rejected plan wrote nothing");
    child.stdin.write("go\r");
    await sleep(2500);   // reach the prompt again
    child.stdin.write("y");
    await sleep(3000);   // write + close-out + summary
    child.stdin.write("/exit\r");
    await sleep(1000);
    child.kill();
    await sleep(300);

    const plain = out.replace(/\r/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

    assert.match(plain, /proceed with this plan\?/);
    assert.match(plain, /plan not confirmed/);
    assert.match(plain, /plan confirmed — proceeding/);
    assert.match(plain, /Wrote hello\.txt\./);
    assert.ok(fs.existsSync(path.join(dir, "hello.txt")), "accepted plan wrote the file");
    assert.equal(fs.readFileSync(path.join(dir, "hello.txt"), "utf8"), "hi\n");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
