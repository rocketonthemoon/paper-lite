// MCP servers are pooled and reused across requests. Reused servers must answer correctly, in sequence and in
// parallel (more requests at once than the pool holds), and an error must not affect the next request.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { api, mcpCall, startServer } from "./helpers.js";

test("pooled MCP servers stay correct across many sequential and parallel requests", { timeout: 60_000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-pool-"));
  const srv = await startServer(dataDir);
  t.after(async () => { await srv.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const call = api(srv.baseUrl);

  const board = await mcpCall(srv.baseUrl, "create_artboard", { name: "Pool" });
  for (let i = 0; i < 20; i++) {
    await mcpCall(srv.baseUrl, "update_styles", { updates: [{ nodeIds: [board.id], styles: { opacity: String(i / 100) } }] });
    assert.equal((await mcpCall(srv.baseUrl, "get_node_info", { nodeId: board.id })).styles.opacity, String(i / 100));
  }
  // An error in one request doesn't poison the server for the next.
  await assert.rejects(mcpCall(srv.baseUrl, "get_node_info", { nodeId: "missing" }));
  assert.equal((await mcpCall(srv.baseUrl, "get_basic_info")).project.id, (await call("GET", "/api/state")).id);

  // Parallel requests from two different agents, more than the pool holds.
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) =>
    mcpCall(srv.baseUrl, "rename_nodes", { updates: [{ nodeId: board.id, name: `Agent ${i % 2} · ${i}` }] }, { "x-weft-client": `agent-${i % 2}` })));
  assert.equal(results.length, 24);
  const { entries } = await call("GET", "/api/history");
  assert.equal(entries.length, 1 + 20 + 24, "every edit recorded once");
});
