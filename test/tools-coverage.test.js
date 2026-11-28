// End-to-end coverage for every MCP tool, export safety, and the stdio relay.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const PAPER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECTED_TOOLS = [
  "add_font", "audit_artboard", "create_artboard", "create_component", "create_node", "create_page", "create_project", "delete_component", "delete_icon", "delete_nodes", "delete_page",
  "delete_project", "duplicate_nodes", "duplicate_project", "export_design_tokens", "find_nodes", "finish_working_on_nodes", "get_basic_info", "get_children", "get_comments", "get_computed_styles",
  "get_guide", "get_jsx", "get_node_info", "get_root_css", "get_screenshot", "get_selection", "get_tree_summary", "git_pull", "git_push", "git_status",
  "import_design_tokens", "import_root_css", "instantiate_component", "list_checkpoints", "list_components", "list_fonts", "list_icons", "list_projects", "move_nodes", "open_project",
  "redo", "register_icons", "remove_font", "rename_nodes", "rename_project", "reply_to_comment", "resolve_comment", "restore_checkpoint", "save_checkpoint", "set_selection",
  "set_session_title", "set_text_content", "switch_page", "undo", "update_component", "update_node", "update_nodes_matching", "update_page", "update_root_css", "update_styles",
  "write_html",
];

// Markup an attacker could put in layer names / text to break out of exported or rendered HTML.
const XSS = `</style><script>window.__pwn=1</script><img src=x onerror="window.__pwn=1">*/`;

// Reads a PKZIP buffer (Store/Deflate) into { name: Buffer }.
function unzip(buf) {
  const out = {};
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8), size = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26), extraLen = buf.readUInt16LE(o + 28);
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString("utf8");
    const data = buf.subarray(o + 30 + nameLen + extraLen, o + 30 + nameLen + extraLen + size);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    o += 30 + nameLen + extraLen + size;
  }
  return out;
}

function findBrowser() {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/local/bin/chrome-headless-shell",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
  for (const c of candidates) if (existsSync(c)) return c;
  if (process.platform !== "win32") {
    for (const cmd of ["chrome-headless-shell", "google-chrome", "chromium"]) {
      try {
        const out = execFileSync("which", [cmd], { encoding: "utf8" }).trim();
        if (out) return out;
      } catch {}
    }
  }
  return null;
}

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

async function startTestServer({ chromePath = "" } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-tools-test-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: PAPER_ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: baseUrl, DATA_DIR: dataDir, CHROME_PATH: chromePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d.toString(); });
  child.stderr.on("data", (d) => { logs += d.toString(); });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}):\n${logs}`);
    try { if ((await fetch(`${baseUrl}/api/projects`)).ok) break; } catch {}
    await sleep(60);
  }
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => {
        const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} r(); }, 1500);
        child.once("exit", () => { clearTimeout(t); r(); });
      });
    }
    for (let i = 0; i < 6; i++) {
      try { await fs.rm(dataDir, { recursive: true, force: true }); break; } catch { await sleep(150); }
    }
  };
  return { baseUrl, dataDir, stop, logs: () => logs };
}

async function rpc(baseUrl, method, params = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(res.status, 200, `${method} → HTTP ${res.status}`);
  const raw = await res.text();
  const dataLine = raw.split(/\r?\n/).find((l) => l.startsWith("data: "));
  const body = JSON.parse(dataLine ? dataLine.slice(6) : raw);
  if (body.error) throw new Error(`MCP ${body.error.code}: ${body.error.message}`);
  return body.result;
}

/** Call a tool; returns { result, json, text, isError }. */
async function call(baseUrl, name, args = {}) {
  const result = await rpc(baseUrl, "tools/call", { name, arguments: args });
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  let json;
  try { json = JSON.parse(text); } catch {}
  return { result, text, json, isError: Boolean(result.isError) };
}

/** Call a tool that must succeed and return parsed JSON (or raw text). */
async function ok(baseUrl, name, args = {}) {
  const r = await call(baseUrl, name, args);
  assert.equal(r.isError, false, `${name} failed: ${r.text}`);
  return r.json ?? r.text;
}

async function fails(baseUrl, name, args, pattern) {
  const r = await call(baseUrl, name, args);
  assert.equal(r.isError, true, `${name} should have failed but returned: ${r.text}`);
  if (pattern) assert.match(r.text, pattern);
  return r.text;
}

test("MCP tools: every registered tool works end to end", { timeout: 180_000 }, async (t) => {
  const browser = findBrowser();
  const srv = await startTestServer({ chromePath: browser || "" });
  t.after(() => srv.stop());
  const B = srv.baseUrl;

  await t.test("tools/list exposes all documented tools with schemas", async () => {
    const { tools } = await rpc(B, "tools/list");
    assert.deepEqual(tools.map((x) => x.name).sort(), EXPECTED_TOOLS);
    for (const tool of tools) {
      assert.ok(tool.description?.length > 10, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} needs an object input schema`);
    }
    const del = tools.find((x) => x.name === "delete_project");
    assert.equal(del.annotations?.destructiveHint, true);
    assert.equal(tools.find((x) => x.name === "get_basic_info").annotations?.readOnlyHint, true);
  });

  await t.test("initialize advertises server info and instructions", async () => {
    const init = await rpc(B, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.serverInfo.name, "weft");
    const pkg = JSON.parse(await fs.readFile(path.join(PAPER_ROOT, "package.json"), "utf8"));
    assert.equal(init.serverInfo.version, pkg.version, "MCP server version comes from package.json");
    assert.ok(init.instructions?.includes("get_guide"));
  });

  // ---------------------------------------------------------------- projects
  let projectId;
  await t.test("projects: list, create, rename, duplicate, open, delete", async () => {
    const before = await ok(B, "list_projects");
    assert.equal(before.length, 1);
    assert.equal(before[0].active, true);

    const created = await ok(B, "create_project", { name: "Coverage" });
    projectId = created.id;
    assert.match(projectId, /^[0-9a-f]{8}$/);
    const listed = await ok(B, "list_projects");
    assert.equal(listed.find((p) => p.id === projectId)?.active, true, "create_project opens by default");

    const closed = await ok(B, "create_project", { name: "Background", open: false });
    assert.equal((await ok(B, "list_projects")).find((p) => p.id === closed.id).active, false);

    assert.deepEqual(await ok(B, "rename_project", { projectId: closed.id, name: "Renamed" }), { id: closed.id, name: "Renamed" });
    const copy = await ok(B, "duplicate_project", { projectId: closed.id });
    assert.equal(copy.name, "Renamed copy");
    assert.equal((await ok(B, "list_projects")).find((p) => p.id === copy.id).active, false, "duplicate does not open");

    assert.deepEqual(await ok(B, "delete_project", { projectId: copy.id }), { deleted: copy.id });
    assert.deepEqual(await ok(B, "delete_project", { projectId: closed.id }), { deleted: closed.id });
    await fails(B, "open_project", { projectId: "deadbeef" }, /not found/);
    await fails(B, "open_project", { projectId: "../etc" }, /not found|Invalid/);
    await fails(B, "create_project", { name: "" });

    // Deleting the open project must never leave a moment without one. A large project to fall back to makes
    // the switch take a while; keep polling throughout and every response must still have an open project.
    const big = await ok(B, "create_project", { name: "Big fallback" });
    const bigBoard = await ok(B, "create_artboard", { name: "Big" });
    await ok(B, "write_html", { parentId: bigBoard.id, html: `<p>${"x".repeat(3_000_000)}</p>` });
    const doomed = await ok(B, "create_project", { name: "Doomed" });
    let deleting = true;
    const outcomes = [];
    // A few sequential pollers (one request in flight each) using a small response.
    const pollers = Array.from({ length: 4 }, async () => {
      while (deleting) outcomes.push(!(await call(B, "get_tree_summary", { depth: 0 })).isError);
    });
    await sleep(20);
    const del = await call(B, "delete_project", { projectId: doomed.id });
    deleting = false;
    await Promise.all(pollers);
    assert.equal(del.isError, false, del.text);
    assert.ok(outcomes.length > 4, "polled while deleting");
    assert.ok(outcomes.every(Boolean), `${outcomes.filter((x) => !x).length} of ${outcomes.length} requests saw no open project`);
    assert.equal((await ok(B, "get_basic_info")).project.id, big.id, "falls back to the most recent other project");
    await ok(B, "delete_project", { projectId: big.id });

    const opened = await ok(B, "open_project", { projectId });
    assert.equal(opened.id, projectId);
    assert.equal((await ok(B, "get_basic_info")).project.id, projectId);
  });

  // ---------------------------------------------------------------- read basics
  await t.test("get_guide and get_basic_info", async () => {
    const guide = await ok(B, "get_guide");
    assert.match(guide, /write_html/);
    assert.match(guide, /finish_working_on_nodes/);
    const info = await ok(B, "get_basic_info");
    assert.equal(info.project.name, "Coverage");
    assert.equal(info.pages.length, 1);
    assert.equal(info.pages[0].current, true);
    assert.deepEqual(info.artboards, []);
    assert.equal(info.layers, 0);
    assert.ok(info.fonts.some((f) => f.includes("Geist")));
    assert.equal(info.screenshots, browser ? "available" : info.screenshots);
  });

  // ---------------------------------------------------------------- authoring
  let board, section, title, para, button, sharedIds = [];
  await t.test("create_artboard places boards side by side", async () => {
    board = (await ok(B, "create_artboard", { name: "Desktop", width: 800, height: "fit-content", styles: { backgroundColor: "#ffffff" } })).id;
    const second = await ok(B, "create_artboard", { name: "Mobile" });
    const info = await ok(B, "get_basic_info");
    const [a, b] = info.artboards;
    assert.equal(a.width, "800px");
    assert.equal(a.height, "fit-content");
    assert.equal(b.width, "390px");
    assert.equal(b.height, "844px");
    assert.equal(b.x, 880, "second board sits 80px right of the first");
    assert.equal(b.id, second.id);
    await fails(B, "create_artboard", { pageId: "nope" }, /not found/);
  });

  await t.test("write_html builds a layer tree with names, warnings and sanitising", async () => {
    const res = await ok(B, "write_html", {
      parentId: board,
      html: `<section data-name="Hero" class="ignored" style="display:flex; flex-direction:column; gap:16px; padding:40px; background-color:#0000ff">
        <h1 data-name="Title" style="margin:0; font-size:40px; color:#ffffff" onclick="alert(1)">Hello <b>bold</b> world</h1>
        <p style="margin:0; color:#ffffff">Body copy</p>
        <button style="padding:10px 16px; background:#ffffff">Go</button>
        <a href="javascript:alert(1)">Bad link</a>
        <svg viewBox="0 0 10 10" width="20" height="20"><circle cx="5" cy="5" r="4" fill="#ffffff"/></svg>
        <table><tr><td>cell</td></tr></table>
        <script>window.bad = 1</script>
        <div style="width: expression(alert(1)); height: 20px">expr</div>
      </section>`,
    });
    assert.equal(res.created.length, 1);
    assert.equal(res.created[0].name, "Hero");
    assert.equal(res.created[0].tag, "section");
    assert.ok(res.layers >= 10, `expected a deep tree, got ${res.layers}`);
    assert.ok(res.warnings.some((w) => /\.ignored isn't in the root CSS/.test(w)), "an undefined class warns and is dropped");
    assert.ok(res.warnings.some((w) => /Unsafe URL/.test(w)), "javascript: URL is rejected");
    assert.ok(res.warnings.some((w) => /Unsafe value/.test(w)), "expression() is rejected");
    section = res.created[0].id;

    const kids = await ok(B, "get_children", { nodeId: section });
    const byTag = (tag) => kids.find((k) => k.tag === tag);
    title = byTag("h1").id;
    para = byTag("p").id;
    button = byTag("button").id;
    assert.ok(byTag("svg"), "inline SVG is kept");
    assert.equal(byTag("h1").name, "Title");
    assert.equal(kids.some((k) => k.tag === "script"), false, "<script> is stripped");
    assert.equal(kids.find((k) => k.name === "Bad link")?.tag ?? byTag("a")?.tag, "a");

    const h1 = await ok(B, "get_node_info", { nodeId: title });
    assert.equal(h1.path, "Desktop / Hero");
    assert.equal(h1.artboardId, board);
    assert.equal(h1.attrs, undefined, "onclick is dropped");
    assert.deepEqual(h1.children.map((c) => c.tag), ["span", "strong", "span"], "mixed text keeps order");

    await fails(B, "write_html", { parentId: board, html: "   " }, /No elements/);
    await fails(B, "write_html", { parentId: "missing", html: "<div>x</div>" }, /not found/);
    await fails(B, "write_html", { mode: "replace", html: "<div>x</div>" }, /targetNodeId/);
  });

  await t.test("write_html without parentId creates a new artboard", async () => {
    const res = await ok(B, "write_html", { html: `<div data-name="Loose Board" style="padding:8px">x</div>` });
    const info = await ok(B, "get_node_info", { nodeId: res.created[0].id });
    assert.equal(info.styles.position, "absolute");
    assert.equal(info.artboardId, res.created[0].id);
    await ok(B, "delete_nodes", { nodeIds: [res.created[0].id] });
  });

  await t.test("inspection: tree summary, find_nodes, selection", async () => {
    const outline = await ok(B, "get_tree_summary", { nodeId: board, depth: 2 });
    assert.match(outline, new RegExp(`^${board} <div> Desktop \\[800px x fit-content\\]`));
    assert.match(outline, /<h1> Title/);
    assert.equal((await ok(B, "get_tree_summary", { nodeId: board, depth: 0 })).split("\n").length, 1);

    const found = await ok(B, "find_nodes", { query: "body copy" });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, para);
    assert.equal(found[0].artboard, "Desktop");
    assert.equal((await ok(B, "find_nodes", { tag: "button" }))[0].id, button);
    assert.equal((await ok(B, "find_nodes", { query: title })).length, 1, "exact id matches");
    const capped = await ok(B, "find_nodes", { tag: "div", limit: 1 });
    assert.equal(capped.nodes.length, 1);
    assert.equal(capped.more, true, "a cut-off result says so");

    assert.deepEqual((await ok(B, "get_selection")).nodes, []);
    const sel = await fetch(`${B}/api/selection`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [title, "ghost"] }) });
    assert.equal(sel.status, 200);
    const got = await ok(B, "get_selection");
    assert.deepEqual(got.nodes.map((n) => n.id), [title]);
    assert.equal(got.nodes[0].artboard, "Desktop");
    assert.deepEqual(await ok(B, "set_selection", { nodeIds: [button], zoom: false }), { selected: [button] });
    await fails(B, "set_selection", { nodeIds: ["ghost"] }, /not found/);
  });

  await t.test("editing tools: update_styles, update_node, set_text_content, rename_nodes", async () => {
    assert.deepEqual(await ok(B, "update_styles", { updates: [{ nodeIds: [title, para], styles: { letterSpacing: "-0.02em", margin: null } }] }), { updated: 2 });
    const t1 = await ok(B, "get_node_info", { nodeId: title });
    assert.equal(t1.styles.letterSpacing, "-0.02em");
    assert.equal(t1.styles.margin, undefined, "null removes a style");
    await fails(B, "update_styles", { updates: [{ nodeIds: [title], styles: { color: "red; background:url(x)" } }] }, /Unsafe/);
    await fails(B, "update_styles", { updates: [{ nodeIds: [title], styles: { "font-size": "12px" } }] }, /camelCase/);

    await ok(B, "update_node", { nodeId: para, tag: "h2", styles: { fontSize: 24 } });
    const p2 = await ok(B, "get_node_info", { nodeId: para });
    assert.equal(p2.tag, "h2");
    assert.equal(p2.styles.fontSize, "24px", "numbers become px");
    assert.equal(p2.styles.color, "#ffffff", "styles merge by default");
    await ok(B, "update_node", { nodeId: para, styles: { opacity: 0.5 }, replaceStyles: true });
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: para })).styles, { opacity: "0.5" });
    await fails(B, "update_node", { nodeId: para, tag: "script" }, /not allowed/);
    await fails(B, "update_node", { nodeId: section, tag: "img" }, /can't contain child layers/);
    await fails(B, "update_node", { nodeId: section, tag: "svg" }, /HTML and SVG/);
    await ok(B, "update_node", { nodeId: section, tag: "article" });
    await ok(B, "update_node", { nodeId: section, tag: "section" });
    await fails(B, "update_node", { nodeId: para, attrs: { onclick: "x" } }, /not supported/);

    assert.deepEqual(await ok(B, "set_text_content", { updates: [{ nodeId: button, text: "Start now" }] }), { updated: 1 });
    assert.equal((await ok(B, "get_node_info", { nodeId: button })).text, "Start now");
    assert.deepEqual(await ok(B, "rename_nodes", { updates: [{ nodeId: button, name: "CTA" }] }), { renamed: 1 });
    assert.equal((await ok(B, "get_node_info", { nodeId: button })).name, "CTA");

    // Batch update_node + addClasses/removeClasses + update_nodes_matching in single undo steps.
    await ok(B, "update_root_css", { classes: { "p1-badge": { padding: "4px" }, "p1-active": { opacity: "0.9" }, "p1-extra": { gap: "6px" } } });
    await ok(B, "update_node", { nodeId: button, addClasses: ["p1-badge"] });
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: button })).classes, ["p1-badge"]);
    await ok(B, "update_node", { nodeId: button, addClasses: ["p1-active"], removeClasses: ["p1-badge"] });
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: button })).classes, ["p1-active"]);

    const batchRes = await ok(B, "update_node", {
      updates: [
        { nodeId: title, addClasses: ["p1-badge"], styles: { letterSpacing: "-0.03em" } },
        { nodeId: button, addClasses: ["p1-extra"], text: "Launch" },
      ],
    });
    assert.equal(batchRes.updated, 2);
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: title })).classes, ["p1-badge"]);
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: button })).classes, ["p1-active", "p1-extra"]);
    assert.equal((await ok(B, "get_node_info", { nodeId: button })).text, "Launch");
    await ok(B, "undo");
    assert.equal((await ok(B, "get_node_info", { nodeId: title })).classes, undefined, "batch update_node is one undo step");
    assert.equal((await ok(B, "get_node_info", { nodeId: button })).text, "Start now");

    const matchRes = await ok(B, "update_nodes_matching", {
      artboardIds: [board],
      hasClass: "p1-active",
      addClasses: ["p1-extra"],
      removeClasses: ["p1-active"],
    });
    assert.deepEqual(matchRes, { matched: 1, updated: 1, nodeIds: [button] });
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: button })).classes, ["p1-extra"]);
    await ok(B, "undo");
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: button })).classes, ["p1-active"]);
    await fails(B, "update_nodes_matching", { addClasses: ["p1-badge"] }, /Provide at least one filter/);

    await ok(B, "update_node", { nodeId: button, classes: [] });
    await ok(B, "update_root_css", { classes: { "p1-badge": null, "p1-active": null, "p1-extra": null } });
  });

  await t.test("structure tools: create_node, duplicate_nodes, move_nodes, delete_nodes", async () => {
    const extra = await ok(B, "create_node", { parentId: section, tag: "img", name: "Logo", attrs: { src: "https://example.com/logo.png", alt: "Logo" }, index: 0 });
    await fails(B, "create_node", { parentId: section, tag: "img", text: "no text on img" }, /can't hold text/);
    assert.equal((await ok(B, "get_children", { nodeId: section }))[0].id, extra.id, "index 0 inserts first");
    await fails(B, "create_node", { parentId: section, tag: "img", attrs: { src: "javascript:alert(1)" } }, /Unsafe URL/);

    const dups = await ok(B, "duplicate_nodes", { nodeIds: [button] });
    assert.equal(dups.length, 1);
    assert.equal(dups[0].name, "CTA copy");
    const kids = (await ok(B, "get_children", { nodeId: section })).map((k) => k.id);
    assert.equal(kids.indexOf(dups[0].id), kids.indexOf(button) + 1, "duplicate lands right after the original");

    assert.deepEqual(await ok(B, "move_nodes", { nodeIds: [dups[0].id, extra.id], parentId: title, index: 0 }), { moved: 2, parentId: title });
    assert.deepEqual((await ok(B, "get_children", { nodeId: title })).slice(0, 2).map((k) => k.id), [dups[0].id, extra.id]);
    await fails(B, "move_nodes", { nodeIds: [section], parentId: title }, /inside itself/);

    // Nesting rules match the UI: nothing may land where it silently wouldn't render.
    const icon = (await ok(B, "write_html", { parentId: section, html: `<svg viewBox="0 0 24 24" width="24" height="24"><g><circle cx="12" cy="12" r="9"></circle></g></svg>` })).created[0].id;
    const [group] = await ok(B, "get_children", { nodeId: icon });
    const [circle] = await ok(B, "get_children", { nodeId: group.id });
    const spare = (await ok(B, "create_artboard", { name: "Spare" })).id;
    const before = (await ok(B, "get_basic_info")).layers;
    await fails(B, "move_nodes", { nodeIds: [spare], parentId: section }, /top level/);
    await fails(B, "move_nodes", { nodeIds: [button], parentId: icon }, /can't go inside <svg>/);
    await fails(B, "move_nodes", { nodeIds: [group.id], parentId: section }, /must be inside an <svg>/);
    await fails(B, "create_node", { parentId: icon, tag: "div" }, /can't go inside <svg>/);
    await fails(B, "create_node", { parentId: circle.id, tag: "circle" }, /<circle> can't contain/);
    await fails(B, "create_node", { parentId: extra.id, tag: "span", text: "x" }, /<img> can't contain/);
    await fails(B, "create_node", { parentId: section, tag: "path" }, /must be inside an <svg>/);
    await fails(B, "write_html", { parentId: icon, html: "<p>text</p>" }, /can't go inside <svg>/);
    await fails(B, "write_html", { targetNodeId: circle.id, mode: "replace", html: "<div>x</div>" }, /can't go inside <g>/);
    await fails(B, "update_node", { nodeId: circle.id, tag: "div" }, /can't go inside <g>/);
    const pageId = (await ok(B, "get_basic_info")).page.id;
    await fails(B, "create_node", { parentId: pageId, tag: "circle" }, /must be inside an <svg>/); // a shape "artboard"
    await fails(B, "write_html", { html: "<path d='M0 0L1 1'></path>" }, /must be inside an <svg>/);
    // The REST API (what the UI calls) enforces the same rules.
    const rest = await fetch(`${B}/api/nodes/${spare}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ parentId: section }) });
    assert.equal(rest.status, 400);
    assert.match((await rest.json()).error, /top level/);
    assert.equal((await ok(B, "get_basic_info")).layers, before, "rejected writes change nothing");

    // Nested elements that can't render where they were written are skipped with a warning; the rest is built.
    const lenient = await ok(B, "write_html", { parentId: section, html: `<div data-name="Wrap"><circle r="2"></circle><span>kept</span><svg viewBox="0 0 8 8"><svg viewBox="0 0 4 4"><rect width="4" height="4"></rect></svg><text x="1" y="5">Hi</text></svg></div>` });
    assert.ok(lenient.warnings.some((w) => /Circle: <circle> must be inside an <svg> or <g>; skipped/.test(w)), lenient.warnings.join(" | "));
    assert.ok(lenient.warnings.some((w) => /can't hold text; dropped "Hi"/.test(w)), "text dropped from SVG is reported");
    assert.ok(lenient.warnings.some((w) => /<text> isn't supported/.test(w)), "lossy mapping is reported");
    const wrap = lenient.created[0].id;
    assert.deepEqual((await ok(B, "get_children", { nodeId: wrap })).map((k) => k.tag), ["span", "svg"], "circle skipped, rest kept");
    const outer = (await ok(B, "get_children", { nodeId: wrap }))[1].id;
    assert.deepEqual((await ok(B, "get_children", { nodeId: outer })).map((k) => k.tag), ["svg", "g"], "<svg> inside <svg> renders, so it is kept");
    await ok(B, "delete_nodes", { nodeIds: [wrap] });
    // Still allowed: SVG shapes into <svg>/<g>, artboards between pages, reordering in place, a layer onto the page.
    await ok(B, "create_node", { parentId: group.id, tag: "rect" });
    await ok(B, "move_nodes", { nodeIds: [spare], parentId: (await ok(B, "get_basic_info")).page.id, index: 0 });
    await ok(B, "delete_nodes", { nodeIds: [icon, spare] });

    const del = await ok(B, "delete_nodes", { nodeIds: [dups[0].id, extra.id, dups[0].id] });
    assert.equal(del.deleted, 2, "already-deleted ids are skipped");
    await fails(B, "get_node_info", { nodeId: extra.id }, /not found/);
  });

  await t.test("undo / redo share one history and survive batches", async () => {
    const countLayers = async () => (await ok(B, "get_basic_info")).layers;
    const before = await countLayers();
    const res = await ok(B, "write_html", { parentId: section, html: "<div><span>a</span><span>b</span></div>" });
    assert.equal(await countLayers(), before + 3);
    const undone = await ok(B, "undo");
    assert.equal(undone.undone, true);
    assert.equal(undone.step.by, "agent");
    assert.match(undone.step.label, /write_html/);
    assert.equal(await countLayers(), before, "one write_html = one undo step");
    assert.equal((await ok(B, "redo")).redone, true);
    assert.equal(await countLayers(), before + 3);
    await ok(B, "delete_nodes", { nodeIds: [res.created[0].id] });

    // A human edit through the REST API lands in the same stack; an agent only undoes it when told to.
    await fetch(`${B}/api/nodes/${title}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Human edit" }) });
    assert.equal((await ok(B, "get_node_info", { nodeId: title })).name, "Human edit");
    await fails(B, "undo", {}, /made by the user/);
    assert.equal((await ok(B, "get_node_info", { nodeId: title })).name, "Human edit", "refused undo changes nothing");
    await ok(B, "undo", { includeUserEdits: true });
    assert.equal((await ok(B, "get_node_info", { nodeId: title })).name, "Title");

    // A failing batch must not leave partial changes or an undo entry.
    const name = (await ok(B, "get_node_info", { nodeId: para })).name;
    await fails(B, "rename_nodes", { updates: [{ nodeId: para, name: "Partial" }, { nodeId: "ghost", name: "x" }] }, /not found/);
    assert.equal((await ok(B, "get_node_info", { nodeId: para })).name, name, "batch is all-or-nothing");
  });

  await t.test("comments, checkpoints and session titles round-trip over MCP", async () => {
    const post = (url, body) => fetch(`${B}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const thread = await post("/api/comments", { nodeId: title, text: "Make the title bigger" });
    assert.equal(thread.status, "open");
    const hidden = await post("/api/comments", { nodeId: title, text: "Private note", agentsCanSee: false });

    const open = await ok(B, "get_comments", { status: "open" });
    assert.ok(open.some((c) => c.id === thread.id && c.layerName === "Title"), "agent sees the open thread with its layer name");
    assert.ok(!open.some((c) => c.id === hidden.id), "threads hidden from agents are not returned");
    const after = await ok(B, "get_comments", {});
    assert.equal(after.find((c) => c.id === thread.id).status, "read", "reading marks the thread read");

    await ok(B, "update_styles", { updates: [{ nodeIds: [title], styles: { fontSize: 40 } }] });
    const replied = await ok(B, "reply_to_comment", { id: thread.id, text: "Bumped to 40px" });
    assert.equal(replied.status, "replied");
    const agentMsg = replied.messages.at(-1);
    assert.notEqual(agentMsg.author, "you");
    assert.ok(agentMsg.linkedStep?.historyId, "reply links the agent's last edit");
    await fails(B, "reply_to_comment", { id: "ghost", text: "x" }, /not found/);
    // A private thread stays private even to an agent that knows its id: no reading it back, posting or resolving.
    const leak = await fails(B, "reply_to_comment", { id: hidden.id, text: "x" }, /not found/);
    assert.doesNotMatch(leak, /Private note/);
    await fails(B, "resolve_comment", { id: hidden.id }, /not found/);
    const priv = (await (await fetch(`${B}/api/comments`)).json()).find((c) => c.id === hidden.id);
    assert.equal(priv.messages.length, 1, "no agent message was added");
    assert.equal(priv.status, "open");

    const resolved = await ok(B, "resolve_comment", { id: thread.id });
    assert.equal(resolved.status, "resolved");

    const cp = await ok(B, "save_checkpoint", { name: "Before experiment" });
    assert.ok(cp.id);
    const list = await ok(B, "list_checkpoints");
    assert.ok((Array.isArray(list) ? list : list.checkpoints).some((c) => c.id === cp.id && c.name === "Before experiment"));
    await ok(B, "update_node", { nodeId: title, name: "Experiment" });
    await ok(B, "restore_checkpoint", { id: cp.id });
    assert.equal((await ok(B, "get_node_info", { nodeId: title })).name, "Title", "restore brings the layer back");
    await ok(B, "undo");
    assert.equal((await ok(B, "get_node_info", { nodeId: title })).name, "Experiment", "restore is one undoable step");
    await ok(B, "redo");
    await fails(B, "restore_checkpoint", { id: "ghost" }, /not found/);

    const titled = await ok(B, "set_session_title", { text: "Tested comments" });
    assert.ok(JSON.stringify(titled).includes("Tested comments"));
  });

  await t.test("write_html replace mode swaps a layer in place", async () => {
    const idx = (await ok(B, "get_children", { nodeId: section })).findIndex((k) => k.id === para);
    const res = await ok(B, "write_html", { mode: "replace", targetNodeId: para, html: `<p data-name="Replaced">New</p>` });
    const kids = await ok(B, "get_children", { nodeId: section });
    assert.equal(kids[idx].id, res.created[0].id);
    assert.equal(kids.some((k) => k.id === para), false);
    para = res.created[0].id;
  });

  await t.test("get_jsx exports React and HTML", async () => {
    const jsx = await ok(B, "get_jsx", { nodeId: board, format: "jsx" });
    assert.match(jsx, /export function Desktop\(\)/);
    assert.match(jsx, /style=\{\{/);
    assert.doesNotMatch(jsx, /left:|top:/, "artboard world position is not exported");
    const html = await ok(B, "get_jsx", { nodeId: board, format: "html" });
    assert.match(html, new RegExp(`class="layer-${board}"`));
    assert.match(html, /<h1 class="layer-/);
    assert.doesNotMatch(html, /\{\s*\n\s*\}/, "no empty CSS rules");
    // An unstyled layer gets neither a rule nor a class.
    const plain = (await ok(B, "create_node", { parentId: section, tag: "span", text: "plain" })).id;
    const html2 = await ok(B, "get_jsx", { nodeId: section, format: "html" });
    assert.match(html2, /<span>plain<\/span>/);
    assert.doesNotMatch(html2, new RegExp(`layer-${plain}`));
    await ok(B, "delete_nodes", { nodeIds: [plain] });
    const page = await ok(B, "get_jsx", {});
    assert.match(page, /export function Desktop\(\)/);
    assert.match(page, /export function Mobile\(\)/);
  });

  await t.test("root CSS: shared variables, classes, states, @media and nesting drive every layer", async () => {
    assert.deepEqual(await ok(B, "get_root_css"), { vars: {}, classes: {}, rules: [], definedClasses: [], css: "", usage: {}, unusedClasses: [], unusedVars: [] });
    const set = await ok(B, "update_root_css", {
      css: `/* tokens */
        :root { --color-primary: #0000ff; --color-on-primary: #ffffff; --space-3: 12px; --radius: 12px; --font-ui: 'Geist', sans-serif; }
        .stat-card {
          padding: var(--space-3); background: var(--color-primary); color: var(--color-on-primary); border-radius: var(--radius);
          &:hover { background: #000080; }
          & .stat-value { font-size: 28px; }
          @media (max-width: 900px) { padding: 20px; & .stat-value { font-size: 18px; } }
        }
        .muted-text { font-family: var(--font-ui); -webkit-line-clamp: 2; }`,
    });
    assert.equal(set.css, undefined, "update_root_css returns a concise summary rather than full CSS");
    assert.deepEqual(set.changed.sort(), ["--color-on-primary", "--color-primary", "--font-ui", "--radius", "--space-3", ".muted-text", ".stat-card",
      ".stat-card .stat-value", ".stat-card:hover", "@media (max-width: 900px) { .stat-card .stat-value }", "@media (max-width: 900px) { .stat-card }"].sort());
    assert.deepEqual(set.addedClasses.sort(), ["muted-text", "stat-card", "stat-value"]);
    assert.deepEqual(set.addedVars.sort(), ["--color-on-primary", "--color-primary", "--font-ui", "--radius", "--space-3"]);
    assert.deepEqual(set.definedClasses.sort(), ["muted-text", "stat-card", "stat-value"]);
    assert.equal(set.varsCount, 5);
    assert.equal(set.rulesCount, 6);
    assert.deepEqual(set.warnings, []);
    const got0 = await ok(B, "get_root_css");
    assert.equal(got0.classes["stat-card"].borderRadius, "var(--radius)", "kebab-case becomes camelCase");
    assert.equal(got0.classes["muted-text"].WebkitLineClamp, "2");
    assert.deepEqual(got0.rules.map((r) => r.selector), [".stat-card:hover", ".stat-card .stat-value", ".stat-card", ".stat-card .stat-value"]);
    assert.deepEqual(got0.definedClasses.sort(), ["muted-text", "stat-card", "stat-value"]);
    assert.match(got0.css, /^\.stat-card \{\n {2}padding: var\(--space-3\);[\s\S]*\n {2}&:hover \{\n {4}background: #000080;/m, "nested text comes back");
    assert.deepEqual(got0.unusedClasses.sort(), ["muted-text", "stat-card", "stat-value"]);
    // vars/classes patches merge; null removes (including quoted keys).
    const merged = await ok(B, "update_root_css", {
      vars: { "--space-3": "14px", "--unused": "1px", "\"--nf-border\"": "1px solid #333" },
      classes: { pill: { borderRadius: 999 }, "nf-mobile-btn-list": { gap: 8 } },
    });
    assert.ok(merged.updatedVars.includes("--space-3") && merged.addedVars.includes("--unused"));
    assert.ok(merged.addedClasses.includes("pill") && merged.addedClasses.includes("nf-mobile-btn-list"));
    const gotMerged = await ok(B, "get_root_css");
    assert.equal(gotMerged.vars["--space-3"], "14px");
    assert.equal(gotMerged.vars["--nf-border"], "1px solid #333");
    assert.equal(gotMerged.classes.pill.borderRadius, "999px", "numbers become px like inline styles");
    const removed = await ok(B, "update_root_css", {
      vars: { "--unused": null, "--space-3": "12px", "--nf-border": null },
      classes: { pill: null, "\"nf-mobile-btn-list\"": null },
    });
    assert.deepEqual(removed.removedVars.sort(), ["--nf-border", "--unused"]);
    assert.deepEqual(removed.removedClasses.sort(), ["nf-mobile-btn-list", "pill"]);
    const afterRemove = await ok(B, "get_root_css");
    assert.equal(afterRemove.classes.pill, undefined);
    assert.equal(afterRemove.classes["nf-mobile-btn-list"], undefined);
    assert.equal(afterRemove.vars["--nf-border"], undefined);
    const basic = await ok(B, "get_basic_info");
    assert.deepEqual(basic.rootCss.classes.sort(), ["muted-text", "stat-card", "stat-value"]);
    assert.ok(basic.rootCss.vars.includes("--color-primary"));
    assert.match(await ok(B, "get_guide"), /## Root CSS[\s\S]*&:hover[\s\S]*@media/);

    // Bad root CSS fails clearly and changes nothing.
    const before = (await ok(B, "get_root_css")).css;
    await fails(B, "update_root_css", { css: "#hero { color: red; }" }, /ids and attribute selectors/);
    await fails(B, "update_root_css", { css: "@supports (display: grid) { .x { color: red; } }" }, /@supports isn't supported/);
    await fails(B, "update_root_css", { css: ":root { color: red; }" }, /only holds variables/);
    await fails(B, "update_root_css", { css: ".x { color: red;" }, /Missing "\}"/);
    await fails(B, "update_root_css", { vars: { primary: "#000" } }, /--color-primary/);
    await fails(B, "update_root_css", { vars: { "--x": "red; } body { display: none" } }, /Unsafe value/);
    await fails(B, "update_root_css", { classes: { "1bad": { color: "red" } } }, /start with a letter/);
    assert.equal((await ok(B, "get_root_css")).css, before);

    // Layers use the classes and variables; their own styles only hold overrides.
    const res = await ok(B, "write_html", {
      parentId: section,
      html: `<div data-name="Stat Card" class="stat-card" style="gap: 4px"><span data-name="Stat Value" class="stat-value">42</span></div>
             <div data-name="Stat Card" class="stat-card ghost-class">Two</div>
             <p data-name="Note" class="muted-text" style="color: #0000FF; margin: var(--nope)">Note</p>`,
    });
    const [one, two, note] = res.created.map((c) => c.id);
    const value = (await ok(B, "get_children", { nodeId: one }))[0].id;
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: one })).classes, ["stat-card"]);
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: value })).classes, ["stat-value"], "a class used only in a nested rule is defined");
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: two })).classes, ["stat-card"], "an undefined class is dropped");
    assert.ok(res.warnings.some((w) => /\.ghost-class isn't in the root CSS/.test(w)), res.warnings.join("\n"));
    assert.ok(res.warnings.some((w) => /#0000FF is the root variable --color-primary; use var\(--color-primary\)/.test(w)), "raw value that duplicates a variable is flagged");
    assert.ok(res.warnings.some((w) => /var\(--nope\) isn't defined/.test(w)), "unknown variable is flagged");
    const hinted = await ok(B, "update_styles", { updates: [{ nodeIds: [note], styles: { padding: "12px" } }] });
    assert.ok(hinted.hints.some((h) => /padding: 12px is the root variable --space-3; use var\(--space-3\) so/.test(h)), hinted.hints.join("\n"));
    assert.ok(!hinted.hints.some((h) => /--radius/.test(h)), "a radius token is never suggested for padding");
    assert.deepEqual(await ok(B, "update_styles", { updates: [{ nodeIds: [note], styles: { padding: "var(--space-3)", color: "var(--color-primary)", margin: null } }] }), { updated: 1 });

    // Strict tools reject classes that don't exist.
    await fails(B, "create_node", { parentId: section, classes: ["nope"] }, /\.nope isn't defined in the root CSS/);
    await fails(B, "update_node", { nodeId: one, classes: ["Bad Name"] }, /start with a letter/);
    const extra = await ok(B, "create_node", { parentId: section, tag: "span", text: "Extra", classes: ["muted-text"] });
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: extra.id })).classes, ["muted-text"]);
    assert.equal((await ok(B, "get_root_css")).usage["muted-text"], 2);
    // Compact & scoped get_root_css (include, classes, format).
    const filtered = await ok(B, "get_root_css", { include: ["vars", "usage", "unused"] });
    assert.deepEqual(Object.keys(filtered).sort(), ["unusedClasses", "unusedVars", "usage", "vars"]);
    const scoped = await ok(B, "get_root_css", { classes: ["muted-text"], include: ["vars", "css"] });
    assert.deepEqual(Object.keys(scoped.vars), ["--font-ui"], "only variables referenced by scoped class");
    assert.match(scoped.css, /\.muted-text/);
    assert.doesNotMatch(scoped.css, /\.stat-card/);
    const summaryCss = await ok(B, "get_root_css", { format: "summary" });
    assert.equal(summaryCss.css, undefined);
    assert.equal(summaryCss.varsCount, 5);
    assert.deepEqual(summaryCss.definedClasses.sort(), ["muted-text", "stat-card", "stat-value"]);
    const cssOnly = await ok(B, "get_root_css", { classes: ["stat-card"], format: "css" });
    assert.deepEqual(Object.keys(cssOnly).sort(), ["css", "definedClasses", "rulesCount", "varsCount"]);
    assert.match(cssOnly.css, /\.stat-card/);
    await ok(B, "update_node", { nodeId: extra.id, classes: [] });
    assert.equal((await ok(B, "get_node_info", { nodeId: extra.id })).classes, undefined, "[] clears the list");
    await ok(B, "delete_nodes", { nodeIds: [extra.id] });

    // Screenshots/computed styles use the same cascade: base class → layer's own styles → states/@media/nested on top.
    // The renderer's viewport is the artboard (800px wide), so the (max-width: 900px) breakpoint applies.
    if (browser) {
      const c = await ok(B, "get_computed_styles", { nodeIds: [one, two, note, value], properties: ["padding-top", "background-color", "border-top-left-radius", "gap", "color", "font-size"] });
      assert.equal(c[one].styles["background-color"], "rgb(0, 0, 255)");
      assert.equal(c[one].styles["padding-top"], "20px", "@media applies at the artboard's width");
      assert.equal(c[value].styles["font-size"], "18px", "nested rule inside @media");
      assert.equal(c[one].styles["border-top-left-radius"], "12px");
      assert.equal(c[one].styles.gap, "4px", "the layer's own override applies on top of its class");
      assert.equal(c[note].styles.color, "rgb(0, 0, 255)");
      await ok(B, "update_root_css", { vars: { "--color-primary": "#00aa00" } });
      const after = await ok(B, "get_computed_styles", { nodeIds: [one, two, note], properties: ["background-color", "color"] });
      assert.equal(after[one].styles["background-color"], "rgb(0, 170, 0)", "one variable edit restyles every layer");
      assert.equal(after[two].styles["background-color"], "rgb(0, 170, 0)");
      assert.equal(after[note].styles.color, "rgb(0, 170, 0)");
      await ok(B, "update_root_css", { vars: { "--color-primary": "#0000ff" } });
    }

    // The copy-code snippet carries only the root CSS it uses, in cascade order.
    const snippet = await ok(B, "get_jsx", { nodeId: one, format: "html" });
    assert.match(snippet, /--color-primary: #0000ff;/);
    assert.doesNotMatch(snippet, /--font-ui|\.muted-text/, "unused variables and classes are left out");
    const pos = (re) => snippet.search(re);
    assert.ok(pos(/\.stat-card \{/) < pos(new RegExp(`\\.layer-${one} \\{`)) && pos(new RegExp(`\\.layer-${one} \\{`)) < pos(/\.stat-card:hover \{/), "base → own → states");
    assert.match(snippet, /@media \(max-width: 900px\) \{\n {2}\.stat-card \{\n {4}padding: 20px;/, "exports are plain, un-nested CSS");
    assert.match(snippet, new RegExp(`<div class="stat-card layer-${one}">`));
    const jsx = await ok(B, "get_jsx", { nodeId: one, format: "jsx" });
    assert.match(jsx, /Root CSS used by these components[\s\S]*\.stat-card \{[\s\S]*&:hover/);
    assert.match(jsx, /className="stat-card" style=\{\{ gap: "4px" \}\}/);

    // Undo puts the root CSS back too.
    await ok(B, "update_root_css", { vars: { "--radius": "20px" } });
    await ok(B, "undo");
    assert.equal((await ok(B, "get_root_css")).vars["--radius"], "12px");
    await ok(B, "redo");
    await ok(B, "update_root_css", { vars: { "--radius": "12px" } });

    // Removing a class takes it off every layer, in the same undo step.
    await ok(B, "update_root_css", { classes: { "muted-text": null } });
    assert.equal((await ok(B, "get_node_info", { nodeId: note })).classes, undefined);
    await ok(B, "undo");
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: note })).classes, ["muted-text"], "undo restores the class and its use");
    sharedIds = [one, two, note];
  });

  await t.test("project zip: every screen links the root tokens.css and components.css", async () => {
    const files = unzip(Buffer.from(await (await fetch(`${B}/api/export/zip?format=both`)).arrayBuffer()));
    const names = Object.keys(files);
    assert.deepEqual(names.filter((n) => n.endsWith(".css")).sort(), ["components.css", "tokens.css"], "two stylesheets, at the root");
    assert.ok(names.includes("tokens.json"), "tokens.json is exported alongside tokens.css");
    const zipTokens = JSON.parse(files["tokens.json"].toString());
    assert.equal(zipTokens.color.primary.$value, "#0000ff");
    const tokens = files["tokens.css"].toString();
    assert.match(tokens, /:root \{[^}]*--color-primary: #0000ff;[^}]*--font-ui: 'Geist', sans-serif;/);
    assert.doesNotMatch(tokens, /^\./m, "tokens only: no classes");
    const css = files["components.css"].toString();
    assert.doesNotMatch(css, /:root \{/, "variables live in tokens.css");
    const at = (re) => css.search(re);
    assert.ok(at(/Root CSS: shared classes/) < at(/box-sizing/) && at(/box-sizing/) < at(/Layer overrides/)
      && at(/Layer overrides/) < at(/states, breakpoints and nested rules/), "root classes, reset, overrides, then states / media / nested");
    assert.equal((css.match(/^\.stat-card \{/gm) || []).length, 1, "the base class is defined once");
    assert.match(css, /\.stat-card \{\n {2}padding: var\(--space-3\);\n {2}background: var\(--color-primary\);/);
    assert.match(css, /\.stat-card:hover \{\n {2}background: #000080;\n\}/);
    assert.match(css, /@media \(max-width: 900px\) \{\n {2}\.stat-card \{\n {4}padding: 20px;\n {2}\}\n\n {2}\.stat-card \.stat-value \{/);
    assert.match(css, /body \{ margin: 0; \}/);
    assert.doesNotMatch(css, /\{\s*\n\s*\}/, "no empty rules");
    assert.match(css, /\/\* Layer overrides \*\/[\s\S]*\n\.stat-card-2 \{\n {2}gap: 4px;\n\}/, "an override gets its own name and never redefines the root class");

    const screens = names.filter((n) => n.endsWith(".html") && n !== "index.html");
    assert.ok(screens.length >= 2, "both artboards exported");
    for (const n of screens) {
      const html = files[n].toString();
      assert.match(html, /<link rel="stylesheet" href="\.\.\/tokens\.css">\n<link rel="stylesheet" href="\.\.\/components\.css">/, `${n} links tokens, then components`);
      assert.doesNotMatch(html, /<style|style="/, `${n} carries no CSS of its own`);
    }
    const desktop = files[screens.find((n) => n.endsWith("desktop.html"))].toString();
    assert.match(desktop, /<div class="stat-card">Two<\/div>/, "a layer with no overrides only uses the shared class");
    assert.match(desktop, /<div class="stat-card stat-card-2">\n\s*<span class="stat-value">42<\/span>/, "an override adds one extra class");
    assert.match(desktop, /<p class="muted-text note">Note<\/p>/);
    assert.match(css, /\.note \{\n {2}color: var\(--color-primary\);\n {2}padding: var\(--space-3\);\n\}/);
    const jsx = files[screens.find((n) => n.endsWith("desktop.html")).replace(/html$/, "jsx")].toString();
    assert.match(jsx, /^import "\.\.\/tokens\.css";\nimport "\.\.\/components\.css";/);
    assert.match(jsx, /className="stat-card">\{"Two"\}/);
    assert.doesNotMatch(jsx, /style=\{\{/);
    await ok(B, "delete_nodes", { nodeIds: sharedIds });
  });

  await t.test("root CSS P0: replace flushes to disk, @media merges, pruneUnused + undo", async () => {
    const prev = await ok(B, "get_root_css");
    await ok(B, "update_root_css", { css: ":root { --dead-only: #123456; } .dead-class { color: var(--dead-only); }" });
    const beforePrune = await ok(B, "get_root_css");
    assert.ok(beforePrune.unusedClasses.includes("dead-class"));
    assert.ok(beforePrune.unusedVars.includes("--dead-only"));

    const pruned = await ok(B, "update_root_css", { pruneUnused: true });
    assert.ok(pruned.removedClasses.includes("dead-class"));
    assert.ok(pruned.removedVars.includes("--dead-only"));
    assert.equal((await ok(B, "get_root_css")).classes["dead-class"], undefined);
    await ok(B, "undo");
    assert.ok((await ok(B, "get_root_css")).classes["dead-class"], "undo restores pruned CSS");

    const rep = await ok(B, "update_root_css", {
      replace: true,
      css: ":root { --nf-red: #e50914; } .nf-hero { color: var(--nf-red); @media (max-width:640px) { padding: 8px; } } @media ( max-width : 640px ) { .nf-hero { gap: 4px; } }",
    });
    assert.deepEqual(rep.addedClasses, ["nf-hero"]);
    const onDisk = JSON.parse(await fs.readFile(path.join(srv.dataDir, "projects", `${projectId}.json`), "utf8")).rootCss;
    assert.equal(onDisk.vars["--nf-red"], "#e50914", "replace: true is flushed to disk before returning");
    assert.equal(onDisk.rules.filter((r) => r.selector === ".nf-hero" && r.media).length, 1, "@media rules merge canonically");

    const created = await ok(B, "write_html", { parentId: board, html: `<div class="nf-hero">Hero</div>` });
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: created.created[0].id })).classes, ["nf-hero"]);
    assert.equal((created.warnings || []).some((w) => /nf-hero/.test(w)), false);
    await ok(B, "delete_nodes", { nodeIds: [created.created[0].id] });
    await ok(B, "update_root_css", { replace: true, css: prev.css });
  });

  await t.test("cross-project design system: import_root_css, W3C tokens.json, and expanded linter", async () => {
    const kit = await ok(B, "create_project", { name: "UI Kit", open: false });
    const target = await ok(B, "create_project", { name: "Consumer" });
    await ok(B, "open_project", { projectId: kit.id });
    await ok(B, "update_root_css", {
      css: `:root { --color-brand: #0000ff; --space-4: 16px; --radius-lg: 12px; --font-size-body: 15px; --unused-var: 99px; }
        .kit-btn { padding: var(--space-4); border-radius: var(--radius-lg); color: var(--color-brand); @media (max-width: 640px) { padding: 8px; } }
        .kit-badge { font-size: var(--font-size-body); }`,
    });
    const tokensJson = await ok(B, "export_design_tokens");
    assert.equal(tokensJson.color.brand.$value, "#0000ff");
    assert.equal(tokensJson.space["4"].$value, "16px");
    const restTokens = await (await fetch(`${B}/api/tokens`)).json();
    assert.equal(restTokens.radius.lg.$value, "12px");

    await ok(B, "open_project", { projectId: target.id });
    // Scoped import pulls only .kit-btn and its referenced vars (excluding --unused-var and .kit-badge)
    const scoped = await ok(B, "import_root_css", { sourceProjectId: kit.id, classes: ["kit-btn"] });
    assert.deepEqual(scoped.definedClasses, ["kit-btn"]);
    assert.ok(scoped.addedVars.includes("--color-brand") && !scoped.addedVars.includes("--unused-var"));
    assert.ok((await ok(B, "get_root_css")).vars["--color-brand"]);

    // Merge import brings the rest
    const merged = await ok(B, "import_root_css", { sourceProjectId: kit.id, mode: "merge" });
    assert.deepEqual(merged.definedClasses.sort(), ["kit-badge", "kit-btn"]);
    assert.ok(merged.addedVars.includes("--font-size-body"));
    assert.equal((await ok(B, "get_root_css")).vars["--font-size-body"], "15px");

    // Import W3C Design Tokens via MCP in replace mode (preserves classes, swaps vars)
    const impTok = await ok(B, "import_design_tokens", {
      mode: "replace",
      tokens: {
        color: { $type: "color", primary: { $value: "#112233" } },
        space: { $type: "dimension", md: { $value: { value: 20, unit: "px" } } },
        radius: { $type: "dimension", card: { $value: "10px" } },
        "font-size": { $type: "dimension", sm: { $value: "13px" } },
      },
    });
    assert.equal(impTok.imported, 4);
    assert.ok(impTok.removedVars.includes("--unused-var"), "replace removes old tokens");
    assert.equal((await ok(B, "get_root_css")).vars["--unused-var"], undefined, "replace removes old tokens");
    assert.deepEqual(impTok.definedClasses.sort(), ["kit-badge", "kit-btn"], "classes are preserved");

    // Expanded design system linter warns on spacing, radii, font sizes, and colors
    const b2 = await ok(B, "create_artboard", { name: "Lint Board", width: 400, height: 300 });
    const wRes = await ok(B, "write_html", {
      parentId: b2.id,
      html: `<div style="padding: 18px; border-radius: 6px; font-size: 22px; color: #ff0000">Raw</div>`,
    });
    assert.ok(wRes.warnings.some((w) => /spacing token/.test(w)), wRes.warnings.join("\n"));
    assert.ok(wRes.warnings.some((w) => /radius token/.test(w)), wRes.warnings.join("\n"));
    assert.ok(wRes.warnings.some((w) => /font-size token/.test(w)), wRes.warnings.join("\n"));
    assert.ok(wRes.warnings.some((w) => /color token/.test(w)), wRes.warnings.join("\n"));

    const lId = wRes.created[0].id;
    const quiet = await ok(B, "update_styles", { updates: [{ nodeIds: [lId], styles: { padding: "22px" } }], lint: false });
    assert.deepEqual(quiet, { updated: 1 }, "lint: false suppresses design system scale warnings");

    await ok(B, "open_project", { projectId });
    await ok(B, "delete_project", { projectId: target.id });
    await ok(B, "delete_project", { projectId: kit.id });
  });

  await t.test("icon registry: register_icons, list_icons, delete_icon, and <icon /> expansion", async () => {
    const reg = await ok(B, "register_icons", {
      icons: [
        { name: "nf-n", svg: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M4 2V22M20 2V22" stroke="#e50914" stroke-width="4"/></svg>' },
        { name: "dot", svg: '<svg viewBox="0 0 8 8" width="8" height="8"><circle cx="4" cy="4" r="3" fill="#ffffff"/></svg>' },
      ],
    });
    assert.deepEqual(reg.registered, ["nf-n", "dot"]);
    assert.equal(reg.total, 2);
    const list = await ok(B, "list_icons");
    assert.deepEqual(list.map((i) => i.name), ["dot", "nf-n"]);
    await fails(B, "register_icons", { name: "evil", svg: '<svg><script>alert(1)</script><path d="M0 0"/></svg>' }, /unsafe/i);

    const wRes = await ok(B, "write_html", {
      parentId: section,
      html: '<div style="display:flex;gap:8px"><icon name="nf-n" width="16" /><icon name="nf-n" width="16" /><icon name="ghost" /><span>Row</span></div>',
    });
    assert.ok(wRes.warnings.some((w) => /ghost.*isn't registered/.test(w)), wRes.warnings.join("\n"));
    const rowId = wRes.created[0].id;
    const kids = await ok(B, "get_children", { nodeId: rowId });
    assert.deepEqual(kids.map((k) => k.tag), ["svg", "svg", "span"]);

    const htmlOut = await ok(B, "get_jsx", { nodeId: rowId, format: "html" });
    assert.equal((htmlOut.match(/<symbol /g) || []).length, 1, "repeated <icon> instances deduplicate into one <symbol>");
    assert.equal((htmlOut.match(/<use href="#icon-1"\/>/g) || []).length, 2);

    assert.deepEqual(await ok(B, "delete_icon", { name: "dot" }), { deleted: "dot", total: 1 });
    await ok(B, "undo");
    assert.equal((await ok(B, "list_icons")).length, 2, "delete_icon is undoable");
    await ok(B, "delete_nodes", { nodeIds: [rowId] });
  });

  await t.test("semantic HTML attributes round-trip: write_html, update_nodes_matching, get_jsx", async () => {
    const res = await ok(B, "write_html", {
      parentId: section,
      html: '<div data-name="Attr Row"><button data-name="Attr Btn" type="button" role="switch" aria-label="Dark mode" aria-pressed="false">Go</button><a data-name="Attr Link" href="https://example.com" target="_blank">Docs</a></div>',
    });
    assert.ok(!res.warnings?.some((w) => /Attribute ".*" is not supported/.test(w)), (res.warnings || []).join("\n"));
    const row = res.created[0].id;
    const [btn, link] = await ok(B, "get_children", { nodeId: row });
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: btn.id })).attrs, { type: "button", role: "switch", "aria-label": "Dark mode", "aria-pressed": "false" });
    assert.equal((await ok(B, "get_node_info", { nodeId: link.id })).attrs.rel, "noopener noreferrer");

    await ok(B, "update_nodes_matching", { artboardIds: [board], tag: "button", query: "Attr Btn", attrs: { type: "submit" } });
    assert.equal((await ok(B, "get_node_info", { nodeId: btn.id })).attrs.type, "submit");
    await fails(B, "update_nodes_matching", { artboardIds: [board], tag: "button", query: "Attr Btn", attrs: { onclick: "x()" } }, /not supported/);

    const html = await ok(B, "get_jsx", { nodeId: row, format: "html" });
    assert.match(html, /<button[^>]* type="submit" role="switch" aria-label="Dark mode" aria-pressed="false">/);
    const jsx = await ok(B, "get_jsx", { nodeId: row, format: "jsx" });
    assert.match(jsx, /aria-label="Dark mode"/);
    await ok(B, "delete_nodes", { nodeIds: [row] });
  });

  await t.test("tabindex, aria-label without data-name, and warned drops of unsafe attributes", async () => {
    const res = await ok(B, "write_html", {
      parentId: section,
      lint: false,
      html: '<div data-name="A11y Row"><button aria-label="Close dialog" tabindex="0">x</button><div tabindex="-1">t</div>'
        + '<button aria-label="<script>x</script>" onclick="alert(1)" onmouseover="y()">r</button><div tabindex="9999">big</div></div>',
    });
    const warnings = res.warnings || [];
    const row = res.created[0].id;
    const [named, focusable, unsafe, big] = await ok(B, "get_children", { nodeId: row });

    // aria-label names the layer AND stays an attribute; tabindex is allowed.
    assert.equal(named.name, "Close dialog");
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: named.id })).attrs, { "aria-label": "Close dialog", tabindex: "0" });
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: focusable.id })).attrs, { tabindex: "-1" });
    assert.ok(!warnings.some((w) => /tabindex" is not supported/.test(w)), warnings.join("\n"));

    // A rejected aria-label leaves no markup in the layer name, and every dropped attribute is warned about.
    assert.doesNotMatch(unsafe.name, /[<>]/);
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: unsafe.id })).attrs || {}, {});
    assert.ok(warnings.some((w) => /Unsafe value for aria-label/.test(w)), warnings.join("\n"));
    assert.ok(warnings.some((w) => /"onclick" isn't allowed; dropped/.test(w)), warnings.join("\n"));
    assert.ok(warnings.some((w) => /"onmouseover" isn't allowed; dropped/.test(w)), warnings.join("\n"));
    assert.ok(warnings.some((w) => /Unsafe value for tabindex/.test(w)), warnings.join("\n"));
    assert.deepEqual((await ok(B, "get_node_info", { nodeId: big.id })).attrs || {}, {});

    const jsx = await ok(B, "get_jsx", { nodeId: row, format: "jsx" });
    assert.match(jsx, /<button aria-label="Close dialog" tabIndex="0">/);
    const html = await ok(B, "get_jsx", { nodeId: row, format: "html" });
    assert.match(html, /<button[^>]* aria-label="Close dialog" tabindex="0">/);
    await ok(B, "delete_nodes", { nodeIds: [row] });
  });

  await t.test("string params with quotes or JSON-looking content arrive as strings (bugs.md #5 regression)", async () => {
    const svg = `<svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="20" stroke="#0000ff" stroke-width="4"/></svg>`;
    const reg = await ok(B, "register_icons", { name: "q-ring", svg });
    assert.deepEqual(reg.registered, ["q-ring"]);

    const res = await ok(B, "write_html", { parentId: section, html: `<div data-name='Quote Row' style="gap: 4px">${svg}<p>{"a":1}</p><p>[1, "two"]</p><p>it's "quoted"</p></div>` });
    const row = res.created[0].id;
    const kids = await ok(B, "get_children", { nodeId: row });
    assert.deepEqual(kids.map((k) => k.tag), ["svg", "p", "p", "p"]);
    assert.deepEqual(kids.slice(1).map((k) => k.text), ['{"a":1}', '[1, "two"]', `it's "quoted"`]);

    const css = await ok(B, "update_root_css", { css: `.quote-test { font-family: "Geist", 'Geist Mono', sans-serif; }` });
    assert.ok(css.addedClasses.includes("quote-test"), JSON.stringify(css));
    assert.equal(typeof (await ok(B, "write_html", { parentId: row, html: '{"tag":"div"}' })), "object", "a JSON-looking html string is parsed as HTML text, not as an object");

    await ok(B, "update_root_css", { classes: { "quote-test": null } });
    await ok(B, "delete_icon", { name: "q-ring" });
    await ok(B, "delete_nodes", { nodeIds: [row] });
  });

  await t.test("components expand <icon /> in create_component and update_component (html + appendHtml)", async () => {
    const svgSlot = (slots) => slots.filter((s) => s.tag === "svg");
    const noIconTagWarning = (res) => assert.ok(!(res.warnings || []).some((w) => /Tag "icon" is not allowed/.test(w)), (res.warnings || []).join("\n"));

    const created = await ok(B, "create_component", { name: "icon-card", html: '<div><icon name="nf-n" /><p data-slot="title">Title</p></div>' });
    noIconTagWarning(created);
    assert.equal(svgSlot(created.slots).length, 1, "the <icon> becomes the registered <svg>");
    assert.ok(!created.slots.some((s) => s.tag === "div" && s.name === "icon"));

    const updated = await ok(B, "update_component", { component: "icon-card", html: '<div><icon name="dot" /><icon name="nf-n" /><p data-slot="title">Title</p></div>' });
    noIconTagWarning(updated);
    assert.equal(svgSlot(updated.slots).length, 2);

    const appended = await ok(B, "update_component", { component: "icon-card", appendHtml: { html: '<icon name="dot" />' } });
    noIconTagWarning(appended);
    assert.equal(svgSlot(appended.slots).length, 3);

    const inst = await ok(B, "instantiate_component", { component: "icon-card", parentId: section });
    const kids = await ok(B, "get_children", { nodeId: inst.id });
    assert.deepEqual(kids.map((k) => k.tag), ["svg", "svg", "p", "svg"]);
    const svgKids = await ok(B, "get_children", { nodeId: kids[1].id });
    assert.ok(svgKids.length >= 1 && svgKids.every((k) => k.tag === "path"), "icon shapes are copied into the instance");

    const ghost = await ok(B, "create_component", { name: "ghost-card", html: '<div><icon name="ghost" /><p>Hi</p></div>' });
    assert.ok(ghost.warnings.some((w) => /ghost.*isn't registered/.test(w)), ghost.warnings.join("\n"));
    await fails(B, "update_component", { component: "ghost-card", appendHtml: { html: '<icon name="ghost" />' } }, /isn't registered/);

    await ok(B, "delete_nodes", { nodeIds: [inst.id] });
    await ok(B, "delete_component", { component: "icon-card" });
    await ok(B, "delete_component", { component: "ghost-card" });
  });

  await t.test("preview: a screen opens as a live page sized to its artboard", async () => {
    const shell = await fetch(`${B}/preview/${board}`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("cache-control") || "", /no-store/);
    const html = await shell.text();
    assert.match(html, new RegExp(`<iframe id="frame" title="Desktop · [^"]+" src="/preview/${board}/frame">`));
    assert.match(html, /iframe \{[^}]*width: 800px;/, "the frame starts at the artboard's width so breakpoints match the canvas");
    assert.match(html, /new EventSource\("\/events"\)/, "it listens for live changes");
    // A layer previews the screen it belongs to.
    assert.match(await (await fetch(`${B}/preview/${title}`)).text(), new RegExp(`src="/preview/${board}/frame"`));

    const frame = await (await fetch(`${B}/preview/${board}/frame`)).text();
    assert.match(frame, /^<!doctype html>/);
    assert.match(frame, /<link rel="stylesheet" href="\/fonts\.css">/, "the font library loads like on the canvas");
    assert.match(frame, new RegExp(`<div class="layer-${board}" data-layer="${board}">`));
    assert.match(frame, /<h1 class="layer-\w+" data-layer="\w+">/);
    assert.doesNotMatch(frame, /width:100%!important/);
    assert.match(await (await fetch(`${B}/preview/${board}/frame?fill=1`)).text(), /body>\[data-layer\]\{width:100%!important/);

    assert.equal((await fetch(`${B}/preview/ghost`)).status, 404);
    assert.equal((await fetch(`${B}/preview/ghost/frame`)).status, 404);
    const page = (await ok(B, "get_basic_info")).page.id;
    assert.equal((await fetch(`${B}/preview/${page}`)).status, 400, "a page isn't a screen");
  });

  await t.test("presence: edits mark nodes, finish_working_on_nodes clears them", async () => {
    await ok(B, "update_styles", { updates: [{ nodeIds: [title], styles: { color: "#ffffff" } }] });
    assert.ok((await ok(B, "get_basic_info")).agentWorkingOn.includes(title));
    assert.deepEqual(await ok(B, "finish_working_on_nodes", { nodeIds: [title] }), { ok: true });
    assert.equal((await ok(B, "get_basic_info")).agentWorkingOn.includes(title), false);
    await ok(B, "finish_working_on_nodes");
    assert.deepEqual((await ok(B, "get_basic_info")).agentWorkingOn, []);
  });

  await t.test("rendering: get_screenshot and get_computed_styles", { skip: !browser && "no Chrome/Chromium available" }, async () => {
    const shot = await call(B, "get_screenshot", { nodeId: section, scale: 1 });
    assert.equal(shot.isError, false, shot.text);
    const img = shot.result.content.find((c) => c.type === "image");
    assert.equal(img.mimeType, "image/png");
    assert.equal(Buffer.from(img.data, "base64").subarray(1, 4).toString(), "PNG");
    assert.match(shot.text, /Hero .* · 800×\d+px at scale 1/);

    const computed = await ok(B, "get_computed_styles", { nodeIds: [section, title], properties: ["display", "gap", "background-color"] });
    assert.deepEqual(computed[section].box, { x: 0, y: 0, width: 800, height: computed[section].box.height });
    assert.equal(computed[section].styles.display, "flex");
    assert.equal(computed[section].styles.gap, "16px");
    assert.equal(computed[section].styles["background-color"], "rgb(0, 0, 255)");
    assert.ok(computed[title].box.x >= 40, "padding offsets the title");

    const small = await call(B, "get_screenshot", { nodeId: board, scale: 0.5 });
    assert.match(small.text, /at scale 0\.5/);

    // Multi-viewport responsive screenshot captures on one artboard without duplicating DOM.
    const multi = await call(B, "get_screenshot", { nodeId: board, widths: [390, 834], scale: 1 });
    assert.equal(multi.isError, false, multi.text);
    const imgs = multi.result.content.filter((c) => c.type === "image");
    const caps = multi.result.content.filter((c) => c.type === "text");
    assert.equal(imgs.length, 2, "one PNG per requested viewport width");
    assert.match(caps[0].text, /@ 390px · 390×\d+px/);
    assert.match(caps[1].text, /@ 834px · 834×\d+px/);
    assert.equal((await ok(B, "get_node_info", { nodeId: board })).styles.width, "800px", "saved artboard width unchanged");

    const batchShots = await call(B, "get_screenshot", { nodeIds: [board, section], scale: 0.5 });
    assert.equal(batchShots.isError, false, batchShots.text);
    const images = batchShots.result.content.filter((c) => c.type === "image");
    const captions = batchShots.result.content.filter((c) => c.type === "text");
    assert.equal(images.length, 2, "batch get_screenshot returns one PNG per target");
    assert.equal(captions.length, 2);
    assert.match(captions[0].text, new RegExp(board));
    assert.match(captions[1].text, new RegExp(section));
    await fails(B, "get_screenshot", { nodeId: "ghost" }, /not found/);
    await fails(B, "get_screenshot", { nodeIds: [board, "ghost"] }, /not found/);
  });

  await t.test("diagnostics: audit_artboard and get_screenshot({ diagnostics: true })", { skip: !browser && "no Chrome/Chromium available" }, async () => {
    const cleanAb = (await ok(B, "create_artboard", { name: "Healthy", width: 800, height: "fit-content" })).id;
    await ok(B, "write_html", {
      parentId: cleanAb,
      html: `<div style="padding:24px;background:#ffffff"><p style="margin:0;color:#0a0b0d">Healthy text</p></div>`,
    });
    const cleanAudit = await ok(B, "audit_artboard", { nodeIds: [cleanAb], checkContrast: true });
    assert.equal(cleanAudit.ok, true);
    assert.equal(cleanAudit.audits.length, 1);
    assert.equal(cleanAudit.summary.brokenImages, 0);

    const sickAb = (await ok(B, "create_artboard", { name: "AuditTarget", width: 390, height: "fit-content" })).id;
    await ok(B, "write_html", {
      parentId: sickAb,
      html: `<div data-name="Wrap" style="padding:12px;background:#ffffff">
        <img data-name="BrokenImg" src="http://127.0.0.1:1/nope.png" alt="Broken" style="width:40px;height:40px;display:block">
        <div data-name="Over" style="width:120px;white-space:nowrap">Long_unbreakable_horizontal_overflow_text_string</div>
        <p data-name="BadFont" style="font-family:'MissingAuditFont',sans-serif;color:#111111;margin:0">Font check</p>
        <p data-name="Faint" style="color:#cccccc;margin:0">Too light</p>
        <button data-name="TinyBtn" style="width:24px;height:24px">Go</button>
      </div>`,
    });
    const audit = await ok(B, "audit_artboard", { nodeIds: [sickAb], checkContrast: true });
    assert.equal(audit.ok, false);
    assert.equal(audit.summary.brokenImages, 1);
    assert.ok(audit.summary.overflows >= 1);
    assert.ok(audit.audits[0].missingFonts.some((f) => f.family === "MissingAuditFont"));
    assert.ok(audit.summary.tapTargets >= 1);
    assert.ok(audit.summary.lowContrast >= 1);

    // Responsive width override
    const wideAudit = await ok(B, "audit_artboard", { nodeId: cleanAb, width: 390 });
    assert.equal(wideAudit.audits[0].width, 390);

    // Attached diagnostics on get_screenshot
    const diagShot = await call(B, "get_screenshot", { nodeId: sickAb, diagnostics: true, checkContrast: true });
    assert.equal(diagShot.isError, false, diagShot.text);
    const diagText = diagShot.result.content.filter((c) => c.type === "text").at(-1)?.text;
    const diagJson = JSON.parse(diagText);
    assert.equal(diagJson.diagnostics.ok, false);
    assert.equal(diagJson.diagnostics.summary.brokenImages, 1);

    await fails(B, "audit_artboard", { nodeIds: ["ghost"] }, /not found/);
    await ok(B, "delete_nodes", { nodeIds: [cleanAb, sickAb] });
  });

  // ---------------------------------------------------------------- pages
  await t.test("pages: create, switch, update, delete", async () => {
    const info0 = await ok(B, "get_basic_info");
    const first = info0.page.id;
    const page2 = await ok(B, "create_page", { name: "Second" });
    assert.equal((await ok(B, "get_basic_info")).page.id, page2.id, "create_page switches to it");
    assert.deepEqual((await ok(B, "get_basic_info")).artboards, []);

    const ab = await ok(B, "create_artboard", { name: "On page two" });
    assert.equal((await ok(B, "get_node_info", { nodeId: ab.id })).pageId, page2.id);
    assert.equal((await ok(B, "find_nodes", { query: "Title" })).some((n) => n.page === info0.page.name), true, "find_nodes searches all pages");

    assert.deepEqual(await ok(B, "update_page", { pageId: page2.id, name: "Mobile flows", index: 0 }), { id: page2.id, name: "Mobile flows" });
    assert.equal((await ok(B, "get_basic_info")).pages[0].id, page2.id);
    assert.deepEqual(await ok(B, "switch_page", { pageId: first }), { id: first, name: info0.page.name });
    assert.equal((await ok(B, "get_basic_info")).page.id, first);

    await ok(B, "delete_page", { pageId: page2.id });
    await fails(B, "get_node_info", { nodeId: ab.id }, /not found/);
    await fails(B, "delete_page", { pageId: first }, /at least one page/);
    await fails(B, "switch_page", { pageId: "ghost" }, /not found/);
    await ok(B, "undo");
    assert.equal((await ok(B, "get_basic_info")).pages.length, 2, "delete_page is undoable");
    assert.equal((await ok(B, "get_basic_info")).page.id, first, "undo keeps the current page");
    await ok(B, "delete_page", { pageId: page2.id });
  });

  // ---------------------------------------------------------------- fonts

  await t.test("reusable components: create, instantiate, override, update propagation and undo", async () => {
    await ok(B, "update_root_css", { css: ".nf-card { padding: 12px; } .nf-card-lg { border-radius: 16px; } .nf-badge { background: #0000ff; color: #fff; }" });
    const mobileBoard = await ok(B, "create_artboard", { name: "Mobile", width: 390, height: 844 });
    const desktopBoard = await ok(B, "create_artboard", { name: "Desktop", width: 1280, height: 800 });

    const created = await ok(B, "create_component", {
      name: "nf-card",
      html: `<div class="nf-card" data-name="Show Card"><img data-slot="poster" src="https://example.com/default.jpg" alt="Poster"><h3 data-slot="title">Default Show</h3></div>`,
    });
    assert.equal(created.id, "nf-card");
    assert.ok(created.slots.some((s) => s.slot === "poster") && created.slots.some((s) => s.slot === "title"));

    // Instantiate via MCP tool with slot overrides on Desktop
    const inst1 = await ok(B, "instantiate_component", {
      component: "nf-card",
      parentId: desktopBoard.id,
      overrides: {
        title: "Stranger Things",
        poster: { attrs: { src: "https://example.com/st.jpg", alt: "ST" } },
      },
    });
    assert.equal(inst1.component, "nf-card");

    // Instantiate via write_html data-component + data-slot on Mobile
    const wRes = await ok(B, "write_html", {
      parentId: mobileBoard.id,
      html: `<div data-component="nf-card"><h3 data-slot="title">Dark</h3></div>`,
    });
    const inst2Id = wRes.created[0].id;
    const inst1Children = await ok(B, "get_children", { nodeId: inst1.id });
    const inst2Children = await ok(B, "get_children", { nodeId: inst2Id });
    const inst1TitleId = inst1Children[1].id;
    const inst2TitleId = inst2Children[1].id;
    assert.equal((await ok(B, "get_node_info", { nodeId: inst1TitleId })).text, "Stranger Things");
    assert.equal((await ok(B, "get_node_info", { nodeId: inst2TitleId })).text, "Dark");

    // Manual edit via set_text_content tracks override too
    await ok(B, "set_text_content", { updates: [{ nodeId: inst2TitleId, text: "Dark (S3)" }] });

    // Duplicate an instance -> also stays linked
    const [dupInst] = await ok(B, "duplicate_nodes", { nodeIds: [inst1.id] });
    assert.equal((await ok(B, "list_components")).find((c) => c.id === "nf-card").instanceCount, 3);

    // Master update propagates class, tag, and a newly appended badge slot across ALL 3 instances while preserving overrides!
    const up = await ok(B, "update_component", {
      component: "nf-card",
      patch: { tag: "article", addClasses: ["nf-card-lg"] },
      appendHtml: { html: `<span data-slot="badge" class="nf-badge">TOP 10</span>` },
    });
    assert.equal(up.updatedInstances, 3);
    assert.equal(up.createdNodes, 3);

    const inst1Info = await ok(B, "get_node_info", { nodeId: inst1.id });
    assert.equal(inst1Info.tag, "article");
    assert.deepEqual(inst1Info.classes, ["nf-card", "nf-card-lg"]);
    assert.equal(inst1Info.children.length, 3, "new badge slot added to instance");
    assert.equal((await ok(B, "get_node_info", { nodeId: inst1TitleId })).text, "Stranger Things", "override preserved after master update");
    assert.equal((await ok(B, "get_node_info", { nodeId: inst1Children[0].id })).attrs.src, "https://example.com/st.jpg", "poster override preserved");
    assert.equal((await ok(B, "get_node_info", { nodeId: inst2TitleId })).text, "Dark (S3)", "manual edit override preserved");

    const dupInfo = await ok(B, "get_node_info", { nodeId: dupInst.id });
    assert.equal(dupInfo.tag, "article");
    assert.equal(dupInfo.children.length, 3, "duplicated instance also received new badge slot");

    // Undo restores previous master & removes added badge slots atomically
    await ok(B, "undo");
    assert.equal((await ok(B, "get_node_info", { nodeId: inst1.id })).tag, "div");
    assert.equal((await ok(B, "get_node_info", { nodeId: inst1.id })).children.length, 2);
    await ok(B, "redo");
    assert.equal((await ok(B, "get_node_info", { nodeId: inst1.id })).children.length, 3);

    // Create component from existing node + detach + delete component
    const customBox = await ok(B, "create_node", { parentId: desktopBoard.id, name: "Banner", tag: "div", styles: { padding: 8 } });
    const compFromNode = await ok(B, "create_component", { name: "banner-box", nodeId: customBox.id });
    assert.equal(compFromNode.linkedSource, true);
    assert.equal((await ok(B, "get_node_info", { nodeId: customBox.id })).component.id, "banner-box");

    const delComp = await ok(B, "delete_component", { component: "nf-card" });
    assert.equal(delComp.detachedInstances, 3);
    assert.equal((await ok(B, "get_node_info", { nodeId: inst1.id })).component, undefined, "layers stay on canvas detached");

    await ok(B, "delete_component", { component: "banner-box" });
    await ok(B, "delete_nodes", { nodeIds: [mobileBoard.id, desktopBoard.id] });
    await ok(B, "update_root_css", { classes: { "nf-card": null, "nf-card-lg": null, "nf-badge": null } });
  });

  await t.test("fonts: list, add (Google + file), remove", async () => {
    const fontsBefore = await ok(B, "list_fonts");
    assert.ok(fontsBefore.some((f) => f.id === "builtin-geist" && f.cssFamily.startsWith("'Geist'")));

    const inter = await ok(B, "add_font", { family: "Inter", axes: "wght@400;600" });
    assert.equal(inter.family, "Inter");
    assert.equal(inter.cssFamily, "'Inter', system-ui, sans-serif");
    await fails(B, "add_font", { family: "Inter" }, /already/);
    await fails(B, "add_font", { family: "Bad'; }" }, /Invalid/);
    await fails(B, "add_font", { family: "Inter Tight", axes: "wght@400;}" }, /axes/);
    await fails(B, "add_font", {}, /Provide family/);
    await fails(B, "add_font", { fileName: "x.woff2", dataBase64: Buffer.from("not a font").toString("base64") }, /Not a font/);
    await fails(B, "add_font", { filePath: path.join(PAPER_ROOT, "package.json") }, /woff2/);
    await fails(B, "add_font", { filePath: path.join(PAPER_ROOT, "missing.woff2") }, /not found/);

    // A minimal valid TrueType header is enough for format sniffing.
    const ttf = Buffer.alloc(64);
    ttf.writeUInt32BE(0x00010000, 0);
    const uploaded = await ok(B, "add_font", { fileName: "Brand-Bold.ttf", dataBase64: ttf.toString("base64") });
    assert.equal(uploaded.family, "Brand");
    assert.equal(uploaded.weight, 700);
    const css = await (await fetch(`${B}/fonts.css`)).text();
    assert.match(css, /font-family: 'Brand'/);
    assert.match(css, /family=Inter:wght@400;600/);
    assert.equal((await fetch(`${B}/fonts/files/${uploaded.file}`)).status, 200);
    assert.equal((await fetch(`${B}/fonts/files/..%2Fpackage.json`)).status, 404);

    assert.deepEqual(await ok(B, "remove_font", { fontId: uploaded.id }), { removed: "Brand" });
    assert.deepEqual(await ok(B, "remove_font", { fontId: inter.id }), { removed: "Inter" });
    await fails(B, "remove_font", { fontId: "builtin-geist" }, /Built-in/);
    await fails(B, "remove_font", { fontId: "ghost" }, /not found/);
    assert.deepEqual((await ok(B, "list_fonts")).map((f) => f.id), fontsBefore.map((f) => f.id));
  });

  // ---------------------------------------------------------------- safety
  await t.test("names and text cannot inject markup into render or exports", async () => {
    const res = await ok(B, "write_html", {
      parentId: board,
      html: `<div data-name='${XSS.replace(/'/g, "&#39;")}' style="padding:4px">${XSS.replace(/</g, "&lt;")}</div>`,
    });
    const id = res.created[0].id;
    assert.equal((await ok(B, "get_node_info", { nodeId: id })).name.includes("</style>"), true, "the name itself is stored verbatim");

    const render = await (await fetch(`${B}/render/${board}`)).text();
    for (const url of [`${B}/preview/${id}`, `${B}/preview/${id}/frame`]) {
      const out = await (await fetch(url)).text();
      assert.doesNotMatch(out, /<script>window\.__pwn|<img src=x onerror/, `${url} escapes names and text`);
    }
    const html = await ok(B, "get_jsx", { nodeId: board, format: "html" });
    const zipRes = await fetch(`${B}/api/export/zip?format=both`);
    assert.equal(zipRes.status, 200);
    // The render page wraps the export in its own document, which has one extra <style> of its own.
    for (const [label, out, styles] of [["render", render, 2], ["html export", html, 1]]) {
      assert.doesNotMatch(out, /<script>window\.__pwn/, `${label} must not contain an executable <script>`);
      assert.doesNotMatch(out, /<img src=x onerror/, `${label} must not contain a raw <img onerror>`);
      assert.equal((out.match(/<\/style>/g) || []).length, styles, `${label}: the layer name must not close a <style> block`);
    }
    const jsx = await ok(B, "get_jsx", { nodeId: id, format: "jsx" });
    // JSX text is emitted as a quoted JS string expression, which React renders as plain text.
    assert.match(jsx, /\{"<\/style><script>window\.__pwn=1<\/script>/);
    assert.match(jsx, /^export function [A-Za-z0-9]+\(\)/m, "component name is sanitised");
    await ok(B, "delete_nodes", { nodeIds: [id] });
  });

  await t.test("REST guards: bad ids, formats and hosts", async () => {
    assert.equal((await fetch(`${B}/api/export?format=pdf`)).status, 400);
    assert.equal((await fetch(`${B}/api/export/zip?format=pdf`)).status, 400);
    assert.equal((await fetch(`${B}/api/export/zip?projectId=..%2F..%2Fetc`)).status, 404);
    assert.equal((await fetch(`${B}/render/ghost`)).status, 404);
    assert.equal((await fetch(`${B}/api/projects/ghost/preview`)).status, 404);
    assert.equal((await fetch(`${B}/mcp`)).status, 405);
    const bad = await fetch(`${B}/api/projects`, { headers: { origin: "http://evil.test" } });
    assert.equal(bad.status, 403);
    const badJson = await fetch(`${B}/api/nodes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
    assert.ok(badJson.status >= 400 && badJson.status < 500, `malformed JSON → 4xx, got ${badJson.status}`);
    const badRpc = await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{oops" });
    assert.ok(badRpc.status >= 400 && badRpc.status < 500, `malformed MCP JSON → 4xx, got ${badRpc.status}`);
  });

  await t.test("server logged no unexpected errors", () => {
    assert.doesNotMatch(srv.logs(), /\[weft\] (?!MCP error)|TypeError|ReferenceError|UnhandledPromise/);
  });
});

test("persistence: projects and edits survive a restart", { timeout: 60_000 }, async (t) => {
  const srv = await startTestServer();
  const B = srv.baseUrl;
  const proj = await ok(B, "create_project", { name: "Persisted" });
  const ab = await ok(B, "create_artboard", { name: "Saved board", width: 500, height: 300 });
  await ok(B, "write_html", { parentId: ab.id, html: `<p data-name="Saved text">Hello</p>` });
  // A resolved comment whose layer is later deleted must keep its page, layer name and resolved time.
  const gone = (await ok(B, "write_html", { parentId: ab.id, html: `<p data-name="Doomed">Bye</p>` })).created[0].id;
  const thread = await (await fetch(`${B}/api/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: gone, text: "Remove this" }) })).json();
  const resolved = await ok(B, "resolve_comment", { id: thread.id });
  await ok(B, "delete_nodes", { nodeIds: [gone] });
  await ok(B, "add_font", { family: "Inter" });
  await ok(B, "update_root_css", { css: ":root { --brand: #0000ff; } .saved { color: var(--brand); &:hover { color: #000; } @media (max-width: 600px) { color: red; } }" });
  await ok(B, "write_html", { parentId: ab.id, html: `<p data-name="Shared text" class="saved">Shared</p>` });

  // Saves are batched (PERSIST_THROTTLE_MS, 300 ms by default) and each goes through a temp file that is renamed into
  // place. Wait until the batched writes have landed: no temp files in two checks in a row, after the throttle.
  const tempFiles = async () => (await fs.readdir(path.join(srv.dataDir, "projects"))).filter((f) => f.endsWith(".tmp"));
  await sleep(400);
  for (let quiet = 0, i = 0; quiet < 2; i++) {
    assert.ok(i < 100, `writes still in progress after 10s: ${(await tempFiles()).join(", ")}`);
    quiet = (await tempFiles()).length ? 0 : quiet + 1;
    await sleep(100);
  }

  // Restart against the same data directory.
  const files = await fs.readdir(path.join(srv.dataDir, "projects"));
  assert.ok(files.includes(`${proj.id}.json`));
  assert.equal(files.some((f) => f.endsWith(".tmp")), false, "no temp files left behind");
  const copyDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-tools-persist-"));
  await fs.cp(srv.dataDir, copyDir, { recursive: true });
  await srv.stop();

  const port = await freePort();
  const B2 = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: PAPER_ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: B2, DATA_DIR: copyDir, CHROME_PATH: "" },
    stdio: "ignore",
  });
  t.after(async () => {
    child.kill();
    await sleep(300);
    await fs.rm(copyDir, { recursive: true, force: true }).catch(() => {});
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${B2}/api/projects`)).ok) break; } catch {}
    await sleep(60);
  }
  const info = await ok(B2, "get_basic_info");
  assert.equal(info.project.id, proj.id, "the last open project reopens");
  assert.equal(info.artboards[0].name, "Saved board");
  assert.equal((await ok(B2, "find_nodes", { query: "Saved text" })).length, 1);
  assert.ok((await ok(B2, "list_fonts")).some((f) => f.family === "Inter"));
  const reloaded = (await (await fetch(`${B2}/api/comments`)).json()).find((c) => c.id === thread.id);
  assert.equal(reloaded.status, "resolved");
  assert.equal(reloaded.resolvedAt, resolved.resolvedAt, "resolved time survives a restart");
  assert.equal(reloaded.pageId, info.page.id, "page survives a restart");
  assert.equal(reloaded.layerName, "Doomed", "layer name survives a restart");
  const root = await ok(B2, "get_root_css");
  assert.deepEqual(root.vars, { "--brand": "#0000ff" }, "root CSS survives a restart");
  assert.deepEqual(root.classes, { saved: { color: "var(--brand)" } });
  assert.deepEqual(root.rules, [{ selector: ".saved:hover", styles: { color: "#000" } }, { selector: ".saved", media: "(max-width: 600px)", styles: { color: "red" } }], "states and @media survive a restart");
  const [shared] = await ok(B2, "find_nodes", { query: "Shared text" });
  assert.deepEqual((await ok(B2, "get_node_info", { nodeId: shared.id })).classes, ["saved"]);
});

test("startup survives a corrupt project file and reports it clearly", { timeout: 60_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-tools-corrupt-"));
  const page = { id: "p1", name: "Page 1", tag: "div", children: [], styles: {}, attrs: {} };
  await fs.mkdir(path.join(dir, "projects"), { recursive: true });
  await fs.writeFile(path.join(dir, "workspace.json"), JSON.stringify({
    activeProjectId: "aaaaaaaa",
    projects: [{ id: "aaaaaaaa", name: "Broken" }, { id: "bbbbbbbb", name: "Good" }],
  }));
  await fs.writeFile(path.join(dir, "projects", "aaaaaaaa.json"), "{ broken");
  await fs.writeFile(path.join(dir, "projects", "bbbbbbbb.json"), JSON.stringify({ version: 1, id: "bbbbbbbb", name: "Good", pages: ["p1"], rootId: "p1", nodes: { p1: page } }));

  const port = await freePort();
  const B = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: PAPER_ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: B, DATA_DIR: dir, CHROME_PATH: "" },
    stdio: "ignore",
  });
  t.after(async () => {
    child.kill();
    await sleep(300);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  let up = false;
  for (let i = 0; i < 150 && !up && child.exitCode === null; i++) {
    try { up = (await fetch(`${B}/api/projects`)).ok; } catch {}
    if (!up) await sleep(60);
  }
  assert.equal(up, true, "server boots even though the last active project is corrupt");
  assert.equal((await ok(B, "get_basic_info")).project.id, "bbbbbbbb", "falls back to the next readable project");
  await fails(B, "open_project", { projectId: "aaaaaaaa" }, /could not be read \(file is corrupt\)/);
  assert.equal((await ok(B, "get_basic_info")).project.id, "bbbbbbbb", "a failed open leaves the current project in place");
});

async function openBrowser(bin, url) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-tools-prof-"));
  const cdpPort = await freePort();
  const proc = spawn(bin, [
    ...(path.basename(bin).includes("headless") ? [] : ["--headless=new"]),
    "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-dev-shm-usage", "--force-device-scale-factor=1",
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });
  const kill = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      await new Promise((r) => {
        const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} r(); }, 1500);
        proc.once("exit", () => { clearTimeout(t); r(); });
      });
    }
    for (let i = 0; i < 6; i++) {
      try { await fs.rm(profileDir, { recursive: true, force: true }); break; } catch { await sleep(200); }
    }
  };
  // A cold Chrome on a busy CI runner can take well over 15s to open its DevTools port. If it never does, kill it:
  // a leaked browser keeps this test file's process alive and the whole `node --test` run hangs until CI gives up.
  let ws;
  try {
    let wsUrl;
    const deadline = Date.now() + 45_000;
    while (!wsUrl && Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`Chrome exited (${proc.exitCode})`);
      try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((p) => p.type === "page")?.webSocketDebuggerUrl; } catch {}
      if (!wsUrl) await sleep(80);
    }
    assert.ok(wsUrl, "Chrome DevTools target");
    ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  } catch (err) {
    try { ws?.close(); } catch {}
    await kill();
    throw err;
  }
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  });
  // A dead browser must fail the test, not hang it: reject in-flight calls when the socket closes or a call stalls.
  ws.addEventListener("close", () => { for (const fail of pending.values()) fail({ error: { message: "Chrome connection closed" } }); pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error(`${method}: Chrome connection closed`)); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no answer from Chrome in 30s`)); }, 30_000);
    pending.set(id, (m) => { clearTimeout(timer); if (m.error && !m.result) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
    return r.result?.result?.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await sleep(1500);
  const close = async () => {
    // Chrome often drops the socket before answering Browser.close, so never wait on the reply for long.
    await Promise.race([send("Browser.close").catch(() => {}), sleep(2000)]);
    try { ws.close(); } catch {}
    await kill();
  };
  return { evalJs, errors, close };
}

test("browser UI escapes hostile project, page, layer and text names", { skip: !findBrowser() && "no Chrome/Chromium available", timeout: 120_000 }, async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.stop());
  const B = srv.baseUrl;
  const evil = `<img src=x onerror="window.__pwn=(window.__pwn||0)+1">"'&`;

  await ok(B, "create_project", { name: evil, open: false });
  const proj = await ok(B, "create_project", { name: `${evil} open` });
  await ok(B, "update_page", { pageId: (await ok(B, "get_basic_info")).page.id, name: evil });
  await ok(B, "create_page", { name: `${evil} 2` });
  const ab = await ok(B, "create_artboard", { name: evil, width: 600, height: 400 });
  const res = await ok(B, "write_html", { parentId: ab.id, html: `<p style="padding:8px">x</p><a href="/x">link</a><img src="https://example.com/i.png" alt="x">` });
  await ok(B, "rename_nodes", { updates: res.created.map((c) => ({ nodeId: c.id, name: evil })) });
  await ok(B, "set_text_content", { updates: [{ nodeId: res.created[0].id, text: evil }] });
  await ok(B, "update_node", { nodeId: res.created[2].id, attrs: { alt: evil } });

  const ui = await openBrowser(findBrowser(), `${B}/`);
  t.after(() => ui.close());

  // Exercise every surface that renders names: layers, inspector, agents list, pages, project menu, command palette, dashboard.
  const steps = [
    `document.querySelector("#layers [data-id]")?.click()`,
    `(() => { const el = document.querySelector('[data-id="${res.created[2].id}"]'); el?.click(); })()`,
    `document.getElementById("cmdk-input") && (document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })), true)`,
    `(() => { const i = document.getElementById("cmdk-input"); i.value = "img"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
    `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
    `document.getElementById("dash-btn")?.click()`,
    `document.querySelector('[data-dash-view="list"]')?.click()`,
    `document.querySelector('[data-dash-view="grid"]')?.click()`,
    `(() => { const s = document.getElementById("dash-search"); if (s) { s.value = "<img"; s.dispatchEvent(new Event("input", { bubbles: true })); } })()`,
  ];
  for (const s of steps) {
    await ui.evalJs(s);
    await sleep(200);
  }
  await ok(B, "set_selection", { nodeIds: [res.created[0].id] });
  await ok(B, "update_styles", { updates: [{ nodeIds: [res.created[0].id], styles: { color: "#0a0b0d" } }] });
  await ok(B, "open_project", { projectId: proj.id });
  await sleep(800);

  assert.equal(await ui.evalJs("window.__pwn ?? 0"), 0, "no injected handler ran");
  assert.equal(await ui.evalJs(`document.querySelectorAll('img[src="x"]').length`), 0, "no injected <img> in the DOM");
  assert.ok((await ui.evalJs("document.body.innerText")).includes('<img src=x'), "hostile names are shown as text");
  assert.deepEqual(ui.errors, [], "no runtime errors in the UI");
});

test("stdio relay forwards MCP traffic to the HTTP server", { timeout: 60_000 }, async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.stop());

  const runRelay = async (url, messages) => {
    const relay = spawn(process.execPath, ["server/mcp-stdio.js"], { cwd: PAPER_ROOT, env: { ...process.env, PAPER_LITE_URL: url }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    relay.stdout.on("data", (d) => { out += d.toString(); });
    for (const m of messages) relay.stdin.write(`${JSON.stringify(m)}\n`);
    const want = messages.filter((m) => m.id !== undefined).length;
    for (let i = 0; i < 100; i++) {
      if (out.split("\n").filter(Boolean).length >= want) break;
      await sleep(50);
    }
    relay.stdin.end();
    relay.kill();
    return out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };

  const replies = await runRelay(`${srv.baseUrl}/mcp`, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "relay-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    // bugs.md #5: quoted / JSON-looking strings must arrive as strings through the stdio relay too.
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "register_icons", arguments: { name: "relay-dot", svg: `<svg viewBox="0 0 24 24" fill='none'><circle cx="12" cy="12" r="4" stroke="#000"/></svg>` } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_root_css", arguments: { css: `.relay-q { font-family: "Geist", 'Geist Mono', sans-serif; }` } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create_project", arguments: { name: `{"a":1} it's "quoted"` } } },
  ]);
  assert.equal(replies.find((r) => r.id === 1)?.result?.serverInfo?.name, "weft");
  assert.equal(replies.find((r) => r.id === 2)?.result?.tools?.length, EXPECTED_TOOLS.length);
  const toolResult = (id) => {
    const r = replies.find((x) => x.id === id);
    assert.ok(r?.result && !r.result.isError, `call ${id}: ${JSON.stringify(r)}`);
    return JSON.parse(r.result.content[0].text);
  };
  assert.deepEqual(toolResult(3).registered, ["relay-dot"]);
  assert.ok(toolResult(4).addedClasses.includes("relay-q"));
  const proj = toolResult(5);
  assert.equal(proj.name ?? proj.project?.name, `{"a":1} it's "quoted"`, JSON.stringify(proj));

  const port = await freePort();
  const offline = await runRelay(`http://127.0.0.1:${port}/mcp`, [{ jsonrpc: "2.0", id: 7, method: "tools/list" }]);
  assert.match(offline.find((r) => r.id === 7)?.error?.message || "", /unreachable/);
});
