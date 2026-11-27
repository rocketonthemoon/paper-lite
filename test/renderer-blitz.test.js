// The Blitz renderer (weft-render sidecar) against headless Chrome on the same artboards, and PreferBlitz's fallbacks.
// The comparisons need the sidecar built (cargo build --release in weft-render/) and Chrome; they skip otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BlitzRenderer, PreferBlitz } from "../renderer-blitz.js";
import { Renderer } from "../renderer.js";
import { mcpCall, startServer } from "./helpers.js";

const blitzBuilt = new BlitzRenderer("http://127.0.0.1:1").available;
const chromeFound = new Renderer("http://127.0.0.1:1").available;

// Lengths agree to within Chrome's layout unit (1/64 px): Chrome reports 190.656px where Blitz says 190.667px.
const sameStyles = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => {
  const [x, y] = [a[k], b[k]].map((v) => /^-?[\d.]+px$/.test(v ?? "") ? parseFloat(v) : v);
  return typeof x === "number" && typeof y === "number" ? Math.abs(x - y) <= 0.02 : x === y;
});

// PNG size from the IHDR chunk.
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

test("Blitz renders artboards like headless Chrome (boxes, styles, screenshot size)", {
  skip: (!blitzBuilt && "weft-render not built") || (!chromeFound && "no Chrome"), timeout: 120_000,
}, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-blitz-"));
  const srv = await startServer(dataDir);
  const chrome = new Renderer(srv.baseUrl), blitz = new BlitzRenderer(srv.baseUrl);
  t.after(async () => { chrome.stop(); blitz.stop(); await srv.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const call = (name, args) => mcpCall(srv.baseUrl, name, args);
  await call("update_root_css", { vars: { "--gap": "12px" }, classes: { tile: { height: "60px", borderRadius: "8px", backgroundColor: "#eef" } } });
  const ab = await call("create_artboard", { name: "Compare", width: 640, height: 400 });
  // Boxes only (no text), so font differences between the engines can't move anything.
  await call("write_html", { parentId: ab.id, html: `<section data-name="Wrap" style="display:flex;flex-direction:column;gap:var(--gap);padding:24px">
    <div data-name="Row" style="display:flex;justify-content:space-between;align-items:center"><div data-name="A" style="width:120px;height:40px;background:#36f;border-radius:20px"></div><div data-name="B" style="width:80px;height:24px;border:2px solid #333"></div></div>
    <div data-name="Grid" style="display:grid;grid-template-columns:repeat(3, 1fr);gap:10px"><div data-name="T1" class="tile"></div><div class="tile"></div><div class="tile"></div></div>
  </section><div data-name="Badge" style="position:absolute;right:16px;bottom:16px;width:24px;height:24px;border-radius:50%;background:#f60;opacity:0.8"></div>` });
  const s = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  const ids = Object.values(s.nodes).filter((n) => n.id === ab.id || ["Wrap", "Row", "A", "B", "Grid", "T1", "Badge"].includes(n.name)).map((n) => n.id);
  const args = { artboardId: ab.id, nodeIds: ids, width: 640, height: 400,
    properties: ["display", "position", "flex-direction", "justify-content", "align-items", "width", "height", "padding", "background-color", "border-radius", "opacity", "row-gap", "column-gap"] };

  const fromChrome = await chrome.computed(args);
  const fromBlitz = await blitz.computed(args);
  for (const id of ids) {
    assert.deepEqual(fromBlitz[id].box, fromChrome[id].box, `box of ${s.nodes[id].name}`);
    assert.ok(sameStyles(fromBlitz[id].styles, fromChrome[id].styles), `styles of ${s.nodes[id].name}: ${JSON.stringify(fromBlitz[id].styles)} vs ${JSON.stringify(fromChrome[id].styles)}`);
  }

  const shotC = await chrome.screenshot({ artboardId: ab.id, nodeId: ab.id, width: 640, height: 400 });
  const shotB = await blitz.screenshot({ artboardId: ab.id, nodeId: ab.id, width: 640, height: 400 });
  assert.deepEqual(pngSize(shotB.png), pngSize(shotC.png));
  assert.deepEqual({ width: shotB.width, height: shotB.height, scale: shotB.scale }, { width: shotC.width, height: shotC.height, scale: shotC.scale });
  // A layer inside the artboard is cropped to its own box, and scale / maxSize apply as in Chrome.
  const tile = ids.find((id) => s.nodes[id].name === "T1");
  const small = await blitz.screenshot({ artboardId: ab.id, nodeId: tile, width: 640, height: 400, scale: 2 });
  const smallC = await chrome.screenshot({ artboardId: ab.id, nodeId: tile, width: 640, height: 400, scale: 2 });
  assert.deepEqual(pngSize(small.png), pngSize(smallC.png));
  const capped = await blitz.screenshot({ artboardId: ab.id, nodeId: ab.id, width: 640, height: 400, maxSize: 320 });
  assert.deepEqual([capped.width, capped.height, capped.scale], [320, 200, 0.5]);
});

test("PreferBlitz: Chrome for unsupported CSS, a missing sidecar or a Blitz error", async () => {
  const calls = [];
  const fake = (name, { available = true, fail = false } = {}) => ({
    available,
    screenshot: async (a) => { calls.push(`${name}:screenshot:${a.artboardId}`); if (fail) throw new Error(`${name} broke`); return name; },
    computed: async (a) => { calls.push(`${name}:computed:${a.artboardId}`); return name; },
    audit: async (a) => { calls.push(`${name}:audit:${a.artboardId}`); return name; },
    stop: () => calls.push(`${name}:stop`),
  });
  const fallbacks = [];
  let r = new PreferBlitz(fake("blitz"), fake("chrome"), {
    unsupported: ({ artboardId }) => (artboardId === "blurry" ? "uses filter" : null),
    onFallback: (method, err) => fallbacks.push(`${method}: ${err.message}`),
  });
  assert.equal(await r.screenshot({ artboardId: "plain" }), "blitz");
  assert.equal(await r.computed({ artboardId: "blurry" }), "chrome", "unsupported CSS goes to Chrome");
  assert.equal(await r.audit({ artboardId: "plain" }), "chrome", "audits always run in Chrome");
  assert.equal(await r.screenshot({ artboardId: "plain", diagnostics: true }), "chrome", "screenshot diagnostics run in Chrome");
  assert.deepEqual(calls, ["blitz:screenshot:plain", "chrome:computed:blurry", "chrome:audit:plain", "chrome:screenshot:plain"]);
  assert.deepEqual(fallbacks, [], "routing by CSS is not a failure");

  calls.length = 0;
  r = new PreferBlitz(fake("blitz", { fail: true }), fake("chrome"), { onFallback: (m, e) => fallbacks.push(`${m}: ${e.message}`) });
  assert.equal(await r.screenshot({ artboardId: "x" }), "chrome");
  assert.deepEqual(calls, ["blitz:screenshot:x", "chrome:screenshot:x"]);
  assert.deepEqual(fallbacks, ["screenshot: blitz broke"]);

  calls.length = 0;
  r = new PreferBlitz(fake("blitz", { available: false }), fake("chrome"));
  assert.equal(await r.computed({ artboardId: "y" }), "chrome");
  assert.deepEqual(calls, ["chrome:computed:y"], "a missing sidecar isn't tried");
  r.stop();
  assert.deepEqual(calls.slice(1), ["blitz:stop", "chrome:stop"]);
});

test("RENDERER=blitz: MCP screenshots and computed styles go through Blitz", {
  skip: !blitzBuilt && "weft-render not built", timeout: 120_000,
}, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weft-blitz-srv-"));
  // No Chrome at all (CHROME_PATH is a file that isn't a browser), so only Blitz can answer.
  const srv = await startServer(dataDir, { RENDERER: "blitz", CHROME_PATH: process.execPath, TAB_MEASURE_MS: "0" });
  t.after(async () => { await srv.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const ab = await mcpCall(srv.baseUrl, "create_artboard", { name: "Shot", width: 300, height: 200 });
  await mcpCall(srv.baseUrl, "write_html", { parentId: ab.id, html: `<div data-name="Box" style="margin:20px;width:100px;height:50px;background:#36f"></div>` });
  const res = await fetch(`${srv.baseUrl}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_screenshot", arguments: { nodeId: ab.id } } }),
  });
  const raw = await res.text();
  const body = JSON.parse(raw.split(/\r?\n/).find((l) => l.startsWith("data: ")).slice(6));
  const img = body.result.content.find((c) => c.type === "image");
  assert.ok(img, JSON.stringify(body).slice(0, 300));
  assert.deepEqual(pngSize(Buffer.from(img.data, "base64")), { width: 300, height: 200 });
  const s = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  const box = Object.values(s.nodes).find((n) => n.name === "Box");
  const cs = await mcpCall(srv.baseUrl, "get_computed_styles", { nodeIds: [box.id], properties: ["width", "background-color"] });
  assert.deepEqual(cs[box.id], { box: { x: 20, y: 20, width: 100, height: 50 }, styles: { width: "100px", "background-color": "rgb(51, 102, 255)" } });
});
