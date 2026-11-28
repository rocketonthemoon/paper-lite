#!/usr/bin/env node
// stdio ⇄ Streamable HTTP relay for MCP clients that only launch stdio servers (Claude Desktop, Cursor, …).
// The canvas server must already be running; this process just forwards JSON-RPC messages to its /mcp endpoint.
//   { "command": "node", "args": ["<path>/server/mcp-stdio.js"], "env": { "WEFT_URL": "http://localhost:3000/mcp" } }
import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.WEFT_URL || process.env.PAPER_LITE_URL || "http://localhost:3000/mcp");
const clientId = `stdio-${randomBytes(4).toString("hex")}`;
const local = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { "x-weft-client": clientId } },
});

local.onmessage = (msg) => remote.send(msg).catch((err) => {
  if (msg.id !== undefined) {
    local.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `weft unreachable at ${url}: ${err.message}` } });
  }
});
remote.onmessage = (msg) => local.send(msg);
remote.onerror = (err) => process.stderr.write(`[weft stdio] ${err.message}\n`);
local.onclose = () => { remote.close(); process.exit(0); };

await remote.start();
await local.start();
