// Fuzz the agent undo / redo / session revert against interleaved edits by two agents and the user, checking after
// every step that the document stays consistent (no orphans, child lists match parentId, no duplicates).
// Starts its own server on a temporary data folder:
//   npm run fuzz:undo                      (seeds 1-5, 200 operations each)
//   SEEDS=1,2,3 N=500 npm run fuzz:undo
// Exits non-zero on the first broken invariant or server error, printing the seed and operation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../test/helpers.js";

const SEEDS = (process.env.SEEDS || "1,2,3,4,5").split(",").map(Number);
const N = Number(process.env.N || 200);
let failed = false;

for (const SEED of SEEDS) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-fuzz-"));
  const srv = await startServer(dataDir);
  try {
    const result = await run(srv.baseUrl, SEED);
    console.log(`seed ${SEED}: ${result.ok ? "ok" : "FAILED"} (${N} operations)`);
    if (!result.ok) failed = true;
  } finally {
    await srv.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
  if (failed) break;
}
process.exit(failed ? 1 : 0);

async function run(B, seedIn) {
let seed = seedIn;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const log = []; // every call, so a failure can show what led to it (VERBOSE)
const call = async (client, name, args = {}) => { log.push(`${client} ${name} ${JSON.stringify(args)}`); const r = await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-weft-client": client }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }); if (r.status >= 500) throw new Error(`server error ${r.status} on ${name}`); const t = await r.text(); const l = t.split(/\r?\n/).find((x) => x.startsWith("data: ")); const b = JSON.parse(l.slice(6)); const tx = b.result.content[0].text; if (b.result.isError) return { ERR: tx }; try { return JSON.parse(tx); } catch { return tx; } };
const rest = (m, u, body) => (log.push(`user ${m} ${u} ${JSON.stringify(body || {})}`), fetch)(B + u, { method: m, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) }).then(async (r) => { if (r.status >= 500) throw new Error(`server error ${r.status} on ${m} ${u}`); return { status: r.status, body: await r.json().catch(() => null) }; });
const st = async () => (await fetch(B + "/api/state")).json();
function check(s, ctx) {
  const errs = [];
  for (const pid of s.pages) if (!s.nodes[pid]) errs.push(`page ${pid} missing`);
  for (const [id, n] of Object.entries(s.nodes)) {
    if (s.pages.includes(id)) continue;
    const p = s.nodes[n.parentId];
    if (!p) errs.push(`${id} orphan (parent ${n.parentId})`);
    else if (!p.children.includes(id)) errs.push(`${id} not in parent ${n.parentId}.children`);
    for (const c of n.children) { if (!s.nodes[c]) errs.push(`${id}.children has missing ${c}`); else if (s.nodes[c].parentId !== id) errs.push(`${id}.children has ${c} whose parent is ${s.nodes[c].parentId}`); }
    if (new Set(n.children).size !== n.children.length) errs.push(`${id} duplicate children`);
    if (n.componentId && !s.components?.[n.componentId]) errs.push(`${id} links to missing component ${n.componentId}`);
    if (n.componentRootId && s.nodes[n.componentRootId]?.componentId !== n.componentId) errs.push(`${id} links to missing instance root ${n.componentRootId}`);
  }
  if (!s.pages.includes(s.rootId)) errs.push(`current page ${s.rootId} isn't a page`);
  if (errs.length) {
    console.log(`  invariant broken after ${ctx}:`, errs.slice(0, 5));
    if (process.env.VERBOSE) console.log("  last calls:\n    " + log.slice(-12).join("\n    "));
    return false;
  }
  return true;
}
const ab = await call("A", "create_artboard", { name: "Fuzz", width: 800, height: 800 });
const actors = ["A", "B", "user"];
let ok = true, stats = {};
for (let i = 0; i < N && ok; i++) {
  const s = await st();
  // Sorted by name: ids are random, and numeric-looking ones change object key order, which would make seeds differ.
  const layers = Object.values(s.nodes).filter((n) => !s.pages.includes(n.id) && !s.pages.includes(n.parentId) && s.nodes[n.parentId])
    .sort((x, y) => (x.name + x.tag + x.text).localeCompare(y.name + y.tag + y.text));
  const containers = [ab.id, ...layers.filter((n) => n.tag === "div").map((n) => n.id)].filter((id) => s.nodes[id]);
  if (!containers.length) { const nb = await call("A", "create_artboard", { name: "Fuzz again", width: 400, height: 400 }); containers.push(nb.id); }
  const who = pick(actors);
  const op = pick(["create", "create", "style", "rename", "move", "delete", "dup", "undo", "undo", "redo", "text",
    "page", "page-delete", "page-switch", "css", "component", "instance", "comp-update", "replace"]);
  const target = layers.length ? pick(layers).id : null;
  let r;
  if (who === "user") {
    if (op === "create") r = await rest("POST", "/api/nodes", { parentId: pick(containers), name: "u" + i, tag: pick(["div", "p"]) });
    else if (op === "style" && target) r = await rest("PATCH", `/api/nodes/${target}`, { styles: { color: pick(["red", "blue", "green"]), padding: pick(["1px", "2px"]) } });
    else if (op === "rename" && target) r = await rest("PATCH", `/api/nodes/${target}`, { name: "U" + i });
    else if (op === "move" && target) r = await rest("PATCH", `/api/nodes/${target}`, { parentId: pick(containers), index: Math.floor(rnd() * 3) });
    else if (op === "delete" && target) r = await rest("DELETE", `/api/nodes/${target}`);
    else continue;
  } else {
    if (op === "create") r = await call(who, "write_html", { parentId: pick(containers), html: `<div data-name="${who}${i}"><p>t${i}</p></div>` });
    else if (op === "style" && target) r = await call(who, "update_styles", { updates: [{ nodeIds: [target], styles: { color: pick(["red", "blue"]), margin: pick(["3px", "4px"]) } }] });
    else if (op === "rename" && target) r = await call(who, "rename_nodes", { updates: [{ nodeId: target, name: who + "n" + i }] });
    else if (op === "move" && target) r = await call(who, "move_nodes", { nodeIds: [target], parentId: pick(containers), index: Math.floor(rnd() * 3) });
    else if (op === "delete" && target) r = await call(who, "delete_nodes", { nodeIds: [target] });
    else if (op === "dup" && target) r = await call(who, "duplicate_nodes", { nodeIds: [target] });
    else if (op === "text" && target) r = await call(who, "set_text_content", { updates: [{ nodeId: target, text: "x" + i }] });
    else if (op === "page") r = await call(who, "create_page", { name: who + "p" + i });
    else if (op === "page-delete" && s.pages.length > 1) r = await call(who, "delete_page", { pageId: pick(s.pages.filter((p) => p !== s.rootId).sort((x, y) => s.nodes[x].name.localeCompare(s.nodes[y].name))) });
    else if (op === "page-switch") r = await call(who, "switch_page", { pageId: pick([...s.pages].sort((x, y) => s.nodes[x].name.localeCompare(s.nodes[y].name))) });
    else if (op === "css") r = await call(who, "update_root_css", { vars: { [pick(["--a", "--b", "--c"])]: pick(["1px", "2px", "#fff"]) }, classes: { [pick(["card", "tile"])]: { padding: pick(["4px", "8px"]) } } });
    else if (op === "component" && target && s.nodes[target]?.tag === "div") r = await call(who, "create_component", { name: pick(["c1", "c2"]), nodeId: target, overwrite: true });
    else if (op === "instance" && Object.keys(s.components || {}).length) r = await call(who, "instantiate_component", { component: pick(Object.keys(s.components).sort()), parentId: pick(containers), overrides: { root: { name: "inst" + i } } });
    else if (op === "comp-update" && Object.keys(s.components || {}).length) r = await call(who, "update_component", { component: pick(Object.keys(s.components).sort()), patch: { styles: { color: pick(["red", "blue"]) } } });
    else if (op === "replace" && target && s.nodes[target]?.parentId !== s.rootId) r = await call(who, "write_html", { targetNodeId: target, mode: "replace", html: `<section data-name="r${i}"><span>r</span></section>` });
    else if (op === "undo") r = await call(who, "undo");
    else if (op === "redo") r = await call(who, "redo");
    else continue;
  }
  const key = `${who}:${op}:${r?.ERR ? "err" : (r?.status && r.status >= 400) ? "http" + r.status : r?.mode || "ok"}`;
  stats[key] = (stats[key] || 0) + 1;
  if (r?.ERR && !/not found|can't|cannot|inside itself|Nothing|must be inside|isn't|not allowed/i.test(r.ERR)) { console.log("  unexpected error", who, op, r.ERR.slice(0, 160)); ok = false; }
  ok = check(await st(), `${i} ${who} ${op} ${JSON.stringify(r).slice(0, process.env.VERBOSE ? 2000 : 200)}`);
}
// session reverts at the end
const act = await (await fetch(B + "/api/activity")).json();
for (const sess of act.sessions.filter((x) => x.source === "mcp")) {
  const r = await rest("POST", `/api/activity/${sess.id}/revert`, {});
  stats[`revert-session:${r.status}`] = (stats[`revert-session:${r.status}`] || 0) + 1;
  ok = check(await st(), `session revert ${sess.agentName}`) && ok;
}
if (process.env.VERBOSE) console.log(JSON.stringify(stats));
return { ok };
}
