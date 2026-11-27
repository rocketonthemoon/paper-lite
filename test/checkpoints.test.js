// Checkpoints are commits in a per-project bare git repo. These tests check that saving, listing and restoring
// work across restarts, that old JSON checkpoint files are migrated, and that real `git` accepts the repo.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { api, sleep, startServer } from "./helpers.js";

const hasGit = (() => { try { execFileSync("git", ["--version"]); return true; } catch { return false; } })();

test("checkpoints are git commits that survive restarts and restore exactly", { timeout: 60_000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-cp-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let srv = await startServer(dataDir);
  let call = api(srv.baseUrl);

  const s0 = await call("GET", "/api/state");
  const gitdir = path.join(dataDir, "projects", `${s0.id}.git`);
  const board = await call("POST", "/api/nodes", { parentId: s0.rootId, tag: "div", name: "Board" });
  for (let i = 0; i < 30; i++) await call("POST", "/api/nodes", { parentId: board.id, tag: "p", name: `Row ${i}`, text: `Row ${i}` });
  await call("PATCH", "/api/root-css", { classes: { muted: { color: "#777" } } });
  const cp = await call("POST", "/api/checkpoints", { name: "Thirty rows" });
  const saved = structuredClone(await call("GET", "/api/state"));

  // Change things, including root CSS, then make a second checkpoint that differs by one layer.
  await call("PATCH", `/api/nodes/${board.id}`, { name: "Renamed board" });
  const cp2 = await call("POST", "/api/checkpoints", { name: "Renamed" });
  await call("PATCH", "/api/root-css", { classes: { muted: null }, vars: { "--x": "1px" } });
  await call("DELETE", `/api/nodes/${board.id}`);
  await srv.stop("SIGTERM");

  srv = await startServer(dataDir);
  call = api(srv.baseUrl);
  const list = await call("GET", "/api/checkpoints");
  assert.deepEqual(list.map((c) => c.name), ["Project created", "Thirty rows", "Renamed"]);
  assert.ok(list.every((c) => /^[0-9a-f]{40}$/.test(c.commit)), "every checkpoint has a commit");
  assert.equal(list[1].id, cp.id);
  assert.equal(list[1].layerCount, 31);

  await call("POST", `/api/checkpoints/${cp.id}/restore`);
  const restored = await call("GET", "/api/state");
  assert.deepEqual(restored.nodes, saved.nodes, "layers restored exactly");
  assert.deepEqual(restored.rootCss, saved.rootCss, "root CSS restored too");
  await call("POST", "/api/undo");
  assert.equal((await call("GET", "/api/state")).nodes[board.id], undefined, "restore is one undoable step");
  await assert.rejects(call("POST", "/api/checkpoints/nope/restore"), /404/);

  if (hasGit) {
    const g = (...args) => execFileSync("git", ["--git-dir", gitdir, ...args], { encoding: "utf8" });
    g("fsck", "--strict");
    assert.equal(g("rev-list", "--count", "main").trim(), "3");
    assert.match(g("log", "-1", "--format=%B", "main"), /Weft-Checkpoint: /);
    // Only the renamed board's file changed between the two checkpoints.
    const changed = g("diff", "--name-only", `${list[1].commit}`, `${cp2.commit || list[2].commit}`).trim().split("\n");
    assert.deepEqual(changed, [`nodes/${board.id}.json`]);
  }
  await srv.stop("SIGKILL");
});

test("old JSON checkpoint files migrate into git once", { timeout: 60_000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-cpmig-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let srv = await startServer(dataDir);
  let call = api(srv.baseUrl);
  const s0 = await call("GET", "/api/state");
  const node = await call("POST", "/api/nodes", { parentId: s0.rootId, tag: "div", name: "Old layer" });
  const snap = await call("GET", "/api/state");
  await srv.stop("SIGTERM");

  // Recreate the pre-git layout: no repo, checkpoints with full snapshots in <id>.checkpoints.json.
  const projects = path.join(dataDir, "projects");
  await fs.rm(path.join(projects, `${s0.id}.git`), { recursive: true, force: true });
  const legacy = [
    { id: "legacy01", name: "Project created", auto: true, kind: "init", at: "2026-01-01T00:00:00.000Z", historyId: null, layerCount: 0, snapshot: { ...s0, comments: undefined } },
    { id: "legacy02", name: "With layer", auto: false, kind: "manual", at: "2026-01-02T00:00:00.000Z", historyId: "h1", layerCount: 1, snapshot: { ...snap, comments: undefined } },
  ];
  await fs.writeFile(path.join(projects, `${s0.id}.checkpoints.json`), JSON.stringify(legacy));

  srv = await startServer(dataDir);
  call = api(srv.baseUrl);
  const list = await call("GET", "/api/checkpoints");
  assert.deepEqual(list.map((c) => [c.id, c.name, c.kind, c.auto, c.at, c.historyId, c.layerCount]), [
    ["legacy01", "Project created", "init", true, "2026-01-01T00:00:00.000Z", null, 0],
    ["legacy02", "With layer", "manual", false, "2026-01-02T00:00:00.000Z", "h1", 1],
  ]);
  await fs.access(path.join(projects, `${s0.id}.checkpoints.json.migrated`));
  await assert.rejects(fs.access(path.join(projects, `${s0.id}.checkpoints.json`)));

  await call("DELETE", `/api/nodes/${node.id}`);
  await call("POST", "/api/checkpoints/legacy02/restore");
  assert.equal((await call("GET", "/api/state")).nodes[node.id].name, "Old layer");
  await sleep(50);
  await srv.stop("SIGKILL");
});

test("deleting a project removes its repo; duplicating starts a fresh one", { timeout: 60_000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-cpdel-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const srv = await startServer(dataDir);
  t.after(() => srv.stop("SIGKILL"));
  const call = api(srv.baseUrl);
  const s0 = await call("GET", "/api/state");
  await call("POST", "/api/checkpoints", { name: "One" });
  const copy = await call("POST", `/api/projects/${s0.id}/duplicate`, { name: "Copy" });
  await call("POST", `/api/projects/${copy.id}/open`);
  assert.deepEqual((await call("GET", "/api/checkpoints")).map((c) => c.name), ["Project created"]);
  await call("DELETE", `/api/projects/${s0.id}`);
  await assert.rejects(fs.access(path.join(dataDir, "projects", `${s0.id}.git`)));
  await fs.access(path.join(dataDir, "projects", `${copy.id}.git`, "HEAD"));
});
