// Headless Chrome renderer (DevTools protocol over WebSocket, no puppeteer) used by MCP for
// get_screenshot and get_computed_styles. One browser + one page, requests serialized.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/local/bin/chrome-headless-shell", "/usr/bin/chromium-headless-shell",
  "/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Renderer {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.queue = Promise.resolve();
    this.proc = null;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.profile = null;
    this.idleTimer = null;
  }

  get available() {
    return CANDIDATES.some((p) => fs.existsSync(p));
  }

  async start() {
    if (this.ws && this.ws.readyState === 1) return;
    const exe = CANDIDATES.find((p) => fs.existsSync(p));
    if (!exe) throw new Error("No Chrome/Chromium/Edge found for rendering — set CHROME_PATH");
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), "paper-lite-render-"));
    const isHeadlessShell = path.basename(exe).includes("headless");
    const args = [
      ...(isHeadlessShell ? [] : ["--headless=new"]),
      "--remote-debugging-port=0", `--user-data-dir=${this.profile}`, "--hide-scrollbars",
      "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check", "about:blank",
      ...(process.env.CHROME_FLAGS || "").split(" ").filter(Boolean),
    ];
    this.proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.proc.on("exit", () => { this.ws = null; this.proc = null; });
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("Chrome did not start within 15s")), 15000);
      this.proc.stderr.on("data", (d) => {
        buf += d;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      this.proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    const port = new URL(wsUrl).port;
    let page;
    for (let i = 0; i < 40 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
      if (!page) await sleep(150);
    }
    if (!page) throw new Error("Chrome page target not found");
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("CDP connect failed")); });
    this.ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      const p = d.id && this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result);
    };
    await this.send("Page.enable");
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
    return r.result.value;
  }

  // Run one job at a time; shut the browser down after 2 idle minutes.
  run(job) {
    const next = this.queue.then(async () => {
      clearTimeout(this.idleTimer);
      await this.start();
      try {
        return await job();
      } finally {
        this.idleTimer = setTimeout(() => this.stop(), 120000);
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  async load(artboardId, width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", { width: Math.max(1, Math.ceil(width)), height: Math.max(1, Math.ceil(height)), deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((res) => {
      const prev = this.ws.onmessage;
      const t = setTimeout(res, 8000);
      this.ws.onmessage = (m) => { prev(m); if (JSON.parse(m.data).method === "Page.loadEventFired") { clearTimeout(t); this.ws.onmessage = prev; res(); } };
    });
    await this.send("Page.navigate", { url: `${this.baseUrl}/render/${encodeURIComponent(artboardId)}` });
    await loaded;
    await this.evaluate("document.fonts.ready.then(() => true)");
  }

  /** Screenshot a node (rendered inside its artboard). Returns { png: Buffer, width, height, scale }. */
  screenshot({ artboardId, nodeId, width, height, scale = 1, maxSize = 1600 }) {
    return this.run(async () => {
      await this.load(artboardId, width, height);
      const rect = await this.evaluate(`(() => { const el = document.querySelector('.layer-${nodeId}'); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`);
      if (!rect || rect.w < 1 || rect.h < 1) throw new Error("Node has no visible box to capture");
      const s = Math.min(scale, maxSize / Math.max(rect.w, rect.h));
      const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
        clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: s } });
      return { png: Buffer.from(data, "base64"), width: Math.round(rect.w * s), height: Math.round(rect.h * s), scale: Number(s.toFixed(3)) };
    });
  }

  /** Computed styles + layout boxes (relative to the artboard) for nodes in one artboard. */
  computed({ artboardId, nodeIds, width, height, properties }) {
    return this.run(async () => {
      await this.load(artboardId, width, height);
      const props = JSON.stringify(properties);
      return this.evaluate(`(() => { const root = document.querySelector('.layer-${artboardId}').getBoundingClientRect(); const out = {};
        for (const id of ${JSON.stringify(nodeIds)}) {
          const el = document.querySelector('.layer-' + id); if (!el) { out[id] = null; continue; }
          const cs = getComputedStyle(el), r = el.getBoundingClientRect(), styles = {};
          for (const p of ${props}) { const v = cs.getPropertyValue(p); if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') styles[p] = v; }
          out[id] = { box: { x: Math.round(r.left - root.left), y: Math.round(r.top - root.top), width: Math.round(r.width), height: Math.round(r.height) }, styles };
        } return out; })()`);
    });
  }

  stop() {
    try { this.ws?.close(); } catch {}
    try { this.proc?.kill(); } catch {}
    this.ws = null;
    this.proc = null;
    const dir = this.profile;
    this.profile = null;
    if (dir) setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 1500);
  }
}
