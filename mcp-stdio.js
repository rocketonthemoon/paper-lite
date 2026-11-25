#!/usr/bin/env node
// stdio ⇄ Streamable HTTP relay for MCP clients that only launch stdio servers (Claude Desktop, Cursor, …).
// The canvas server must already be running; this process just forwards JSON-RPC messages to its /mcp endpoint.
//   { "command": "node", "args": ["<path>/paper-lite/mcp-stdio.js"], "env": { "PAPER_LITE_URL": "http://localhost:3000/mcp" } }
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.PAPER_LITE_URL || "http://localhost:3000/mcp");
const local = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(url);

local.onmessage = (msg) => remote.send(msg).catch((err) => {
  if (msg.id !== undefined) {
    local.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `Paper-Lite unreachable at ${url}: ${err.message}` } });
  }
});
remote.onmessage = (msg) => local.send(msg);
remote.onerror = (err) => process.stderr.write(`[paper-lite stdio] ${err.message}\n`);
local.onclose = () => { remote.close(); process.exit(0); };

await remote.start();
await local.start();
