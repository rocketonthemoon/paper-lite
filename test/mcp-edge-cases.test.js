// Regressions found by driving the MCP tools with odd and edge-case input.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

  await t.test("agent undo takes back only its own step and keeps the user's later edit", async () => {
    const n = await call("create_node", { parentId: a.id, name: "Mine", styles: { width: "40px" } });
    await call("update_styles", { updates: [{ nodeIds: [n.id], styles: { width: "80px", color: "red" } }] });
    const res = await fetch(`${srv.baseUrl}/api/nodes/${n.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ styles: { color: "green" } }) });
    assert.equal(res.status, 200);
    const undone = await call("undo");
    assert.equal(undone.mode, "selective");
    assert.equal(undone.step.by, "agent");
    assert.deepEqual(undone.kept.map((k) => [k.layer, k.fields, k.editedBy]), [["Mine", ["styles.color"], ["you"]]]);
    let st = (await state()).nodes[n.id].styles;
    assert.equal(st.width, "40px", "the agent's own change is taken back");
    assert.equal(st.color, "green", "the user's later edit is kept");
    const redone = await call("redo");
    assert.equal(redone.redone, true);
    st = (await state()).nodes[n.id].styles;
    assert.equal(st.width, "80px");
    assert.equal(st.color, "green");
    // Only when asked, and only when the user's step is the latest, does the agent move the user's step.
    const forced = await call("undo", { includeUserEdits: true });
    assert.equal(forced.step.by, "agent", "the latest step is the agent's redo, so this is still its own");
    await call("delete_nodes", { nodeIds: [n.id] });
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

  await t.test("a copy of a layer inside an instance is a plain layer, so update_component keeps both", async () => {
    await call("create_component", { name: "pair", html: `<div data-name="Pair"><h3 data-slot="title">T</h3><p data-slot="body">B</p></div>` });
    const inst = await call("instantiate_component", { component: "pair", parentId: a.id, overrides: { title: "Mine" } });
    const title = (await state()).nodes[inst.id].children[0];
    const [copy] = await call("duplicate_nodes", { nodeIds: [title] });
    let s = await state();
    assert.equal(s.nodes[copy.id].componentKey, undefined, "the copy doesn't claim the slot");
    await call("update_styles", { updates: [{ nodeIds: [copy.id], styles: { color: "red" } }] });
    await call("update_component", { component: "pair", slot: "title", patch: { styles: { fontSize: "30px" } } });
    s = await state();
    assert.ok(s.nodes[title], "the original title layer survives");
    assert.equal(s.nodes[title].text, "Mine");
    assert.equal(s.nodes[title].styles.fontSize, "30px");
    assert.ok(s.nodes[copy.id] && s.nodes[inst.id].children.includes(copy.id), "the copy stays in the instance");
    assert.equal(s.nodes[copy.id].styles.color, "red");
    await call("delete_nodes", { nodeIds: [inst.id] });
  });

  await t.test("update_nodes_matching lists ids in document order", async () => {
    const box = await call("create_node", { parentId: a.id, name: "Ordered" });
    const w = await call("write_html", { parentId: box.id, html: Array.from({ length: 8 }, (_, i) => `<em data-name="o${i}">o</em>`).join("") });
    const res = await call("update_nodes_matching", { artboardIds: [a.id], tag: "em", styles: { color: "blue" } });
    assert.deepEqual(res.nodeIds, w.created.map((c) => c.id));
    await call("delete_nodes", { nodeIds: [box.id] });
  });

  await t.test("a layer moved onto the page gets artboard fill and clipping unless it has its own", async () => {
    const plain = await call("create_node", { parentId: a.id, name: "Plain", styles: { width: "40px", height: "40px" } });
    const own = await call("create_node", { parentId: a.id, name: "Own", styles: { width: "40px", height: "40px", backgroundColor: "#ff0000", overflow: "visible" } });
    await call("move_nodes", { nodeIds: [plain.id, own.id], parentId: (await state()).rootId });
    const s = await state();
    assert.equal(s.nodes[plain.id].styles.backgroundColor, "#ffffff");
    assert.equal(s.nodes[plain.id].styles.overflow, "hidden");
    assert.equal(s.nodes[own.id].styles.backgroundColor, "#ff0000");
    assert.equal(s.nodes[own.id].styles.overflow, "visible");
    await call("delete_nodes", { nodeIds: [plain.id, own.id] });
  });

  await t.test("an agent's reply keeps a resolved thread resolved unless it reopens it", async () => {
    const thread = await (await fetch(`${srv.baseUrl}/api/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: a.id, text: "Fix spacing" }) })).json();
    await call("resolve_comment", { id: thread.id });
    const kept = await call("reply_to_comment", { id: thread.id, text: "FYI: also aligned the icon" });
    assert.equal(kept.status, "resolved");
    assert.match(kept.note, /stays resolved/);
    const reopened = await call("reply_to_comment", { id: thread.id, text: "Actually one more thing", reopen: true });
    assert.equal(reopened.status, "replied");
  });

  await t.test("two agents at once: each undoes only its own step and never clears the other's outlines", async () => {
    const as = (client) => (name, args) => mcpCall(srv.baseUrl, name, args, { "x-weft-client": client });
    const A = as("agent-a"), B = as("agent-b");
    const mineA = await A("create_node", { parentId: a.id, name: "From A" });
    const mineB = await B("create_node", { parentId: a.id, name: "From B" });
    const undoneA = await A("undo");
    assert.equal(undoneA.mode, "selective");
    let s = await state();
    assert.ok(!s.nodes[mineA.id], "A's own layer is taken back");
    assert.ok(s.nodes[mineB.id], "B's layer stays");
    assert.equal((await A("redo")).redone, true);
    s = await state();
    assert.ok(s.nodes[mineA.id] && s.nodes[mineB.id]);
    assert.deepEqual(s.nodes[a.id].children.filter((c) => [mineA.id, mineB.id].includes(c)), [mineA.id, mineB.id], "redo puts A's layer back in its place");

    await A("update_styles", { updates: [{ nodeIds: [mineA.id], styles: { color: "red" } }] });
    await B("update_styles", { updates: [{ nodeIds: [mineB.id], styles: { color: "blue" } }] });
    await B("finish_working_on_nodes", {});
    const working = (await A("get_basic_info")).agentWorkingOn;
    assert.ok(working.includes(mineA.id), "A's outline survives B finishing");
    assert.ok(!working.includes(mineB.id), "B's outline is gone");
    await A("finish_working_on_nodes", {});
    await A("delete_nodes", { nodeIds: [mineA.id, mineB.id] });
  });


  await t.test("each MCP connection is its own agent: session id, color, name and outline color", async () => {
    // Same client name and User-Agent, like two Claude Code windows: before, these were one agent.
    const connect = async () => {
      const client = new Client({ name: "claude-code", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(`${srv.baseUrl}/mcp`));
      await client.connect(transport);
      return { client, transport };
    };
    const [one, two] = [await connect(), await connect()];
    try {
      assert.match(one.transport.sessionId, /^weft-/);
      assert.notEqual(one.transport.sessionId, two.transport.sessionId);
      const tool = async (c, name, args) => JSON.parse((await c.client.callTool({ name, arguments: args })).content[0].text);
      const x = await tool(one, "create_node", { parentId: a.id, name: "One" });
      const y = await tool(two, "create_node", { parentId: a.id, name: "Two" });

      const ctl = new AbortController();
      const res = await fetch(`${srv.baseUrl}/events`, { signal: ctl.signal });
      const reader = res.body.getReader();
      let buf = "";
      while (!/event: presence\ndata: .*\n/.test(buf)) buf += new TextDecoder().decode((await reader.read()).value);
      ctl.abort();
      const presence = JSON.parse(/event: presence\ndata: (.*)\n/.exec(buf)[1]);
      const cursorOne = presence.agents.find((c) => c.nodeIds.includes(x.id));
      const cursorTwo = presence.agents.find((c) => c.nodeIds.includes(y.id));
      assert.notEqual(cursorOne.color, cursorTwo.color, "different colors");
      assert.notEqual(cursorOne.name, cursorTwo.name, "different labels (Claude, Claude 2)");
      assert.equal(presence.nodes.find((n) => n.id === x.id).color, cursorOne.color, "outline in the agent's color");
      const undo = JSON.parse((await one.client.callTool({ name: "undo", arguments: {} })).content[0].text);
      assert.equal(undo.mode, "selective", "the other connection edited later, so only this one's own step goes");
      const after = await state();
      assert.ok(!after.nodes[x.id] && after.nodes[y.id], "separate agents never undo each other");
      await tool(one, "redo", {});
      await tool(one, "delete_nodes", { nodeIds: [x.id, y.id] });
    } finally {
      for (const c of [one, two]) { await c.transport.terminateSession().catch(() => {}); await c.client.close(); }
    }
  });

  await t.test("activity: one session per agent; reverting a session takes back only its own changes", async () => {
    const as = (client) => (name, args) => mcpCall(srv.baseUrl, name, args, { "x-weft-client": client });
    const A = as("act-a"), B = as("act-b");
    await A("set_session_title", { text: "A: header pass" });
    const na = await A("create_node", { parentId: a.id, name: "Header (A)" });
    await B("set_session_title", { text: "B: footer pass" });
    const nb = await B("create_node", { parentId: a.id, name: "Footer (B)" });
    await A("update_styles", { updates: [{ nodeIds: [na.id, nb.id], styles: { color: "red" } }] });
    await B("update_styles", { updates: [{ nodeIds: [nb.id], styles: { color: "blue" } }] });
    const { sessions } = await (await fetch(`${srv.baseUrl}/api/activity`)).json();
    const sa = sessions.find((x) => x.title === "A: header pass");
    const sb = sessions.find((x) => x.title === "B: footer pass");
    assert.ok(sa && sb && sa.id !== sb.id, "two sessions, each keeping its own title");
    assert.equal(sa.editCount, 2);
    assert.ok(sa.checkpointId && sb.checkpointId, "each agent's run has a checkpoint to restore");

    const post = (body) => fetch(`${srv.baseUrl}/api/activity/${sa.id}/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const res = await post({});
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.mode, "own");
    const keptB = out.kept.find((k) => k.id === nb.id);
    assert.deepEqual(keptB?.fields, ["styles.color"], "B's later color on its own layer is kept and reported");
    assert.equal(keptB.editedBy.length, 1);
    let s = await state();
    assert.ok(!s.nodes[na.id], "A's layer is gone");
    assert.ok(s.nodes[nb.id], "B's layer stays");
    assert.equal(s.nodes[nb.id].styles.color, "blue");
    // Restoring the whole project instead still asks first when others worked since.
    const refused = await fetch(`${srv.baseUrl}/api/activity/${sb.id}/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "restore" }) });
    assert.equal(refused.status, 409);
    assert.ok((await refused.json()).othersEdits >= 1);
    s = await state();
    assert.ok(s.nodes[nb.id], "a refused restore changes nothing");
    await call("delete_nodes", { nodeIds: [nb.id] });
  });

  await t.test("restore_checkpoint over MCP refuses to discard others' later work unless forced", async () => {
    const cp = await call("save_checkpoint", { name: "guard" });
    const n = await call("create_node", { parentId: a.id, name: "Guarded" });
    await fetch(`${srv.baseUrl}/api/nodes/${n.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "User touched" }) });
    await assert.rejects(call("restore_checkpoint", { id: cp.id }), /discard 1 later edit by you/);
    assert.ok((await state()).nodes[n.id]);
    await call("restore_checkpoint", { id: cp.id, force: true });
    assert.ok(!(await state()).nodes[n.id]);
  });


  await t.test("components: a layer moved out of an instance detaches; layers inside removed parts move up, not orphaned", async () => {
    const consistent = (st) => Object.entries(st.nodes).every(([id, n]) => (st.pages.includes(id) || (st.nodes[n.parentId]?.children.includes(id))) && n.children.every((c) => st.nodes[c]?.parentId === id));
    await call("create_component", { name: "moveout", html: `<div data-name="M"><p data-slot="label">L</p><span data-slot="tag">T</span></div>` });
    const one = await call("instantiate_component", { component: "moveout", parentId: a.id });
    const two = await call("instantiate_component", { component: "moveout", parentId: a.id });
    let st = await state();
    const label = st.nodes[one.id].children[0];
    await call("move_nodes", { nodeIds: [label], parentId: two.id });
    st = await state();
    assert.equal(st.nodes[label].componentRootId, undefined, "moved out of its instance, it is a plain layer");
    await call("update_component", { component: "moveout", slot: "root", patch: { styles: { gap: "4px" } } });
    st = await state();
    assert.ok(st.nodes[label] && st.nodes[two.id].children.includes(label), "an update keeps it where it was moved");
    assert.ok(consistent(st));

    // A layer someone put inside a part the component no longer has moves up into the instance.
    const tagId = st.nodes[two.id].children.find((c) => st.nodes[c].componentKey === "tag");
    const note = await call("create_node", { parentId: tagId, name: "Note" });
    await call("update_component", { component: "moveout", html: `<div data-name="M"><p data-slot="label">L</p></div>` });
    st = await state();
    assert.ok(!st.nodes[tagId], "the removed part is gone");
    assert.equal(st.nodes[note.id]?.parentId, two.id, "the layer inside it moved up into the instance");
    assert.ok(consistent(st));
    await call("delete_nodes", { nodeIds: [one.id, two.id, label].filter((id) => st.nodes[id]) });
  });

  await t.test("update_component puts a part someone moved inside the instance back, listed by one parent only", async () => {
    await call("create_component", { name: "regroup", html: `<div data-name="R"><p data-slot="label">L</p></div>` });
    const inst = await call("instantiate_component", { component: "regroup", parentId: a.id });
    let st = await state();
    const label = st.nodes[inst.id].children[0];
    const wrap = await call("create_node", { parentId: inst.id, name: "Wrapper" }); // a layer added inside the instance
    await call("move_nodes", { nodeIds: [label], parentId: wrap.id });
    await call("update_component", { component: "regroup", slot: "root", patch: { styles: { gap: "2px" } } });
    st = await state();
    const claimants = Object.values(st.nodes).filter((n) => n.children.includes(label)).map((n) => n.id);
    assert.deepEqual(claimants, [st.nodes[label].parentId], "exactly one parent lists the part");
    await call("delete_nodes", { nodeIds: [inst.id] });
  });

  await t.test("after an agent's undo its cursor shows undo, or disappears when its layers are gone", async () => {
    const as = (name, args) => mcpCall(srv.baseUrl, name, args, { "x-weft-client": "cursor-agent" });
    const cursorOf = async (pred) => {
      const ctl = new AbortController();
      const reader = (await fetch(`${srv.baseUrl}/events`, { signal: ctl.signal })).body.getReader();
      let buf = "";
      while (!/event: presence\ndata: .*\n/.test(buf)) buf += new TextDecoder().decode((await reader.read()).value);
      ctl.abort();
      return JSON.parse(/event: presence\ndata: (.*)\n/.exec(buf)[1]).agents.find(pred);
    };
    const n = await as("create_node", { parentId: a.id, name: "Cursor target" });
    await as("update_styles", { updates: [{ nodeIds: [n.id], styles: { color: "red" } }] });
    await as("undo");
    const c = await cursorOf((x) => x.nodeIds.includes(n.id));
    assert.equal(c?.tool, "undo");
    await as("undo"); // undoes the creation: the layer is gone
    assert.equal(await cursorOf((x) => x.nodeIds.includes(n.id)), undefined);
    assert.equal(await cursorOf((x) => x.tool === "undo" && x.nodeIds.length === 0), undefined);
  });

  await t.test("a checkpoint of ~1,500 layers saves fully and restores exactly", async () => {
    const big = await call("create_artboard", { name: "Big checkpoint", width: 1200, height: 3000 });
    await call("write_html", { parentId: big.id, html: Array.from({ length: 500 }, (_, i) => `<div data-name="row ${i}" style="padding:${i % 9}px"><p>text ${i}</p><span>${"x".repeat(i % 40)}</span></div>`).join("") });
    const snapshot = (await state()).nodes;
    const cp = await call("save_checkpoint", { name: "big one" });
    await call("delete_nodes", { nodeIds: [big.id] });
    await call("restore_checkpoint", { id: cp.id, force: true });
    assert.deepStrictEqual((await state()).nodes, snapshot, "every layer comes back exactly");
    const listed = (await call("list_checkpoints")).find((c) => c.id === cp.id);
    assert.ok(listed.commit, "the checkpoint is a saved commit");
    await call("delete_nodes", { nodeIds: [big.id] });
  });

  await t.test("update_root_css warns about var() loops", async () => {
    const res = await call("update_root_css", { vars: { "--x": "var(--y)", "--y": "var(--x)", "--fine": "var(--x)" } });
    assert.ok(res.warnings.some((w) => w.includes("--x → --y → --x")), JSON.stringify(res.warnings));
    assert.ok(!res.warnings.some((w) => w.includes("--fine →")));
  });
});
