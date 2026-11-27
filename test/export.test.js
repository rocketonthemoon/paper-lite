// Exports stay small: identical layer styles share one rule, repeated SVGs become one <symbol>, and in JSX repeated
// subtrees become one component and repeated inline styles one `styles` entry.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { api, mcpCall, startServer } from "./helpers.js";

// Uncompressed text of each file in a PKZIP buffer.
function unzip(buf) {
  const files = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28);
    const el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    const lh = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(lh, lh + csize);
    if (!name.endsWith("/")) files[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    p += 46 + nl + el + cl;
  }
  return files;
}

const ICON = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="${d}" stroke="#333" stroke-width="2"/></svg>`;
const SIDEBAR = `<aside data-name="Sidebar" style="width:200px;display:flex;flex-direction:column;gap:4px">${
  [0, 1, 2].map((i) => `<div data-name="Nav item ${i}" style="display:flex;gap:8px;padding:8px">${ICON(`M${i} 0L24 24`)}<span style="font-size:14px">Item ${i}</span></div>`).join("")
}</aside>`;

test("exports share rules, icons and components instead of repeating them", { timeout: 60_000 }, async (t) => {
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

  await t.test("JSX: repeated subtrees become components, repeated styles one styles entry", async () => {
    const jsx = await text(`/api/export?format=jsx&nodeId=${s.rootId}`);
    assert.match(jsx, /^const styles = \{\n/);
    assert.match(jsx, /^ {2}navItem: \{ display: "flex", gap: "8px", padding: "8px" \},$/m);
    assert.equal((jsx.match(/style=\{styles\.navItem\}/g) || []).length, 3, "inside the one Sidebar component");
    assert.equal((jsx.match(/^function Sidebar\(\)/gm) || []).length, 1);
    assert.equal((jsx.match(/<Sidebar \/>/g) || []).length, 2);
    assert.match(jsx, /^function Icon\(\)/m, "the icon used in sidebars and mains is a component");
    assert.match(jsx, /^export function Home\(\)/m);
    assert.match(jsx, /^export function Billing\(\)/m);
    assert.match(jsx, /<aside style=\{\{ width: "200px", display: "flex", flexDirection: "column", gap: "4px" \}\}>/, "a style used once stays inline");
    // Icons only used inside the (now single) sidebar are not split out.
    assert.equal((jsx.match(/^function \w+\(\)/gm) || []).length, 2, "Sidebar + Icon only");
  });

  await t.test("ZIP: shared components live in components/ and screens import them", async () => {
    const files = unzip(Buffer.from(await (await fetch(`${srv.baseUrl}/api/export/zip?format=both`)).arrayBuffer()));
    assert.ok(files["components/Sidebar.jsx"].startsWith('import { Icon } from "./Icon.jsx";'));
    assert.match(files["components/Sidebar.jsx"], /^export function Sidebar\(\)/m);
    assert.match(files["components/Icon.jsx"], /^export function Icon\(\)/m);
    const home = files["page-1/home.jsx"];
    assert.match(home, /^import "\.\.\/tokens\.css";\nimport "\.\.\/components\.css";\nimport \{ Sidebar \} from "\.\.\/components\/Sidebar\.jsx";\nimport \{ Icon \} from "\.\.\/components\/Icon\.jsx";/);
    assert.doesNotMatch(home, /style=/, "with the shared stylesheet, JSX uses class names only");
    assert.match(files["page-1/home.html"], /<symbol id="icon-1"/, "screens keep their icons inline (they open from disk)");
    // icons.svg: each distinct icon in the project once, self-contained (attributes and inline styles, no classes).
    const sprite = files["icons.svg"];
    assert.match(sprite, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg">/);
    assert.equal((sprite.match(/<symbol id="icon-[a-z0-9-]+" viewBox="0 0 24 24"[^>]*>/g) || []).length, 3, "three distinct icons");
    for (const d of ["M0 0L24 24", "M1 0L24 24", "M2 0L24 24"]) assert.equal(sprite.split(`d="${d}"`).length - 1, 1, `${d} once`);
    assert.match(sprite, /stroke="#333"/);
    assert.match(sprite, /<symbol id="[^"]+" viewBox="0 0 24 24" fill="none">/, "the outer svg's paint carries over (not its size)");
    assert.doesNotMatch(sprite, /<symbol[^>]* width=/);
    assert.doesNotMatch(sprite, /class=/);
    const ids = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, "unique symbol ids");
  });

  await t.test("icons aren't shared when the root CSS styles SVG content (selectors wouldn't reach into <use>)", async () => {
    await call("PATCH", "/api/root-css", { css: ".nav:hover path { stroke: red; }" });
    const html = await text(`/api/export?format=html&nodeId=${s.rootId}`);
    assert.doesNotMatch(html, /<use |<symbol /);
    assert.equal((html.match(/M0 0L24 24/g) || []).length, 4);
  });
});
