// Exports stay small: identical layer styles share one rule and repeated SVGs become one <symbol>.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { api, mcpCall, startServer } from "./helpers.js";

const ICON = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="${d}" stroke="#333" stroke-width="2"/></svg>`;
const SIDEBAR = `<aside data-name="Sidebar" style="width:200px;display:flex;flex-direction:column;gap:4px">${
  [0, 1, 2].map((i) => `<div data-name="Nav item ${i}" style="display:flex;gap:8px;padding:8px">${ICON(`M${i} 0L24 24`)}<span style="font-size:14px">Item ${i}</span></div>`).join("")
}</aside>`;

test("exports share rules and icons instead of repeating them", { timeout: 60_000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-export-"));
  const srv = await startServer(dataDir);
  t.after(async () => { await srv.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const call = api(srv.baseUrl);
  const text = async (url) => (await fetch(srv.baseUrl + url)).text();

  for (const name of ["Home", "Billing"]) {
    const ab = await mcpCall(srv.baseUrl, "create_artboard", { name, width: 800, height: 600 });
    await mcpCall(srv.baseUrl, "write_html", { parentId: ab.id, html: `${SIDEBAR}<main data-name="Main" style="padding:24px"><h1 style="font-size:24px">${name}</h1>${ICON("M0 0L24 24")}</main>` });
  }
  const s = await call("GET", "/api/state");

  await t.test("HTML: one rule per distinct style, one <symbol> per repeated icon", async () => {
    const html = await text(`/api/export?format=html&nodeId=${s.rootId}`);
    const navRules = html.match(/\{\n {2}display: flex;\n {2}gap: 8px;\n {2}padding: 8px;\n\}/g) || [];
    assert.equal(navRules.length, 1, "six nav items share one rule");
    const navItem = Object.values(s.nodes).find((n) => n.name === "Nav item 0");
    const cls = html.match(new RegExp(`(layer-\\w+) \\{\\n {2}display: flex;\\n {2}gap: 8px;`))[1];
    assert.equal((html.match(new RegExp(`class="${cls}"`, "g")) || []).length, 6);
    assert.ok(navItem);
    // "M0 0L24 24" appears in both sidebars and both mains: 4 times, one symbol. The other two icons: 2 each.
    assert.equal((html.match(/<symbol /g) || []).length, 3);
    assert.equal((html.match(/<use href="#icon-\d+"\/>/g) || []).length, 8);
    assert.equal((html.match(/M0 0L24 24/g) || []).length, 1, "path data written once");
  });

  await t.test("the canvas renderer page never uses <use> (it needs every layer as a real element)", async () => {
    const page = await text(`/render/${s.nodes[s.rootId].children[0]}`);
    assert.doesNotMatch(page, /<use |<symbol /);
    assert.match(page, /data-layer="/);
  });

  await t.test("icons aren't shared when the root CSS styles SVG content (selectors wouldn't reach into <use>)", async () => {
    await call("PATCH", "/api/root-css", { css: ".nav:hover path { stroke: red; }" });
    const html = await text(`/api/export?format=html&nodeId=${s.rootId}`);
    assert.doesNotMatch(html, /<use |<symbol /);
    assert.equal((html.match(/M0 0L24 24/g) || []).length, 4);
  });
});
