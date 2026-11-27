// Undo history stores per-edit patches; disk writes are throttled. These tests jump through every history
// position after a mix of edits and check the document is exactly what it was, and that saves reach disk.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { api, startServer } from "./helpers.js";

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

test("activity sessions stay with their project when another project is created or opened", { timeout: 60_000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-sessions-"));
  const srv = await startServer(dataDir);
  t.after(async () => { await srv.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const call = api(srv.baseUrl);
  const a = await call("GET", "/api/state");
  await call("POST", "/api/nodes", { parentId: a.rootId, tag: "div", name: "Edit in A" });
  const b = await call("POST", "/api/projects", { name: "B" }); // creates and opens B
  const ids = (list) => list.map((s) => s.id);
  let sessions = (await call("GET", "/api/activity")).sessions;
  assert.equal(new Set(ids(sessions)).size, sessions.length, "no session listed twice");
  assert.deepEqual(sessions.map((s) => s.projectId), [a.id], "A's session belongs to A only");
  await call("POST", "/api/nodes", { parentId: (await call("GET", "/api/state")).rootId, tag: "div", name: "Edit in B" });
  await call("POST", `/api/projects/${a.id}/open`);
  sessions = (await call("GET", "/api/activity")).sessions;
  assert.equal(new Set(ids(sessions)).size, sessions.length, "no session listed twice after switching back");
  assert.deepEqual(sessions.map((s) => s.projectId).sort(), [a.id, b.id].sort());
});
