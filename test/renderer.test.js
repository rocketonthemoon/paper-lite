// The headless renderer must recover when Chrome dies, before or during a job, instead of stalling its queue.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Renderer } from "../server/renderer.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Each step's limit must exceed the renderer's own worst case (start ≤ 15 s, page lookup, one CDP call ≤ 30 s),
// or a slow cold start on a busy CI runner (other suites start Chrome at the same time) fails the test spuriously.
const STEP_MS = 90_000;
const withTimeout = (p, ms, label) => {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} hung for ${ms}ms`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
};

test("renderer recovers after Chrome exits between and during jobs", { timeout: 600_000 }, async (t) => {
  const probe = new Renderer("http://127.0.0.1:1");
  if (!probe.available) {
    t.skip("no Chrome/Chromium available");
    return;
  }

  // Minimal stand-in for the /render/:id endpoint.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body style="margin:0"><div class="layer-board" style="width:300px;height:200px;background:#0000ff">
      <div class="layer-box" style="width:100px;height:50px;background:#fff"></div></div></body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const renderer = new Renderer(`http://127.0.0.1:${server.address().port}`);
  t.after(() => { renderer.stop(); server.close(); });

  const shot = () => renderer.screenshot({ artboardId: "board", nodeId: "box", width: 300, height: 200 });

  const first = await withTimeout(shot(), STEP_MS, "first screenshot");
  assert.equal(first.width, 100);
  assert.equal(first.height, 50);

  // Chrome dies while idle: the next job starts a fresh browser.
  renderer.proc.kill("SIGKILL");
  await sleep(500);
  const second = await withTimeout(shot(), STEP_MS, "screenshot after Chrome exited");
  assert.equal(second.width, 100);

  // Chrome dies mid-job: that job fails fast, and the queue keeps working.
  const during = shot();
  await sleep(30);
  renderer.proc?.kill("SIGKILL");
  await withTimeout(during.then(() => "ok", () => "failed"), STEP_MS, "job interrupted by Chrome exit");
  const third = await withTimeout(shot(), STEP_MS, "screenshot after mid-job crash");
  assert.equal(third.width, 100);

  const computed = await withTimeout(renderer.computed({ artboardId: "board", nodeIds: ["box"], width: 300, height: 200, properties: ["width"] }), STEP_MS, "computed");
  assert.deepEqual(computed.box.box, { x: 0, y: 0, width: 100, height: 50 });
});

test("renderer falls back to the next browser when one fails to start", { timeout: 120_000 }, async (t) => {
  if (!new Renderer("http://127.0.0.1:1").available) {
    t.skip("no Chrome/Chromium available");
    return;
  }
  // Point CHROME_PATH at something that is not a browser (Node exits on Chrome's flags), then load a fresh copy
  // of the module so its candidate list picks that up first.
  const saved = process.env.CHROME_PATH;
  process.env.CHROME_PATH = process.execPath;
  const { Renderer: FreshRenderer } = await import(`../server/renderer.js?fallback=${Date.now()}`);
  if (saved === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = saved;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<div class="layer-board" style="width:120px;height:80px;background:#0000ff"></div>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const renderer = new FreshRenderer(`http://127.0.0.1:${server.address().port}`);
  t.after(() => { renderer.stop(); server.close(); });

  const shot = await withTimeout(renderer.screenshot({ artboardId: "board", nodeId: "board", width: 120, height: 80 }), 40_000, "screenshot with a broken first candidate");
  assert.equal(shot.width, 120);
  assert.notEqual(renderer.executable, process.execPath, "a real browser was used");
});

test("renderer reuses the loaded page only while the content key and size are unchanged", { timeout: 120_000 }, async (t) => {
  const probe = new Renderer("http://127.0.0.1:1");
  if (!probe.available) {
    t.skip("no Chrome/Chromium available");
    return;
  }
  let color = "#0000ff", loads = 0;
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith("/render/")) { res.writeHead(404); return res.end(); } // e.g. /favicon.ico
    loads += 1;
    res.writeHead(200, { "content-type": "text/html" });
    const w = req.url.includes("wide") ? 400 : 300;
    res.end(`<!doctype html><html><body style="margin:0"><div data-layer="${req.url.split("/").pop()}" style="width:${w}px;height:200px;background:${color}"></div></body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let version = 1;
  const renderer = new Renderer(`http://127.0.0.1:${server.address().port}`, { contentKey: () => `v${version}` });
  t.after(() => { renderer.stop(); server.close(); });
  const bg = async (id = "board", width = 300) =>
    (await renderer.computed({ artboardId: id, nodeIds: [id], width, height: 200, properties: ["background-color", "width"] }))[id].styles;

  assert.equal((await bg())["background-color"], "rgb(0, 0, 255)");
  assert.equal(loads, 1);
  await bg();
  await renderer.screenshot({ artboardId: "board", nodeId: "board", width: 300, height: 200 });
  assert.equal(loads, 1, "unchanged content: no reload");

  color = "#ff0000";
  version = 2; // an edit
  assert.equal((await bg())["background-color"], "rgb(255, 0, 0)", "edit shows up on the next call");
  assert.equal(loads, 2);

  assert.equal((await bg("wide", 400)).width, "400px", "another artboard loads its own page");
  assert.equal(loads, 3);
  await bg("wide", 500);
  assert.equal(loads, 4, "a different viewport size reloads");

  renderer.stop(); // after a restart nothing is assumed to be loaded
  await bg("wide", 500);
  assert.equal(loads, 5);
});

test("renderer.audit and screenshot({ diagnostics: true }) detect broken images, overflow, fonts, tap targets, and contrast", { timeout: 120_000 }, async (t) => {
  const probe = new Renderer("http://127.0.0.1:1");
  if (!probe.available) {
    t.skip("no Chrome/Chromium available");
    return;
  }
  const server = http.createServer((req, res) => {
    if (req.url === "/broken.png") { res.writeHead(404); return res.end(); }
    if (!req.url.startsWith("/render/")) { res.writeHead(404); return res.end(); }
    const u = new URL(req.url, "http://127.0.0.1");
    const w = Number(u.searchParams.get("width")) || 390;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body style="margin:0;background:#fff">
      <div data-layer="ab1" style="width:${w}px;height:600px;overflow:hidden;background:#ffffff">
        <img data-layer="img1" src="/broken.png" alt="Missing" style="width:40px;height:40px;display:block">
        <div data-layer="over1" style="width:200px;white-space:nowrap;font-family:Arial,sans-serif">This text intentionally overflows a 200px wide box without wrapping at all in the viewport</div>
        <div data-layer="clip1" style="width:120px;height:20px;overflow:hidden;font-family:Arial,sans-serif">Line 1<br>Line 2<br>Line 3</div>
        <p data-layer="font1" style="font-family:'NonExistentTestFont',sans-serif;color:#111111;margin:0">Unloaded font</p>
        <p data-layer="lowc1" style="font-family:Arial,sans-serif;font-size:14px;color:#b0b0b0;margin:0">Faint copy</p>
        <button data-layer="btn1" style="width:28px;height:28px;font-family:Arial,sans-serif">Ok</button>
      </div>
    </body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const renderer = new Renderer(`http://127.0.0.1:${server.address().port}`);
  t.after(() => { renderer.stop(); server.close(); });

  const audit = await withTimeout(
    renderer.audit({ artboardId: "ab1", width: 800, height: 600, widthOverride: 390, checkContrast: true }),
    40_000,
    "audit",
  );
  assert.equal(audit.ok, false);
  assert.equal(audit.width, 390);
  assert.equal(audit.brokenImages.length, 1);
  assert.equal(audit.brokenImages[0].nodeId, "img1");
  assert.ok(audit.overflows.some((o) => o.nodeId === "over1"));
  assert.ok(audit.overflows.some((o) => o.nodeId === "clip1" && o.type === "clipped"));
  assert.ok(audit.missingFonts.some((f) => f.family === "NonExistentTestFont"));
  assert.ok(audit.tapTargets.some((b) => b.nodeId === "btn1" && b.width === 28));
  assert.ok(audit.lowContrast.some((c) => c.nodeId === "lowc1" && c.ratio < 4.5));

  const shot = await withTimeout(
    renderer.screenshot({ artboardId: "ab1", nodeId: "ab1", width: 390, height: 600, diagnostics: true, checkContrast: true }),
    40_000,
    "screenshot with diagnostics",
  );
  assert.ok(shot.png.length > 0);
  assert.equal(shot.diagnostics.ok, false);
  assert.equal(shot.diagnostics.summary.brokenImages, 1);
});
