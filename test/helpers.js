// Shared helpers for tests that run a real weft server in a child process.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer(dataDir, extraEnv = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: baseUrl, DATA_DIR: dataDir, CHROME_PATH: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d; });
  child.stderr.on("data", (d) => { logs += d; });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${logs}`);
    try { if ((await fetch(`${baseUrl}/api/projects`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`Server did not start:\n${logs}`);
    await new Promise((r) => setTimeout(r, 60));
  }
  const stop = (signal = "SIGKILL") => new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once("exit", r);
    child.kill(signal);
  });
  return { baseUrl, child, stop };
}

export const api = (base) => async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};


export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Call an MCP tool over the stateless HTTP endpoint and return the parsed JSON result (or text).
export async function mcpCall(baseUrl, name, args = {}, headers = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : raw);
  if (body.error) throw new Error(body.error.message);
  const text = body.result.content?.[0]?.text ?? "";
  if (body.result.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}
