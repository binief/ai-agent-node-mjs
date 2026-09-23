# harness.mjs — a minimal coding harness

`harness.mjs` is `agent.mjs` reduced to the parts that actually matter for writing code:
one file, **zero dependencies** (stdlib only — it runs without `npm install`), five tools,
one loop.

```
node harness.mjs                                  # interactive REPL
node harness.mjs "add tests for parser.mjs"       # one-shot
echo "explain this repo" | node harness.mjs       # piped one-shot
node harness.mjs --url ollama --model qwen3-coder --dir ~/proj
node harness.mjs --no-stream --model gpt-4o-mini "fix the build"
```

## What it keeps from `agent.mjs`

| Piece | Why it stays |
| --- | --- |
| OpenAI-compatible client, SSE **and** `"stream": false` | local servers (vLLM, LM Studio, Ollama) often don't stream |
| tool-call chunk accumulation + JSON repair | streamed fragments and concatenated argument blobs are the #1 cause of broken runs |
| retry ladder (rate limits, `stream_options`, context overflow, malformed history, tools rejected) | transient endpoint quirks shouldn't kill a coding run |
| context estimate + history trimming + tool-output truncation | long sessions and noisy builds |
| fail-streak guard (3) and repeat-call guard (3) | stops the "same edit, forever" loop |
| `shell` / `read_file` / `write_file` / `str_replace` | the coding core |
| project dir, aliases, env vars, one-shot + piped + interactive entry points | same ergonomics as `agent.mjs` |

## What it drops

MCP client · plan/goal gate (`update_plan`) · long-term memory (`remember`/`forget`) ·
silent secret redaction · sessions (`/save`, `/load`) · OS command ledger · draft model ·
ask/plan/code modes · approval interception · cycle-detection heuristics · XML tool-call
fallback · the custom raw-mode line editor (plain `node:readline` instead) ·
first-run data-dir migration.

## Tools

| Tool | Notes |
| --- | --- |
| `shell` | runs in the project folder, 180 s timeout, exit code + stdout/stderr; `background: true` detaches servers/watchers |
| `read_file` | `path` (+ optional `start`/`end`) or `paths: [...]` to batch several files in one call |
| `str_replace` | exact, unique, contiguous match; CRLF-aware; refuses truncation markers |
| `write_file` | create/overwrite, makes parent dirs |
| `list_files` | orientation walk, skips `node_modules`/`.git`/build output, depth-limited |

Common alias names are accepted and mapped (`bash`→`shell`, `edit_file`→`str_replace`,
`create_file`→`write_file`, `ls`→`list_files`, …) so weaker models still drive the loop.

Two guards are always on: a destructive-command regex list (`rm -rf /`, `mkfs`, `shutdown`, …)
and a blocklist (PowerShell by default). Both return an error to the model instead of running.

## Config

Precedence: **CLI flags → env → `~/.harness/config.json` → `~/.aiterm/config.json`
(the `agent.mjs` settings, read-only) → defaults**. The harness never writes to
`~/.aiterm`; the first-run wizard saves to `~/.harness/config.json`.

```
AI_URL / AI_MODEL / AI_KEY / AI_DIR / AI_STREAM / AI_MAX_STEPS / AI_CONTEXT / NO_COLOR
--url --model --key --dir --system --context --maxout --max-tokens --max-steps
--timeout --temperature --reasoning --stream/--no-stream --tools/--no-tools
--list --print-system --help
```

REPL commands: `/model` `/url` `/dir` `/stream` `/steps` `/context` `/clear` `/stats`
`/tools` `/config` `/help` `/exit`. Ctrl+C cancels the running model call or child process
(twice when idle = quit); Ctrl+D exits.

## Tests

`test/harness.test.mjs` runs the real harness as a subprocess against the scripted mock
endpoint in `test/mock-llm.mjs`, covering both stream modes and every tool:

```
node --test test/harness.test.mjs      # no dependencies needed
```

(The `agent.mjs` tests still need `npm install` for `eventsource`; the harness tests don't.)
