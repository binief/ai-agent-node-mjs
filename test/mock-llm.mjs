// Mock OpenAI-compatible streaming endpoint used by the agent's end-to-end tests.
// Serves a scripted sequence of assistant turns so the real agent loop (streamChat,
// agentTurn, tool execution, plan gate) runs against deterministic model behaviour.
import http from "node:http";

export function sseChunk(delta, finish) {
  return "data: " + JSON.stringify({
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  }) + "\n\n";
}

/**
 * @param {Array<{content?: string, toolCalls?: Array<{name: string, arguments: object}>}>} turns
 *        Scripted assistant turns, consumed in order. Extra requests get the last turn.
 * @returns {{ url: string, port: number, requests: any[], close: () => Promise<void>, used: () => number }}
 */
export async function startMockLLM(turns) {
  const requests = [];
  let served = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-model", context_length: 8000 }] }));
        return;
      }
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      requests.push(payload);

      const turn = turns[Math.min(served, turns.length - 1)] || {};
      served++;

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (turn.content) {
        // stream the text in two pieces, like a real server
        const mid = Math.ceil(turn.content.length / 2);
        res.write(sseChunk({ content: turn.content.slice(0, mid) }));
        res.write(sseChunk({ content: turn.content.slice(mid) }));
      }
      (turn.toolCalls || []).forEach((tc, i) => {
        res.write(sseChunk({
          tool_calls: [{
            index: i,
            id: `call_${served}_${i}`,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }],
        }));
      });
      res.write(sseChunk({}, turn.toolCalls?.length ? "tool_calls" : "stop"));
      res.write("data: " + JSON.stringify({
        choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    used: () => served,
    close: () => new Promise(r => server.close(r)),
  };
}
