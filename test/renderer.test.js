// The headless renderer must recover when Chrome dies, before or during a job, instead of stalling its queue.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Renderer } from "../renderer.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} hung for ${ms}ms`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
};

test("renderer recovers after Chrome exits between and during jobs", async (t) => {
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

  const first = await withTimeout(shot(), 30_000, "first screenshot");
  assert.equal(first.width, 100);
  assert.equal(first.height, 50);

  // Chrome dies while idle: the next job starts a fresh browser.
  renderer.proc.kill("SIGKILL");
  await sleep(500);
  const second = await withTimeout(shot(), 30_000, "screenshot after Chrome exited");
  assert.equal(second.width, 100);

  // Chrome dies mid-job: that job fails fast, and the queue keeps working.
  const during = shot();
  await sleep(30);
  renderer.proc?.kill("SIGKILL");
  await withTimeout(during.then(() => "ok", () => "failed"), 30_000, "job interrupted by Chrome exit");
  const third = await withTimeout(shot(), 30_000, "screenshot after mid-job crash");
  assert.equal(third.width, 100);

  const computed = await withTimeout(renderer.computed({ artboardId: "board", nodeIds: ["box"], width: 300, height: 200, properties: ["width"] }), 30_000, "computed");
  assert.deepEqual(computed.box.box, { x: 0, y: 0, width: 100, height: 50 });
});

test("renderer falls back to the next browser when one fails to start", async (t) => {
  if (!new Renderer("http://127.0.0.1:1").available) {
    t.skip("no Chrome/Chromium available");
    return;
  }
  // Point CHROME_PATH at something that is not a browser (Node exits on Chrome's flags), then load a fresh copy
  // of the module so its candidate list picks that up first.
  const saved = process.env.CHROME_PATH;
  process.env.CHROME_PATH = process.execPath;
  const { Renderer: FreshRenderer } = await import(`../renderer.js?fallback=${Date.now()}`);
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
