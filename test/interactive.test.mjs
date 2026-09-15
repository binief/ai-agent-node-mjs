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
