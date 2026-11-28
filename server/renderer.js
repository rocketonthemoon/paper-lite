// Headless Chrome renderer (DevTools protocol over WebSocket, no puppeteer) used by MCP for
// get_screenshot, get_computed_styles, and audit_artboard. One browser + one page, requests serialized.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDomAuditScript } from "./audit.js";

// Tried in order until one starts. Real Chrome builds come before Ubuntu's /usr/bin/chromium-browser, which is often
// only a Snap wrapper that can't run headless (e.g. on CI runners).
const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/local/bin/chrome-headless-shell", "/usr/bin/chromium-headless-shell",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const START_TIMEOUT = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEND_TIMEOUT = 30_000;
// Chrome takes ~0.5–1 s to start, so it stays up between calls; it shuts down after this long with no calls.
const IDLE_MS = Number(process.env.RENDER_IDLE_MS ?? 15 * 60_000);
// Chrome can hold the profile directory briefly after exiting, so retry the removal a few times.
const removeLater = (dir, tries = 5) => setTimeout(() => fs.rm(dir, { recursive: true, force: true }, (err) => {
  if (err && tries > 1) removeLater(dir, tries - 1);
}), 500).unref();

/** Chrome went away (crashed, killed, socket dropped): the job can safely be retried on a fresh browser. */
class ConnectionLost extends Error {
  retryable = true;
}

// On Windows, killing chrome.exe leaves its helper processes running; take down the whole tree.
function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === "win32" && proc.pid) {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
  }
  try { proc.kill(); } catch {}
}

export class Renderer {
  /**
   * @param {string} baseUrl where /render/:id is served
   * @param {{ contentKey?: () => string }} opts contentKey changes whenever anything that affects rendering changes
   *   (document edits, fonts). While it and the requested artboard and size are the same, the page isn't reloaded.
   */
  constructor(baseUrl, { contentKey = null } = {}) {
    this.baseUrl = baseUrl;
    this.contentKey = contentKey;
    this.shown = null; // { key, url, width, height } of what the page currently shows
    this.queue = Promise.resolve();
    this.proc = null;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.profile = null;
    this.idleTimer = null;
    this.exe = null;
  }

  get available() {
    return CANDIDATES.some((p) => fs.existsSync(p));
  }

  /** The browser executable in use once one has started (null before). */
  get executable() {
    return this.exe ?? null;
  }

  // The socket can still look open for a moment after Chrome dies, so also require a live process.
  get connected() {
    return Boolean(this.ws && this.ws.readyState === 1 && this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  async start() {
    if (this.connected) return;
    // Once a browser has worked, keep using it; otherwise try each installed one until one starts.
    const exes = this.exe ? [this.exe] : [...new Set(CANDIDATES)].filter((p) => fs.existsSync(p));
    if (!exes.length) throw new Error("No Chrome/Chromium/Edge found for rendering — set CHROME_PATH");
    let lastErr;
    for (const exe of exes) {
      try {
        await this.launch(exe);
        if (this.exe !== exe && exes.length > 1 && exe !== exes[0]) console.warn(`[paper-lite renderer] using ${exe} (${exes[0]} did not start)`);
        this.exe = exe;
        return;
      } catch (err) {
        lastErr = err;
        if (this.exe) { this.exe = null; return this.start(); } // the remembered browser stopped working: search again
      }
    }
    throw new Error(`${lastErr.message} (tried: ${exes.join(", ")}; set CHROME_PATH to a working Chrome/Chromium)`);
  }

  async launch(exe) {
    this.stop(); // clear any half-dead browser before launching a fresh one
    this.shown = null;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "paper-lite-render-"));
    this.profile = profile;
    const isHeadlessShell = path.basename(exe).includes("headless");
    const args = [
      ...(isHeadlessShell ? [] : ["--headless=new"]),
      "--remote-debugging-port=0", `--user-data-dir=${this.profile}`, "--hide-scrollbars",
      "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check", "about:blank",
      ...(process.env.CHROME_FLAGS || "").split(" ").filter(Boolean),
    ];
    const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.proc = proc;
    // If Chrome dies (crash, OOM, killed), fail in-flight calls so the job queue never stalls, and drop its profile.
    proc.on("exit", () => {
      if (this.proc === proc) {
        this.proc = null;
        this.ws = null;
        this.failPending(new ConnectionLost("Chrome exited while rendering"));
      }
      removeLater(profile);
    });
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`Chrome did not start within ${START_TIMEOUT / 1000}s`)), START_TIMEOUT);
      proc.stderr.on("data", (d) => {
        buf += d;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
      proc.on("exit", () => { clearTimeout(timer); reject(new Error("Chrome exited during startup")); });
    }).catch((err) => { this.stop(); throw err; });
    // Don't let the browser (or helpers it leaves behind after a crash) keep Node's event loop alive.
    proc.unref();
    proc.stderr.unref?.();
    const port = new URL(wsUrl).port;
    let page;
    for (let i = 0; i < 40 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()).find((t) => t.type === "page"); } catch {}
      if (!page) await sleep(150);
    }
    if (!page) { this.stop(); throw new Error("Chrome page target not found"); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    this.ws = ws;
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`CDP connect did not finish within ${START_TIMEOUT / 1000}s`)), START_TIMEOUT);
      ws.onopen = () => { clearTimeout(timer); res(); };
      ws.onerror = () => { clearTimeout(timer); rej(new Error("CDP connect failed")); };
    }).catch((err) => { this.stop(); throw err; });
    ws.onclose = () => {
      // A late close from an older browser must not fail calls that belong to its replacement.
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending(new ConnectionLost("Lost connection to Chrome"));
    };
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
      if (!this.connected) {
        reject(new ConnectionLost("Chrome is not connected"));
        return;
      }
      const id = ++this.seq;
      // A crashed tab can leave a call unanswered forever: time out and restart the browser on the next job.
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Chrome did not answer ${method} within ${SEND_TIMEOUT / 1000}s`));
        this.stop();
      }, SEND_TIMEOUT);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  failPending(err) {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
    return r.result.value;
  }

  // Run one job at a time; if Chrome dies mid-job, retry once on a fresh browser. Shut down after IDLE_MS idle.
  run(job) {
    const next = this.queue.then(async () => {
      clearTimeout(this.idleTimer);
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await this.start();
            return await job();
          } catch (err) {
            if (!err.retryable || attempt > 0) throw err;
            this.stop();
          }
        }
      } finally {
        this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
        this.idleTimer.unref();
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  async load(artboardId, width, height, opts = {}) {
    const rawOverride = typeof opts === "number" ? opts : opts?.widthOverride;
    const wOverride = typeof rawOverride === "number" && Number.isFinite(rawOverride) && rawOverride > 0 ? Math.round(rawOverride) : null;
    const useWidthQuery = Boolean(wOverride || rawOverride === true);
    const w = Math.max(1, Math.ceil(wOverride || width)), h = Math.max(1, Math.ceil(height));
    const url = `${this.baseUrl}/render/${encodeURIComponent(artboardId)}${useWidthQuery ? `?width=${w}` : ""}`;
    const key = this.contentKey?.() ?? null;
    const prev = this.shown;
    // Same artboard, same size, nothing changed since it loaded: the page already shows it.
    if (key !== null && prev && prev.key === key && prev.url === url && prev.width === w && prev.height === h) return;
    this.shown = null; // until this load finishes
    await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((res) => {
      const prev = this.ws.onmessage;
      const t = setTimeout(res, 8000);
      this.ws.onmessage = (m) => { prev(m); if (JSON.parse(m.data).method === "Page.loadEventFired") { clearTimeout(t); this.ws.onmessage = prev; res(); } };
    });
    await this.send("Page.navigate", { url });
    await loaded;
    await this.evaluate("document.fonts.ready.then(() => true)");
    this.shown = { key, url, width: w, height: h };
  }

  /** Screenshot a node (rendered inside its artboard). Returns { png: Buffer, width, height, scale, diagnostics? }. */
  screenshot({ artboardId, nodeId, width, height, scale = 1, maxSize = 1600, widthOverride = false, diagnostics = false, checkContrast = false, checkTapTargets } = {}) {
    return this.run(async () => {
      await this.load(artboardId, width, height, { widthOverride });
      const rect = await this.evaluate(`(() => { const el = document.querySelector('[data-layer="${nodeId}"], .layer-${nodeId}'); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`);
      if (!rect || rect.w < 1 || rect.h < 1) throw new Error("Node has no visible box to capture");
      const s = Math.min(scale, maxSize / Math.max(rect.w, rect.h));
      const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
        clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: s } });
      let diag = null;
      if (diagnostics) {
        const effectiveWidth = typeof widthOverride === "number" && Number.isFinite(widthOverride) && widthOverride > 0 ? Math.round(widthOverride) : width;
        diag = await this.evaluate(buildDomAuditScript({ artboardId, width: effectiveWidth, checkContrast, checkTapTargets }));
      }
      return {
        png: Buffer.from(data, "base64"),
        width: Math.round(rect.w * s),
        height: Math.round(rect.h * s),
        scale: Number(s.toFixed(3)),
        ...(diag ? { diagnostics: diag } : {}),
      };
    });
  }

  /** Run DOM & rendering health diagnostics on an artboard (images, overflows, fonts, tap targets, contrast). */
  audit({ artboardId, width, height, widthOverride = null, checkContrast = false, checkTapTargets } = {}) {
    return this.run(async () => {
      await this.load(artboardId, width, height, widthOverride);
      const effectiveWidth = Number.isFinite(widthOverride) && widthOverride > 0 ? Math.round(widthOverride) : width;
      return this.evaluate(buildDomAuditScript({ artboardId, width: effectiveWidth, checkContrast, checkTapTargets }));
    });
  }

  /** Computed styles + layout boxes (relative to the artboard) for nodes in one artboard. */
  computed({ artboardId, nodeIds, width, height, properties }) {
    return this.run(async () => {
      await this.load(artboardId, width, height);
      const props = JSON.stringify(properties);
      return this.evaluate(`(() => { const root = document.querySelector('[data-layer="${artboardId}"], .layer-${artboardId}').getBoundingClientRect(); const out = {};
        for (const id of ${JSON.stringify(nodeIds)}) {
          const el = document.querySelector('[data-layer="' + id + '"], .layer-' + id); if (!el) { out[id] = null; continue; }
          const cs = getComputedStyle(el), r = el.getBoundingClientRect(), styles = {};
          for (const p of ${props}) { const v = cs.getPropertyValue(p); if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') styles[p] = v; }
          out[id] = { box: { x: Math.round(r.left - root.left), y: Math.round(r.top - root.top), width: Math.round(r.width), height: Math.round(r.height) }, styles };
        } return out; })()`);
    });
  }

  stop() {
    const { ws, proc } = this;
    this.shown = null;
    clearTimeout(this.idleTimer);
    this.ws = null;
    this.proc = null;
    try { ws?.close(); } catch {}
    killTree(proc);
    this.failPending(new ConnectionLost("Renderer stopped"));
    const dir = this.profile;
    this.profile = null;
    if (dir && !proc) removeLater(dir); // with a live process, its exit handler removes the profile
  }
}
