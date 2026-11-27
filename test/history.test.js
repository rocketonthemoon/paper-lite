// Undo history stores per-edit patches; disk writes are throttled. These tests jump through every history
// position after a mix of edits and check the document is exactly what it was, and that saves reach disk.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
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

async function startServer(dataDir, extraEnv = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
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

const api = (base) => async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

// The parts of the document undo is responsible for. Node order in the map doesn't matter (children arrays do).
const docOf = (s) => JSON.stringify({
  pages: s.pages,
  nodes: Object.fromEntries(Object.keys(s.nodes).sort().map((k) => [k, s.nodes[k]])),
  rootCss: s.rootCss,
});

test("undo history: jumping to any position restores that exact document", { timeout: 60_000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-hist-"));
  const srv = await startServer(dataDir);
  t.after(async () => { await srv.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const call = api(srv.baseUrl);

  const snapshots = [docOf(await call("GET", "/api/state"))]; // index 0 = before any edit (cursor -1)
  const page1 = (await call("GET", "/api/state")).rootId;
  const step = async (fn) => { const r = await fn(); snapshots.push(docOf(await call("GET", "/api/state"))); return r; };

  const board = await step(() => call("POST", "/api/nodes", { parentId: page1, tag: "div", name: "Board" }));
  const card = await step(() => call("POST", "/api/nodes", { parentId: board.id, tag: "div", name: "Card", styles: { padding: "8px" } }));
  const label = await step(() => call("POST", "/api/nodes", { parentId: card.id, tag: "p", name: "Label", text: "Hi" }));
  await step(() => call("PATCH", `/api/nodes/${label.id}`, { text: "Hello", styles: { color: "#333" } }));
  await step(() => call("PATCH", `/api/root-css`, { vars: { "--accent": "#f60" }, classes: { pill: { borderRadius: "999px" } } }));
  await step(() => call("PATCH", `/api/nodes/${card.id}`, { classes: ["pill"], name: "Pill card" }));
  const dup = await step(() => call("POST", `/api/nodes/${card.id}/duplicate`));
  await step(() => call("PATCH", `/api/nodes/${label.id}`, { parentId: board.id, index: 0 }));
  await step(() => call("POST", "/api/pages", { name: "Second" }));
  await step(() => call("DELETE", `/api/nodes/${dup.id}`));
  await step(() => call("PATCH", `/api/root-css`, { classes: { pill: null } })); // also strips the class from layers

  const { entries } = await call("GET", "/api/history");
  assert.equal(entries.length, snapshots.length - 1, "one history entry per edit");
  assert.ok(entries.every((e) => !("patch" in e) && !("before" in e)), "history payload does not leak patches");

  // Visit positions out of order so both directions and multi-step jumps are exercised.
  const order = [-1, 5, 2, entries.length - 1, 0, 7, 3, -1, entries.length - 1];
  for (const idx of order) {
    await call("POST", "/api/history/jump", { index: idx });
    assert.equal(docOf(await call("GET", "/api/state")), snapshots[idx + 1], `document at history index ${idx}`);
  }

  // Single steps back and forward.
  for (let i = entries.length - 1; i >= 0; i--) {
    await call("POST", "/api/undo");
    assert.equal(docOf(await call("GET", "/api/state")), snapshots[i], `after undo to ${i - 1}`);
  }
  assert.equal((await call("POST", "/api/undo")).ok, false, "nothing left to undo");
  for (let i = 1; i < snapshots.length; i++) {
    await call("POST", "/api/redo");
    assert.equal(docOf(await call("GET", "/api/state")), snapshots[i], `after redo to ${i - 1}`);
  }

  // A rejected edit leaves no trace: same document, no new entry.
  const beforeBad = docOf(await call("GET", "/api/state"));
  await assert.rejects(call("PATCH", `/api/nodes/${board.id}`, { parentId: label.id }));
  assert.equal(docOf(await call("GET", "/api/state")), beforeBad);
  assert.equal((await call("GET", "/api/history")).entries.length, entries.length);

  // Replacing the whole document is one undoable step too.
  const cur = await call("GET", "/api/state");
  const replaced = structuredClone(cur);
  replaced.nodes[board.id].name = "Replaced board";
  await call("POST", "/api/state", replaced);
  assert.equal((await call("GET", "/api/state")).nodes[board.id].name, "Replaced board");
  await call("POST", "/api/undo");
  assert.equal(docOf(await call("GET", "/api/state")), docOf(cur));
});

test("throttled saves reach disk, and pending saves are flushed on shutdown", { timeout: 60_000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-persist-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const readDoc = async (id) => JSON.parse(await fs.readFile(path.join(dataDir, "projects", `${id}.json`), "utf8"));

  // Normal throttle: a burst of edits lands on disk shortly after.
  let srv = await startServer(dataDir, { PERSIST_THROTTLE_MS: "150" });
  let call = api(srv.baseUrl);
  const s0 = await call("GET", "/api/state");
  const node = await call("POST", "/api/nodes", { parentId: s0.rootId, tag: "div", name: "Burst" });
  for (let i = 0; i < 20; i++) await call("PATCH", `/api/nodes/${node.id}`, { name: `Burst ${i}` });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await readDoc(s0.id)).nodes[node.id].name, "Burst 19");
  await srv.stop("SIGKILL");

  // Long throttle: only the shutdown flush can have written the edit.
  srv = await startServer(dataDir, { PERSIST_THROTTLE_MS: "60000" });
  call = api(srv.baseUrl);
  await call("PATCH", `/api/nodes/${node.id}`, { name: "Saved on exit" });
  assert.equal((await readDoc(s0.id)).nodes[node.id].name, "Burst 19", "not written yet");
  await srv.stop("SIGTERM");
  assert.equal((await readDoc(s0.id)).nodes[node.id].name, "Saved on exit");

  // Switching project writes the previous one first.
  srv = await startServer(dataDir, { PERSIST_THROTTLE_MS: "60000" });
  call = api(srv.baseUrl);
  await call("PATCH", `/api/nodes/${node.id}`, { name: "Saved on switch" });
  const other = await call("POST", "/api/projects", { name: "Other" });
  if ((await call("GET", "/api/state")).id !== other.id) await call("POST", `/api/projects/${other.id}/open`);
  assert.equal((await readDoc(s0.id)).nodes[node.id].name, "Saved on switch");
  await srv.stop("SIGKILL");
});
