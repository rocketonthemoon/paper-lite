// Blitz renderer: the weft-render sidecar (Rust, weft-render/) renders artboards with Blitz, an HTML/CSS engine
// without a browser or JavaScript, for get_screenshot and get_computed_styles. It is opt-in (RENDERER=blitz) while it
// is benchmarked against headless Chrome; PreferBlitz falls back to Chrome for any call Blitz can't answer.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = process.platform === "win32" ? "weft-render.exe" : "weft-render";
const CANDIDATES = [
  process.env.WEFT_RENDER_PATH,
  path.join(HERE, "weft-render", "target", "release", EXE),
  path.join(HERE, "bin", EXE), // where the Docker image puts it
].filter(Boolean);
const IDLE_MS = Number(process.env.RENDER_IDLE_MS ?? 15 * 60_000);
const CALL_TIMEOUT = 30_000;

export class BlitzRenderer {
  /**
   * Same arguments as Renderer (renderer.js): where /render/:id is served, and a key that changes with the content.
   * `assetsKey` changes when fetched files (fonts.css, fonts) may have changed; the sidecar caches them until then.
   */
  constructor(baseUrl, { contentKey = null, assetsKey = () => "" } = {}) {
    this.baseUrl = baseUrl;
    this.contentKey = contentKey;
    this.assetsKey = assetsKey;
    this.proc = null;
    this.buf = "";
    this.seq = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.shown = null; // { key, url, width, height } of the document the sidecar has laid out
    this.idleTimer = null;
  }

  get executable() {
    return CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
  }

  get available() {
    return Boolean(this.executable);
  }

  start() {
    if (this.proc && this.proc.exitCode === null) return;
    const exe = this.executable;
    if (!exe) throw new Error("weft-render not found (build it with `cargo build --release` in weft-render/, or set WEFT_RENDER_PATH)");
    const proc = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.shown = null;
    this.buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
      }
    });
    proc.stderr.on("data", () => {}); // Blitz logs warnings about unsupported CSS here
    const gone = (why) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.shown = null;
      const all = [...this.pending.values()];
      this.pending.clear();
      for (const p of all) p.reject(new Error(why));
    };
    proc.on("error", (err) => gone(`weft-render failed: ${err.message}`));
    proc.on("exit", (code, sig) => gone(`weft-render exited (${sig || code})`));
    proc.stdin.on("error", () => {});
    proc.unref();
    proc.stdout.unref?.();
    proc.stderr.unref?.();
    proc.stdin.unref?.();
  }

  call(op, args) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`weft-render did not answer ${op} within ${CALL_TIMEOUT / 1000}s`));
        this.stop();
      }, CALL_TIMEOUT);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  // One call at a time; the sidecar exits after IDLE_MS without calls.
  run(job) {
    const next = this.queue.then(async () => {
      clearTimeout(this.idleTimer);
      try {
        this.start();
        return await job();
      } finally {
        this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
        this.idleTimer.unref();
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  // The same /render/:id page headless Chrome loads, so both see the same HTML and CSS (fonts are fetched by the
  // sidecar from the same server). Skipped when the sidecar already has this artboard at this size and content.
  async load(artboardId, width, height) {
    const url = `${this.baseUrl}/render/${encodeURIComponent(artboardId)}`;
    const w = Math.max(1, Math.ceil(width)), h = Math.max(1, Math.ceil(height));
    const key = this.contentKey?.() ?? null;
    const prev = this.shown;
    if (key !== null && prev && prev.key === key && prev.url === url && prev.width === w && prev.height === h) return;
    this.shown = null;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`render page: HTTP ${res.status}`);
    await this.call("load", { html: await res.text(), baseUrl: url, width: w, height: h, assetsKey: String(this.assetsKey()) });
    this.shown = { key, url, width: w, height: h };
  }

  screenshot({ artboardId, nodeId, width, height, scale = 1, maxSize = 1600 }) {
    return this.run(async () => {
      await this.load(artboardId, width, height);
      const r = await this.call("screenshot", { nodeId, scale, maxSize });
      return { png: Buffer.from(r.png, "base64"), width: r.width, height: r.height, scale: r.scale };
    });
  }

  computed({ artboardId, nodeIds, width, height, properties }) {
    return this.run(async () => {
      await this.load(artboardId, width, height);
      return this.call("computed", { artboardId, nodeIds, properties });
    });
  }

  stop() {
    clearTimeout(this.idleTimer);
    const proc = this.proc;
    this.proc = null;
    this.shown = null;
    try { proc?.stdin.end(); proc?.kill(); } catch {}
  }
}

/**
 * Blitz first, headless Chrome for anything it can't do: the artboard uses CSS Blitz doesn't draw (`unsupported`
 * returns why), the sidecar is missing or crashed, or it returned an error. Chrome is only started when needed.
 * `onFallback` hears about failures (the server logs each reason once).
 */
export class PreferBlitz {
  constructor(blitz, chrome, { unsupported = () => null, onFallback = () => {} } = {}) {
    this.blitz = blitz;
    this.chrome = chrome;
    this.unsupported = unsupported;
    this.onFallback = onFallback;
  }

  get available() {
    return this.blitz.available || this.chrome.available;
  }

  async attempt(method, args) {
    if (this.blitz.available && !this.unsupported(args)) {
      try {
        return await this.blitz[method](args);
      } catch (err) {
        this.onFallback(method, err);
      }
    }
    return this.chrome[method](args);
  }

  screenshot(args) { return this.attempt("screenshot", args); }
  computed(args) { return this.attempt("computed", args); }

  stop() {
    this.blitz.stop();
    this.chrome.stop();
  }
}
