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

const PAPER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECTED_TOOLS = [
  "add_font", "create_artboard", "create_node", "create_page", "create_project", "delete_nodes", "delete_page",
  "delete_project", "duplicate_nodes", "duplicate_project", "find_nodes", "finish_working_on_nodes", "get_basic_info",
  "get_children", "get_comments", "get_computed_styles", "get_guide", "get_jsx", "get_node_info", "get_screenshot",
  "get_selection", "get_tree_summary", "list_checkpoints", "list_fonts", "list_projects", "move_nodes", "open_project",
  "redo", "remove_font", "rename_nodes", "rename_project", "reply_to_comment", "resolve_comment", "restore_checkpoint",
  "save_checkpoint", "set_selection", "set_session_title", "set_text_content", "switch_page", "undo", "update_node",
  "update_page", "update_styles", "write_html",
];

// Markup an attacker could put in layer names / text to break out of exported or rendered HTML.
const XSS = `</style><script>window.__pwn=1</script><img src=x onerror="window.__pwn=1">*/`;

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
  const child = spawn(process.execPath, ["server.js"], {
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

  await t.test("tools/list exposes exactly the 44 documented tools with schemas", async () => {
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
  let board, section, title, para, button;
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
    assert.ok(res.warnings.some((w) => /class/.test(w)), "class attribute warns");
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
    assert.equal((await ok(B, "find_nodes", { tag: "div", limit: 1 })).length, 1);

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
  });

  await t.test("structure tools: create_node, duplicate_nodes, move_nodes, delete_nodes", async () => {
    const extra = await ok(B, "create_node", { parentId: section, tag: "img", name: "Logo", attrs: { src: "https://example.com/logo.png", alt: "Logo" }, text: "ignored?", index: 0 });
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
    assert.deepEqual(await ok(B, "undo"), { undone: true });
    assert.equal(await countLayers(), before, "one write_html = one undo step");
    assert.deepEqual(await ok(B, "redo"), { redone: true });
    assert.equal(await countLayers(), before + 3);
    await ok(B, "delete_nodes", { nodeIds: [res.created[0].id] });

    // A human edit through the REST API lands in the same stack.
    await fetch(`${B}/api/nodes/${title}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Human edit" }) });
    assert.equal((await ok(B, "get_node_info", { nodeId: title })).name, "Human edit");
    await ok(B, "undo");
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
    await fails(B, "get_screenshot", { nodeId: "ghost" }, /not found/);
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
  await sleep(300);

  // Restart against the same data directory.
  const files = await fs.readdir(path.join(srv.dataDir, "projects"));
  assert.ok(files.includes(`${proj.id}.json`));
  assert.equal(files.some((f) => f.endsWith(".tmp")), false, "no temp files left behind");
  const copyDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-tools-persist-"));
  await fs.cp(srv.dataDir, copyDir, { recursive: true });
  await srv.stop();

  const port = await freePort();
  const B2 = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
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
  const child = spawn(process.execPath, ["server.js"], {
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
    const relay = spawn(process.execPath, ["mcp-stdio.js"], { cwd: PAPER_ROOT, env: { ...process.env, PAPER_LITE_URL: url }, stdio: ["pipe", "pipe", "pipe"] });
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
  ]);
  assert.equal(replies.find((r) => r.id === 1)?.result?.serverInfo?.name, "weft");
  assert.equal(replies.find((r) => r.id === 2)?.result?.tools?.length, EXPECTED_TOOLS.length);

  const port = await freePort();
  const offline = await runRelay(`http://127.0.0.1:${port}/mcp`, [{ jsonrpc: "2.0", id: 7, method: "tools/list" }]);
  assert.match(offline.find((r) => r.id === 7)?.error?.message || "", /unreachable/);
});
