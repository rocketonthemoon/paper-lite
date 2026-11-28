// Regressions found by driving the MCP tools with odd and edge-case input.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mcpCall, startServer } from "./helpers.js";

test("MCP edge cases: instances in duplicated containers, artboard sizes and placement, override and patch typos, var loops", { timeout: 60_000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-edge-"));
  const srv = await startServer(dataDir);
  t.after(() => srv.stop());
  const call = (name, args) => mcpCall(srv.baseUrl, name, args);
  const state = async () => (await fetch(`${srv.baseUrl}/api/state`)).json();

  await t.test("artboard sizes must be positive and sane; keywords still pass", async () => {
    for (const width of [-5, 0, "0px", 1e9]) await assert.rejects(call("create_artboard", { width }), /between 1 and/);
    const ok = await call("create_artboard", { name: "Fluid", width: "100%", height: "fit-content" });
    await call("delete_nodes", { nodeIds: [ok.id] });
  });

  const a = await call("create_artboard", { name: "A", width: 400, height: 400, x: 0, y: 0 });
  const b = await call("create_artboard", { name: "B", width: 400, height: 400, x: 480, y: 0 });
  await call("create_component", { name: "chip", html: `<div data-name="Chip"><span data-slot="label">Default</span></div>` });

  await t.test("an override key that matches no slot is reported", async () => {
    const res = await call("instantiate_component", { component: "chip", parentId: a.id, overrides: { label: "Mine", nope: "x" } });
    assert.ok(res.warnings?.some((w) => /"nope" matches no slot/.test(w)), JSON.stringify(res));
  });

  await t.test("a duplicated artboard's instances keep their overrides through update_component", async () => {
    const [copy] = await call("duplicate_nodes", { nodeIds: [a.id] });
    await call("update_component", { component: "chip", slot: "root", patch: { styles: { padding: "4px" } } });
    const s = await state();
    const inst = s.nodes[s.nodes[copy.id].children[0]];
    assert.equal(s.nodes[inst.children[0]].text, "Mine");
    assert.equal(inst.styles.padding, "4px");
    // The copy went to a free spot instead of on top of B, which sits right of A.
    const left = parseFloat(s.nodes[copy.id].styles.left);
    assert.ok(left >= 480 + 400, `copy at ${left} overlaps B`);
    assert.ok(s.nodes[b.id]);
  });

  await t.test("update_component refuses no-ops and misshapen patch / appendHtml", async () => {
    await assert.rejects(call("update_component", { component: "chip" }), /Nothing to update/);
    await assert.rejects(call("update_component", { component: "chip", patch: { label: { styles: { color: "red" } } } }), /Unknown argument "label"/);
    await assert.rejects(call("update_component", { component: "chip", appendHtml: { slot: "label", html: "<b>x</b>" } }), /Unknown argument "slot"/);
  });

  await t.test("unknown or misspelled arguments are refused with a suggestion, top level and nested", async () => {
    await assert.rejects(call("update_node", { nodeId: a.id, style: { color: "red" } }), /Unknown argument "style" \(did you mean "styles"\?\)/);
    await assert.rejects(call("update_styles", { updates: [{ nodeIds: [a.id], styles: {}, lint: false }] }), /Unknown argument "lint"/);
    await assert.rejects(call("update_node", { nodeId: a.id }), /Nothing to update/);
  });

  await t.test("void tags hold no text; delete_nodes checks every id", async () => {
    await assert.rejects(call("create_node", { parentId: a.id, tag: "img", text: "x" }), /can't hold text/);
    const n = await call("create_node", { parentId: a.id, name: "T", text: "words" });
    await call("update_node", { nodeId: n.id, tag: "img" });
    assert.equal((await state()).nodes[n.id].text, "");
    await assert.rejects(call("delete_nodes", { nodeIds: [n.id, "nope"] }), /"nope" not found; nothing was deleted/);
    assert.ok((await state()).nodes[n.id]);
    await call("delete_nodes", { nodeIds: [n.id] });
  });

  await t.test("control characters are stripped from text; names also lose bidi overrides", async () => {
    const n = await call("create_node", { parentId: a.id, tag: "p", name: "Na\u202eme\u0000", text: "a\u0000b\u001bc \u202ertl" });
    const node = (await state()).nodes[n.id];
    assert.equal(node.name, "Name");
    assert.equal(node.text, "abc \u202ertl");
    await call("delete_nodes", { nodeIds: [n.id] });
  });

  await t.test("data-slot from write_html names the slot of a component made from those layers", async () => {
    const w = await call("write_html", { parentId: a.id, html: `<div data-name="Card"><h3 data-slot="title">T</h3></div>` });
    const comp = await call("create_component", { name: "card-from-node", nodeId: w.created[0].id });
    assert.ok(comp.slots.some((sl) => sl.slot === "title" && sl.key === "title"), JSON.stringify(comp.slots));
  });

  await t.test("lint hints only cover the styles a call set; @import gets a plain error", async () => {
    await call("update_root_css", { vars: { "--color-primary": "#0000ff", "--space-4": "16px" } });
    const res = await call("update_nodes_matching", { artboardIds: [a.id], styles: { padding: "16px" } });
    assert.ok(res.hints?.length && res.hints.every((h) => /padding/.test(h)), JSON.stringify(res.hints));
    await assert.rejects(call("update_root_css", { css: "@import url(https://example.com/x.css);" }), /@import isn't supported/);
  });

  await t.test("a layer moved onto the page goes to a free spot", async () => {
    const kid = await call("create_node", { parentId: a.id, name: "Kid", styles: { width: "50px", height: "50px" } });
    await call("move_nodes", { nodeIds: [kid.id], parentId: (await state()).rootId });
    const s = await state();
    const right = Math.max(...s.nodes[s.rootId].children.filter((id) => id !== kid.id).map((id) => parseFloat(s.nodes[id].styles.left) + parseFloat(s.nodes[id].styles.width)));
    assert.ok(parseFloat(s.nodes[kid.id].styles.left) >= right, `Kid at ${s.nodes[kid.id].styles.left}`);
  });

  await t.test("agent ergonomics: names for ids, unitless lengths, unknown CSS properties, layer-named hints", async () => {
    await assert.rejects(call("get_node_info", { nodeId: "a" }), /did you mean layer "A" \(/);
    const page = (await state()).rootId;
    await assert.rejects(call("switch_page", { pageId: a.id }), new RegExp(`that's a layer, not a page; its page is ${page}`));
    await assert.rejects(call("instantiate_component", { component: "CHIP", parentId: a.id }), /Ids are case-sensitive: did you mean component "chip"/);
    const n = await call("create_node", { parentId: a.id, name: "Typo", styles: { width: "120", colour: "red" } });
    assert.equal((await state()).nodes[n.id].styles.width, "120px", "a bare number string for a length becomes px");
    assert.ok(n.hints.some((h) => h.startsWith(`Typo (${n.id}): colour isn't a CSS property`) && h.includes("did you mean color?")), JSON.stringify(n.hints));
    await call("update_styles", { updates: [{ nodeIds: [n.id], styles: { lineHeight: "1.5", flex: "1" } }] });
    const st = (await state()).nodes[n.id].styles;
    assert.equal(st.lineHeight, "1.5");
    assert.equal(st.flex, "1");
    await call("delete_nodes", { nodeIds: [n.id] });
  });

  await t.test("big results are capped and say so", async () => {
    const box = await call("create_node", { parentId: a.id, name: "Box" });
    const w = await call("write_html", { parentId: box.id, html: Array.from({ length: 120 }, (_, i) => `<span>r${i}</span>`).join("") });
    assert.equal(w.created.length, 50);
    assert.equal(w.createdTotal, 120);
    const kids = await call("get_children", { nodeId: box.id, limit: 100 });
    assert.equal(kids.total, 120);
    assert.equal(kids.nextOffset, 100);
    const rest = await call("get_children", { nodeId: box.id, offset: 100 });
    assert.equal(rest.children.length, 20);
    assert.equal(rest.nextOffset, undefined);
    const info = await call("get_node_info", { nodeId: box.id });
    assert.equal(info.children.length, 50);
    assert.equal(info.childrenTotal, 120);
    const tree = await call("get_tree_summary", { nodeId: box.id });
    assert.match(tree, /… 80 more children of Box/);
    const found = await call("find_nodes", { query: "r1", limit: 5 });
    assert.equal(found.more, true);
    assert.deepEqual(found.nodes.map((x) => x.text), ["r1", "r10", "r11", "r12", "r13"], "document order");
    await call("delete_nodes", { nodeIds: [box.id] });
  });

  await t.test("agent undo never discards a user's edit unless asked", async () => {
    const n = await call("create_node", { parentId: a.id, name: "Mine" });
    const res = await fetch(`${srv.baseUrl}/api/nodes/${n.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ styles: { color: "green" } }) });
    assert.equal(res.status, 200);
    await assert.rejects(call("undo"), /made by the user .*nothing was done/);
    assert.equal((await state()).nodes[n.id].styles.color, "green", "the user's edit is still there");
    const forced = await call("undo", { includeUserEdits: true });
    assert.equal(forced.step.by, "user");
    assert.equal((await state()).nodes[n.id].styles.color, undefined);
    await assert.rejects(call("redo"), /made by the user/);
    assert.equal((await call("redo", { includeUserEdits: true })).redone, true);
    await call("delete_nodes", { nodeIds: [n.id] });
    const mine = await call("undo");
    assert.equal(mine.step.by, "agent");
    assert.match(mine.step.label, /delete/i);
  });

  await t.test("small result accuracy: move counts, copy names, import gaps, long replies", async () => {
    const n = await call("create_node", { parentId: a.id, name: "Twice" });
    assert.equal((await call("move_nodes", { nodeIds: [n.id, n.id], parentId: a.id })).moved, 1);
    await call("delete_nodes", { nodeIds: [n.id] });

    const open = (await call("list_projects")).find((p) => p.active);
    const c1 = await call("duplicate_project", { projectId: open.id });
    const c2 = await call("duplicate_project", { projectId: open.id });
    assert.equal(c2.name, `${c1.name} 2`, "a second copy gets a distinct name");
    await call("update_root_css", { classes: { tile: { padding: "2px" } } });
    const other = await call("create_project", { name: "Importer" });
    const imp = await call("import_root_css", { sourceProjectId: open.id, classes: ["tile", "ghost"] });
    assert.deepEqual(imp.notInSource, ["ghost"]);
    await assert.rejects(call("import_root_css", { sourceProjectId: other.id }), /is the open project/);
    await call("open_project", { projectId: open.id });
    for (const id of [c1.id, c2.id, other.id]) await call("delete_project", { projectId: id });

    const res = await fetch(`${srv.baseUrl}/api/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: a.id, text: "Long?" }) });
    const thread = await res.json();
    const reply = await call("reply_to_comment", { id: thread.id, text: "y".repeat(5000) });
    assert.match(reply.truncated, /cut to 4000 of 5000/);
  });

  await t.test("update_root_css warns about var() loops", async () => {
    const res = await call("update_root_css", { vars: { "--x": "var(--y)", "--y": "var(--x)", "--fine": "var(--x)" } });
    assert.ok(res.warnings.some((w) => w.includes("--x → --y → --x")), JSON.stringify(res.warnings));
    assert.ok(!res.warnings.some((w) => w.includes("--fine →")));
  });
});
