// Drives the canvas UI with real mouse and keyboard input (CDP Input events) and checks the server state after each action.
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

async function startServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-ui-int-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PAPER_ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: baseUrl, DATA_DIR: dataDir, CHROME_PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d; });
  child.stderr.on("data", (d) => { logs += d; });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${logs}`);
    try { if ((await fetch(`${baseUrl}/api/projects`)).ok) break; } catch {}
    await sleep(50);
  }
  return {
    baseUrl, dataDir, logs: () => logs,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => { const t = setTimeout(r, 1500); child.once("exit", () => { clearTimeout(t); r(); }); });
      }
      for (let i = 0; i < 6; i++) {
        try { await fs.rm(dataDir, { recursive: true, force: true }); break; } catch { await sleep(150); }
      }
    },
  };
}

async function startBrowser(bin, url) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-ui-int-prof-"));
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
  const downloads = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (!/fonts\.(googleapis|gstatic)/.test(txt)) errors.push(txt);
    }
    if (m.method === "Browser.downloadWillBegin") downloads.push(m.params.suggestedFilename);
  });
  // A dead browser must fail the test, not hang it: reject in-flight calls when the socket closes or a call stalls.
  ws.addEventListener("close", () => { for (const fail of pending.values()) fail({ error: { message: "Chrome connection closed" } }); pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error(`${method}: Chrome connection closed`)); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no answer from Chrome in 30s`)); }, 30_000);
    pending.set(id, (m) => { clearTimeout(timer); return m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // PL_UI_CPU_THROTTLE=4 slows the page down like a busy CI runner, to shake out timing assumptions locally.
  if (Number(process.env.PL_UI_CPU_THROTTLE) > 1) await send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.PL_UI_CPU_THROTTLE) });
  // PL_UI_SSE_DELAY=300 holds every live update for that many ms, imitating a UI that lags behind the server.
  if (Number(process.env.PL_UI_SSE_DELAY) > 0) {
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      const add = EventSource.prototype.addEventListener;
      EventSource.prototype.addEventListener = function (type, fn, opts) {
        return add.call(this, type, (ev) => setTimeout(() => fn(ev), ${Number(process.env.PL_UI_SSE_DELAY)}), opts);
      };
    })();` });
  }
  await send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: profileDir, eventsEnabled: true }).catch(() => {});
  await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: new URL(url).origin }).catch(() => {});
  await send("Page.navigate", { url });

  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const mouse = async (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  const move = (x, y, buttons = 0) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: buttons ? "left" : "none", buttons });
  const click = async (x, y, clickCount = 1) => {
    await move(x, y);
    await mouse("mousePressed", x, y, { clickCount });
    await mouse("mouseReleased", x, y, { clickCount });
  };
  const drag = async (x0, y0, x1, y1, steps = 8) => {
    await move(x0, y0);
    await mouse("mousePressed", x0, y0);
    for (let i = 1; i <= steps; i++) {
      await move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, 1);
      await sleep(16);
    }
    await mouse("mouseReleased", x1, y1);
  };
  const KEYS = {
    Enter: { code: "Enter", keyCode: 13, text: "\r" }, Escape: { code: "Escape", keyCode: 27 }, Delete: { code: "Delete", keyCode: 46 },
    Backspace: { code: "Backspace", keyCode: 8 }, Tab: { code: "Tab", keyCode: 9 }, ArrowLeft: { code: "ArrowLeft", keyCode: 37 }, ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 }, ArrowDown: { code: "ArrowDown", keyCode: 40 }, " ": { code: "Space", keyCode: 32 },
    "\\": { code: "Backslash", keyCode: 220 },
  };
  // modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift
  const key = async (k, modifiers = 0) => {
    const info = KEYS[k] || { code: /^[0-9]$/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`, keyCode: k.toUpperCase().charCodeAt(0) };
    const shifted = modifiers & 8;
    const keyValue = k.length === 1 && shifted ? ({ 1: "!", 2: "@", 0: ")" }[k] ?? k.toUpperCase()) : k;
    const text = modifiers & 6 ? undefined : info.text ?? (k.length === 1 ? keyValue : undefined);
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: keyValue, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers, text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyValue, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers });
  };
  const type = async (text) => send("Input.insertText", { text });
  const close = async () => {
    // Chrome often drops the socket before answering Browser.close, so never wait on the reply for long.
    await Promise.race([send("Browser.close").catch(() => {}), sleep(2000)]);
    try { ws.close(); } catch {}
    await kill();
  };
  return { send, evalJs, mouse, move, click, drag, key, type, errors, downloads, close };
}

async function mcp(baseUrl, name, args = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : raw);
  const text = body.result?.content?.find((c) => c.type === "text")?.text;
  if (body.error || body.result?.isError) throw new Error(text || body.error.message);
  try { return JSON.parse(text); } catch { return text; }
}

test("UI interactions: drawing, editing, shortcuts, panels, projects and live sync", { skip: !findBrowser() && "no Chrome/Chromium available", timeout: 300_000 }, async (t) => {
  // Register each cleanup as soon as its resource exists, so a failed browser start still stops the server.
  const srv = await startServer();
  t.after(() => srv.stop());
  const B = srv.baseUrl;
  const ui = await startBrowser(findBrowser(), `${B}/`);
  t.after(() => ui.close());

  const state = async () => (await fetch(`${B}/api/state`)).json();
  const nodes = async () => Object.values((await state()).nodes);
  const nodeBy = async (pred) => (await nodes()).find(pred);
  const rect = (selector) => ui.evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
  const nodeRect = (id) => rect(`#world [data-node-id="${id}"]`);
  const uiSel = () => ui.evalJs("sel");
  // The server applies a change before the browser hears about it over SSE. Keyboard shortcuts and panels act on the
  // UI's copy of the state, so after every wait we also let the UI catch up to the server's project + version.
  // (On a busy CI runner that gap is long enough for e.g. a second Shift+A to see stale styles.)
  const ms = Number(process.env.PL_UI_WAIT_MS) || 8000;
  const synced = async () => {
    const end = Date.now() + ms;
    let ui0, srv0;
    while (Date.now() < end) {
      srv0 = await state();
      ui0 = await ui.evalJs("S ? { id: S.id, version: S.version } : null");
      if (ui0 && ui0.id === srv0.id && ui0.version === srv0.version) return;
      await sleep(40);
    }
    assert.fail(`UI never caught up with the server (ui ${JSON.stringify(ui0)} vs server ${JSON.stringify({ id: srv0?.id, version: srv0?.version })})`);
  };
  const waitFor = async (fn, label, timeout = ms) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await fn();
      if (last) { await synced(); return last; }
      await sleep(80);
    }
    const ctx = await ui.evalJs(`JSON.stringify({ busy, editingId, pendingRender, sel, tool, toast: document.getElementById("toast").textContent })`).catch(() => "?");
    assert.fail(`Timed out waiting for: ${label} (last: ${JSON.stringify(last)}; ui: ${ctx})`);
  };
  const settle = () => sleep(250);
  // Select from script, then wait for any in-flight UI requests so the selection sticks.
  const pick = async (id) => { await settle(); await ui.evalJs(`select(${JSON.stringify(id)})`); await waitFor(async () => (await uiSel()) === id, `select ${id}`); };

  await waitFor(() => ui.evalJs(`Boolean(document.getElementById("live-text")?.textContent.includes("Live"))`), "live sync");
  await waitFor(() => ui.evalJs("Boolean(window.interact)"), "editor started (interact.js set up)");

  // ---------------------------------------------------------------- drawing tools
  let board, rectId, textId;
  await t.test("F + drag on empty canvas draws an artboard", async () => {
    await ui.key("f");
    assert.equal(await ui.evalJs("tool"), "frame");
    await ui.drag(500, 200, 900, 560);
    const ab = await waitFor(() => nodeBy((n) => n.name.startsWith("Frame")), "artboard created");
    board = ab.id;
    assert.equal(ab.styles.width, "400px");
    assert.equal(ab.styles.height, "360px");
    assert.equal(ab.styles.position, "absolute");
    await waitFor(async () => (await ui.evalJs("tool")) === "select", "tool returns to Select");
    await waitFor(async () => (await uiSel()) === board, "new artboard is selected");
  });

  await t.test("R + drag inside an artboard draws a child rectangle", async () => {
    await ui.key("r");
    const b = await nodeRect(board);
    await ui.drag(b.x + 40, b.y + 40, b.x + 140, b.y + 120);
    const r = await waitFor(() => nodeBy((n) => n.name === "Rectangle"), "rectangle created");
    rectId = r.id;
    assert.equal(r.parentId, board);
    assert.equal(r.styles.left, "40px");
    assert.equal(r.styles.top, "40px");
    assert.equal(r.styles.width, "100px");
    assert.equal(r.styles.height, "80px");
  });

  await t.test("a live re-render mid-draw still places the layer where it was drawn", async () => {
    await ui.key("r");
    const b = await nodeRect(board);
    await ui.move(b.x + 200, b.y + 160);
    await ui.mouse("mousePressed", b.x + 200, b.y + 160);
    await ui.evalJs("render(), true"); // what an SSE update (e.g. an agent's edit) does between pointerdown and pointerup
    await ui.move(b.x + 260, b.y + 220, 1);
    await ui.mouse("mouseReleased", b.x + 260, b.y + 220);
    const r = await waitFor(() => nodeBy((n) => n.name === "Rectangle" && n.id !== rectId), "second rectangle created");
    assert.equal(r.parentId, board);
    assert.equal(r.styles.left, "200px", "measured against the artboard's live element, not a detached one");
    assert.equal(r.styles.top, "160px");
    await mcp(B, "delete_nodes", { nodeIds: [r.id] });
    await waitFor(async () => !(await nodeBy((n) => n.id === r.id)), "cleanup");
  });

  await t.test("a tool change mid-draw or a late server reply doesn't change what gets drawn", async () => {
    const b = await nodeRect(board);
    const at = (left, top) => nodeBy((n) => n.parentId === board && n.styles.left === left && n.styles.top === top);
    // The tool is fixed when the gesture starts.
    await ui.key("r");
    await ui.move(b.x + 200, b.y + 240);
    await ui.mouse("mousePressed", b.x + 200, b.y + 240);
    await ui.evalJs(`setTool("select"), true`);
    await ui.move(b.x + 240, b.y + 280, 1);
    await ui.mouse("mouseReleased", b.x + 240, b.y + 280);
    const first = await waitFor(() => at("200px", "240px"), "shape drawn");
    assert.equal(first.name, "Rectangle");
    assert.equal(first.styles.backgroundColor, "#dde3e9");

    // A slow create reply must not knock the user out of a tool they picked while it was in flight.
    await ui.evalJs(`(() => { const f = window.fetch; window.__restoreFetch = () => { window.fetch = f; };
      window.fetch = (u, o) => o?.method === "POST" && String(u).endsWith("/api/nodes") ? new Promise((r) => setTimeout(r, 700)).then(() => f(u, o)) : f(u, o);
      return true; })()`);
    try {
      await ui.key("r");
      await ui.drag(b.x + 296, b.y + 40, b.x + 336, b.y + 80);
      await ui.key("f"); // pick another tool before the reply lands
      const second = await waitFor(() => at("296px", "40px"), "slow shape created");
      await sleep(150);
      assert.equal(await ui.evalJs("tool"), "frame", "the late reply left the user's new tool alone");
      await ui.evalJs(`setTool("select"), true`);
      await mcp(B, "delete_nodes", { nodeIds: [first.id, second.id] });
    } finally {
      await ui.evalJs("window.__restoreFetch(), true");
    }
    // Without interference the tool still returns to Select after drawing.
    await ui.key("r");
    await ui.drag(b.x + 296, b.y + 120, b.x + 336, b.y + 160);
    const third = await waitFor(() => at("296px", "120px"), "normal shape created");
    await waitFor(async () => (await ui.evalJs("tool")) === "select", "tool returns to Select");
    await mcp(B, "delete_nodes", { nodeIds: [third.id] });
    await waitFor(async () => !(await nodeBy((n) => n.id === third.id)), "cleanup");
  });

  await t.test("T + click creates a text layer in edit mode; Enter commits typed text", async () => {
    await ui.key("t");
    const b = await nodeRect(board);
    await ui.click(b.x + 40, b.y + 220);
    textId = (await waitFor(() => nodeBy((n) => n.tag === "p" && n.parentId === board), "text created")).id;
    await waitFor(() => ui.evalJs("editingId"), "edit mode");
    await ui.type("Hello canvas");
    await ui.key("Enter");
    await waitFor(async () => (await nodeBy((n) => n.id === textId))?.text === "Hello canvas", "text saved");
    assert.equal(await ui.evalJs("editingId"), null);
  });

  await t.test("double-click a text layer edits it; Escape cancels", async () => {
    const r = await nodeRect(textId);
    await ui.click(r.cx, r.cy);
    await ui.click(r.cx, r.cy, 2);
    await waitFor(() => ui.evalJs("editingId"), "edit mode via dblclick");
    await ui.type("Discard me");
    await ui.key("Escape");
    await settle();
    assert.equal((await nodeBy((n) => n.id === textId)).text, "Hello canvas", "Escape keeps the original text");
  });

  // ---------------------------------------------------------------- select / move / resize
  await t.test("click selects; drag moves; corner drag resizes", async () => {
    let r = await nodeRect(rectId);
    await ui.click(r.cx, r.cy);
    await waitFor(async () => (await uiSel()) === rectId, "rectangle selected");
    await ui.drag(r.cx, r.cy, r.cx + 30, r.cy + 20);
    await waitFor(async () => (await nodeBy((n) => n.id === rectId)).styles.left === "70px", "moved");
    assert.equal((await nodeBy((n) => n.id === rectId)).styles.top, "60px");

    // Resizing from the bottom-right corner grows the box by the pointer movement.
    r = await nodeRect(rectId);
    await ui.drag(r.x + r.w - 2, r.y + r.h - 2, r.x + r.w + 48, r.y + r.h + 18);
    await waitFor(async () => (await nodeBy((n) => n.id === rectId)).styles.width === "150px", "resized width");
    assert.equal((await nodeBy((n) => n.id === rectId)).styles.height, "100px");
  });

  await t.test("arrow keys nudge (Shift = 10px); snap rounds moves to 8px", async () => {
    await ui.key("ArrowRight");
    await waitFor(async () => (await nodeBy((n) => n.id === rectId)).styles.left === "71px", "nudge 1px");
    await ui.key("ArrowDown", 8);
    await waitFor(async () => (await nodeBy((n) => n.id === rectId)).styles.top === "70px", "nudge 10px");
    await ui.key("g", 8);
    assert.equal(await ui.evalJs(`document.getElementById("snap").checked`), true);
    // Snap shows the 8px grid on the canvas and inside each artboard, layered beneath the artboard's layers.
    assert.equal(await ui.evalJs(`getComputedStyle(document.getElementById("grid")).display`), "block");
    const abGrid = await ui.evalJs(`(() => { const el = document.querySelector('#world > [data-node-id="${board}"]'), b = getComputedStyle(el, "::before");
      return { content: b.content, zIndex: b.zIndex, isolation: getComputedStyle(el).isolation, image: b.backgroundImage.includes("linear-gradient") }; })()`);
    assert.deepEqual(abGrid, { content: '""', zIndex: "-1", isolation: "isolate", image: true }, "artboard grid sits under the layers");
    const r = await nodeRect(rectId);
    await ui.drag(r.cx, r.cy, r.cx + 13, r.cy + 5);
    await waitFor(async () => { const s = (await nodeBy((n) => n.id === rectId)).styles; return parseFloat(s.left) % 8 === 0 && parseFloat(s.top) % 8 === 0 && s.left !== "71px"; }, "snapped to 8px");
    await ui.key("g", 8);
    assert.equal(await ui.evalJs(`document.getElementById("snap").checked`), false);
    assert.equal(await ui.evalJs(`getComputedStyle(document.getElementById("grid")).display`), "none", "grid hides with Snap off");
  });

  await t.test("Ctrl+D duplicates, Delete removes, Ctrl+Z / Ctrl+Shift+Z undo and redo", async () => {
    const count = async () => (await nodes()).length;
    const before = await count();
    await ui.key("d", 2);
    await waitFor(async () => (await count()) === before + 1, "duplicated");
    await waitFor(async () => (await uiSel()) !== rectId, "duplicate becomes the selection");
    await ui.key("Delete");
    await waitFor(async () => (await count()) === before, "deleted");
    await ui.key("z", 2);
    await waitFor(async () => (await count()) === before + 1, "undo restores");
    await ui.key("z", 10);
    await waitFor(async () => (await count()) === before, "redo deletes again");
  });

  await t.test("Escape selects the parent, Enter the first child, Shift+A toggles flex fully", async () => {
    await pick(rectId);
    await ui.key("Escape");
    assert.equal(await uiSel(), board);
    await ui.key("Enter");
    assert.equal(await uiSel(), (await nodeBy((n) => n.id === board)).children[0]);
    await ui.evalJs(`select(${JSON.stringify(rectId)})`);
    await ui.key("a", 8);
    await waitFor(async () => (await nodeBy((n) => n.id === rectId)).styles.display === "flex", "flex on");
    await ui.key("a", 8);
    await waitFor(async () => !(await nodeBy((n) => n.id === rectId)).styles.display, "flex off");
    const st = (await nodeBy((n) => n.id === rectId)).styles;
    assert.equal(st.flexDirection, undefined, "removing flex also clears flexDirection");
    assert.equal(st.gap, undefined, "removing flex also clears gap");
  });

  // ---------------------------------------------------------------- inspector
  await t.test("inspector fields edit name, size, fill, opacity, tag, flex and raw CSS", async () => {
    await ui.evalJs(`select(${JSON.stringify(rectId)})`);
    const setField = (selector, value) => ui.evalJs(`(() => { const el = document.querySelector('#inspector ${selector}'); el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("change", { bubbles: true })); el.blur(); return true; })()`);
    const styles = async () => (await nodeBy((n) => n.id === rectId)).styles;

    await setField('[data-field="name"]', "Card");
    await waitFor(async () => (await nodeBy((n) => n.id === rectId)).name === "Card", "renamed");
    await setField('input[data-style="width"]', "222");
    await waitFor(async () => (await styles()).width === "222px", "width");
    await setField('input[data-style="backgroundColor"]:not([type=color])', "#0000ff");
    await waitFor(async () => (await styles()).backgroundColor === "#0000ff", "fill");
    await setField('input[data-style="opacity"]', "50");
    await waitFor(async () => (await styles()).opacity === "0.5", "opacity");
    await setField('input[data-style="borderRadius"]', "12");
    await waitFor(async () => (await styles()).borderRadius === "12px", "radius");

    // ArrowUp steps a numeric field
    const h0 = parseFloat((await styles()).height);
    await ui.evalJs(`document.querySelector('#inspector input[data-style="height"]').focus()`);
    await ui.key("ArrowUp", 8);
    await waitFor(async () => (await styles()).height === `${h0 + 10}px`, "Shift+ArrowUp adds 10");
    await ui.evalJs("document.activeElement.blur()");

    await ui.evalJs(`document.querySelector('#inspector [data-action="flex"]').click()`);
    await waitFor(async () => (await styles()).display === "flex", "flex via inspector");
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('#inspector [data-action="dir"][data-dir="row"]'))`), "flex controls");
    await ui.evalJs(`document.querySelector('#inspector [data-action="dir"][data-dir="row"]').click()`);
    await waitFor(async () => (await styles()).flexDirection === "row", "direction row");
    await ui.evalJs(`document.querySelector('#inspector [data-action="align"][data-j="center"][data-a="center"]').click()`);
    await waitFor(async () => (await styles()).justifyContent === "center" && (await styles()).alignItems === "center", "align center");
    await ui.evalJs(`document.querySelector('#inspector [data-action="unflex"]').click()`);
    await waitFor(async () => !(await styles()).display && !(await styles()).justifyContent, "unflex clears flex props");

    await ui.evalJs(`document.querySelector('#inspector [data-action="toggle-css-json"]').click()`);
    await ui.evalJs(`(() => { const ta = document.getElementById("css-json"); const v = JSON.parse(ta.value); v.boxShadow = "0 1px 2px #000"; delete v.opacity; ta.value = JSON.stringify(v); document.querySelector('[data-action="apply-css"]').click(); })()`);
    await waitFor(async () => (await styles()).boxShadow === "0 1px 2px #000" && !(await styles()).opacity, "raw CSS applied");
    await ui.evalJs(`document.querySelector('#inspector [data-action="toggle-css-json"]').click()`);

    await setField('select[data-field="tag"]', "section");
    await waitFor(async () => (await nodeBy((n) => n.id === rectId)).tag === "section", "tag changed");
    assert.equal(await ui.evalJs(`document.querySelector('#world [data-node-id="${rectId}"]').tagName`), "SECTION");
  });

  await t.test("root CSS: the page editor defines variables, classes, states, breakpoints and nesting for the canvas", async () => {
    const post = async (body) => (await fetch(`${B}/api/nodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const tile = await post({ parentId: board, name: "Tile", tag: "div", styles: { width: 120, height: 60, borderRadius: 6 } });
    const tileText = await post({ parentId: tile.id, name: "Tile label", tag: "span", text: "Tile" });
    const node = async () => (await state()).nodes[tile.id];
    const root = async () => (await state()).rootCss;
    const rule = async (selector, media) => (await root()).rules.find((r) => r.selector === selector && (r.media || "") === (media || ""));
    const cs = (id, prop) => ui.evalJs(`getComputedStyle(document.querySelector('#world [data-node-id="${id}"]')).${prop}`);
    const applyRoot = (css) => ui.evalJs(`(() => { const ta = document.getElementById("root-css"); ta.value = ${JSON.stringify(css)}; document.querySelector('[data-action="apply-root-css"]').click(); return true; })()`);
    const css1 = `:root {
  --brand: #0000ff;
  --pad: 10px;
}

.tile {
  background-color: var(--brand);
  padding: var(--pad);
  &:hover {
    background-color: #000000;
  }
  & .tile-label {
    color: #ff0000;
  }
  @media (max-width: 395px) {
    padding: 2px;
  }
}

.tile-label {
  font-size: 13px;
}`;

    await ui.evalJs("select(null)");
    await waitFor(() => ui.evalJs(`Boolean(document.getElementById("root-css"))`), "root CSS editor on the page panel");
    await applyRoot(css1);
    await waitFor(async () => (await root()).vars["--brand"] === "#0000ff" && (await rule(".tile:hover"))?.styles.backgroundColor === "#000000", "root CSS saved");
    await waitFor(() => ui.evalJs(`document.querySelector("#root-css-sec .sec-h").textContent.includes("2 variables · 2 classes · 5 rules")`), "counts shown");
    assert.equal(await ui.evalJs(`document.getElementById("root-css").value`), css1, "the editor shows the nested text exactly as written");
    assert.equal(await ui.evalJs(`document.querySelector("#root-css-sec .var-row .sw").style.background`), "rgb(0, 0, 255)", "colour variables get a swatch");

    // Add the shared classes to layers from their inspector.
    const addClass = async (id, name) => {
      await pick(id);
      await waitFor(() => ui.evalJs(`Boolean(document.querySelector("#inspector [data-class-add] option[value='${name}']"))`), `class picker offers .${name}`);
      await ui.evalJs(`(() => { const s = document.querySelector("#inspector [data-class-add]"); s.value = ${JSON.stringify(name)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    };
    await addClass(tile.id, "tile");
    await waitFor(async () => JSON.stringify((await node()).classes) === '["tile"]', "class added");
    await addClass(tileText.id, "tile-label");
    await waitFor(async () => JSON.stringify((await state()).nodes[tileText.id].classes) === '["tile-label"]', "nested-rule class added");
    await waitFor(async () => (await cs(tile.id, "paddingTop")) === "10px", "class styles render on the canvas");
    assert.equal(await cs(tile.id, "backgroundColor"), "rgb(0, 0, 255)", "variables resolve on the canvas");
    assert.equal(await cs(tile.id, "borderTopLeftRadius"), "6px", "the layer's own styles still apply");
    assert.equal(await cs(tileText.id, "color"), "rgb(255, 0, 0)", "nested rule applies");
    assert.equal(await cs(tileText.id, "fontSize"), "13px");
    assert.match(await ui.evalJs(`document.querySelector("#inspector .class-chip").title`), /font-size: 13px/);
    assert.equal(await ui.evalJs(`document.querySelector('#world [data-node-id="${tile.id}"]').classList.contains("wc-tile")`), true, "canvas classes are prefixed");

    // :hover is real on the canvas.
    await ui.evalJs("select(null)");
    await settle();
    const r = await nodeRect(tile.id);
    await ui.move(r.x + 4, r.y + 4);
    await waitFor(async () => (await cs(tile.id, "backgroundColor")) === "rgb(0, 0, 0)", ":hover applies on the canvas");
    await ui.move(5, 5);
    await waitFor(async () => (await cs(tile.id, "backgroundColor")) === "rgb(0, 0, 255)", "hover ends");

    // Width @media follows the artboard, not the editor window: the 390px artboard gets the mobile padding, the 400px one doesn't.
    const phone = await post({ parentId: (await state()).rootId, name: "Phone", tag: "div", styles: { left: 4000, top: 0, width: 390, height: 200 } });
    const phoneTile = await post({ parentId: phone.id, name: "Phone tile", tag: "div", classes: ["tile"] });
    await waitFor(async () => (await cs(phoneTile.id, "paddingTop")) === "2px", "breakpoint applies inside the 390px artboard");
    assert.equal(await cs(tile.id, "paddingTop"), "10px", "but not inside the wider artboard");

    // Canvas viewport preset toggle previews the 400px artboard at 390px without mutating saved styles.
    const savedBoardWidth = (await state()).nodes[board].styles.width;
    await ui.evalJs(`document.querySelector('#labels .ab-label[data-id="${board}"] .ab-vp-btn[data-vp="390"]').click()`);
    await waitFor(async () => (await cs(tile.id, "paddingTop")) === "2px", "390px viewport toggle triggers @media breakpoint");
    assert.equal((await state()).nodes[board].styles.width, savedBoardWidth, "viewport preview does not mutate saved width");
    await ui.evalJs(`document.querySelector('#labels .ab-label[data-id="${board}"] .ab-vp-btn[data-vp="390"]').click()`);
    await waitFor(async () => (await cs(tile.id, "paddingTop")) === "10px", "toggling off restores 400px layout");

    // Editing one variable restyles the layers.
    await waitFor(() => ui.evalJs(`Boolean(document.getElementById("root-css"))`), "editor");
    await applyRoot(css1.replace("--pad: 10px", "--pad: 14px").replace("#0000ff", "#00aa00"));
    await waitFor(async () => (await cs(tile.id, "paddingTop")) === "14px" && (await cs(tile.id, "backgroundColor")) === "rgb(0, 170, 0)", "variable change restyles the layer");

    // A parse error is reported and nothing changes.
    const v = (await state()).version;
    await applyRoot(".tile { #bad { color: red; } }");
    await waitFor(() => ui.evalJs(`document.getElementById("toast").textContent.includes("ids and attribute selectors")`), "error toast");
    assert.equal((await state()).version, v);

    // Make a class from a layer's own styles: the styles move into the root CSS, placement stays on the layer.
    await pick(tile.id);
    await ui.evalJs(`window.prompt = () => "tile-base"`);
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('#inspector [data-action="make-class"]:not([disabled])'))`), "make class enabled");
    await ui.evalJs(`document.querySelector('#inspector [data-action="make-class"]').click()`);
    await waitFor(async () => JSON.stringify((await node()).classes) === '["tile","tile-base"]', "new class applied");
    assert.deepEqual((await rule(".tile-base")).styles, { width: "120px", height: "60px", borderRadius: "6px" });
    assert.deepEqual(Object.keys((await node()).styles), [], "the layer no longer repeats those styles");
    await waitFor(async () => (await cs(tile.id, "width")) === "120px" && (await cs(tile.id, "borderTopLeftRadius")) === "6px", "looks the same after moving styles to the class");

    // Remove a class from the layer with its chip.
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('#inspector [data-action="remove-class"][data-class="tile"]'))`), "chip");
    await ui.evalJs(`document.querySelector('#inspector [data-action="remove-class"][data-class="tile"]').click()`);
    await waitFor(async () => JSON.stringify((await node()).classes) === '["tile-base"]', "class removed from layer");

    // Deleting a class that layers use asks first, then takes it off them.
    await ui.evalJs("select(null)");
    await waitFor(() => ui.evalJs(`Boolean(document.getElementById("root-css"))`), "editor");
    await ui.evalJs(`window.__asked = ""; window.confirm = (m) => { window.__asked = m; return false; }`);
    await applyRoot(":root { --brand: #00aa00; } .tile { color: red; }");
    await waitFor(() => ui.evalJs("window.__asked"), "confirm shown");
    assert.match(await ui.evalJs("window.__asked"), /\.tile-base \(1 layer\)/);
    assert.ok(await rule(".tile-base"), "cancelling keeps the class");
    await ui.evalJs(`window.confirm = () => true`);
    await applyRoot("");
    await waitFor(async () => !Object.keys((await root()).vars).length && !(await root()).rules.length && !(await node()).classes, "root CSS cleared and classes taken off the layers");
    for (const id of [tile.id, phone.id]) await fetch(`${B}/api/nodes/${id}`, { method: "DELETE" });
    await synced();
  });

  await t.test("preview: selecting a screen offers Preview, which opens a live page in a new tab", async () => {
    await ui.evalJs(`window.__opened = []; window.open = (url, target) => { window.__opened.push([url, target]); return {}; }`);
    await pick(board);
    await waitFor(() => ui.evalJs(`getComputedStyle(document.getElementById("ctx-preview")).display !== "none" && getComputedStyle(document.getElementById("ctx-bar")).display !== "none"`), "Preview in the context bar for a screen");
    await ui.evalJs(`document.getElementById("ctx-preview").click()`);
    assert.deepEqual(await ui.evalJs("window.__opened"), [[`/preview/${board}`, "_blank"]]);
    await waitFor(() => ui.evalJs(`document.getElementById("toast").textContent.startsWith("Previewing")`), "toast");

    // Inside a screen: the context bar stays compact, but P and the inspector header still preview the screen.
    await pick(rectId);
    await waitFor(() => ui.evalJs(`getComputedStyle(document.getElementById("ctx-preview")).display === "none"`), "no context-bar Preview on a layer");
    await ui.evalJs(`document.querySelector('#right-head [data-action="preview"]').click()`);
    await ui.evalJs("document.activeElement.blur()");
    await ui.key("p");
    assert.deepEqual((await ui.evalJs("window.__opened")).slice(1), [[`/preview/${board}`, "_blank"], [`/preview/${board}`, "_blank"]]);

    // A blocked pop-up is explained.
    await ui.evalJs(`window.open = () => null`);
    await ui.key("p");
    await waitFor(() => ui.evalJs(`document.getElementById("toast").textContent.includes("blocked the preview tab")`), "pop-up blocked message");

    // The preview page itself: the screen at its width, live-reloading when the screen changes.
    await ui.evalJs(`(() => { const f = document.createElement("iframe"); f.id = "__pv"; f.style.cssText = "position:fixed;left:0;top:0;width:900px;height:700px;opacity:0;pointer-events:none"; f.src = "/preview/${board}"; document.body.append(f); })()`);
    const inner = (expr) => ui.evalJs(`(() => { try { const d = document.getElementById("__pv").contentDocument.getElementById("frame").contentDocument; return ${expr}; } catch { return null; } })()`);
    await waitFor(() => inner(`Boolean(d.querySelector('[data-layer="${rectId}"]'))`), "preview frame shows the screen");
    await waitFor(() => ui.evalJs(`document.getElementById("__pv").contentDocument.getElementById("live").textContent.includes("Live")`), "preview is live");
    const boardWidth = (await nodeBy((n) => n.id === board)).styles.width;
    assert.equal(await ui.evalJs(`document.getElementById("__pv").contentDocument.getElementById("frame").offsetWidth + "px"`), boardWidth);
    const label = await nodeBy((n) => n.parentId === board && n.tag === "p");
    await fetch(`${B}/api/nodes/${label.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Live preview text" }) });
    await waitFor(() => inner(`d.body.textContent.includes("Live preview text")`), "preview reloads after an edit");
    await ui.evalJs(`document.getElementById("__pv").contentDocument.getElementById("w-fill").click()`);
    // Fills the preview window's content area (a vertical scrollbar may take a few pixels).
    await waitFor(() => ui.evalJs(`(() => { const d = document.getElementById("__pv").contentDocument; return d.getElementById("frame").offsetWidth === d.getElementById("main").clientWidth && d.getElementById("frame").offsetWidth > 850; })()`), "Fill window stretches the frame");
    await waitFor(() => inner(`d.querySelector('[data-layer="${board}"]').offsetWidth === d.documentElement.clientWidth`), "the screen fills the frame");
    await fetch(`${B}/api/nodes/${label.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: label.text }) });
    await ui.evalJs(`document.getElementById("__pv").remove(); delete window.open; window.__opened = null`);
    await synced();
  });

  await t.test("text inspector: font size, weight, alignment and text area", async () => {
    await ui.evalJs(`select(${JSON.stringify(textId)})`);
    const st = async () => (await nodeBy((n) => n.id === textId));
    await ui.evalJs(`(() => { const el = document.querySelector('#inspector input[data-style="fontSize"]'); el.value = "28"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await waitFor(async () => (await st()).styles.fontSize === "28px", "font size");
    await ui.evalJs(`(() => { const el = document.querySelector('#inspector select[data-style="fontWeight"]'); el.value = "700"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await waitFor(async () => (await st()).styles.fontWeight === "700", "weight");
    await ui.evalJs(`document.querySelector('#inspector [data-action="textAlign"][data-v="center"]').click()`);
    await waitFor(async () => (await st()).styles.textAlign === "center", "align");
    await ui.evalJs(`(() => { const el = document.querySelector('#inspector textarea[data-field="text"]'); el.value = "Edited in inspector"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await waitFor(async () => (await st()).text === "Edited in inspector", "text area");
    await ui.evalJs(`(() => { const el = document.querySelector('#inspector input[data-style="fontFamily"]'); el.value = "Geist Mono"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await waitFor(async () => (await st()).styles.fontFamily === "'Geist Mono', ui-monospace, monospace", "font family stack");
  });

  await t.test("context bar: + Flex, Duplicate and Copy HTML", async () => {
    await ui.evalJs(`select(${JSON.stringify(rectId)})`);
    await waitFor(() => ui.evalJs(`getComputedStyle(document.getElementById("ctx-bar")).display === "flex"`), "context bar visible");
    const flexBtn = await rect("#ctx-flex");
    await ui.click(flexBtn.cx, flexBtn.cy);
    await waitFor(async () => (await nodeBy((n) => n.id === rectId)).styles.display === "flex", "ctx flex");
    const count = (await nodes()).length;
    const dupBtn = await rect('#ctx-bar [data-ctx="duplicate"]');
    await ui.click(dupBtn.cx, dupBtn.cy);
    await waitFor(async () => (await nodes()).length > count, "ctx duplicate");
    await waitFor(async () => (await uiSel()) !== rectId, "duplicate selected");
    await pick(rectId);
    const copyBtn = await rect('#ctx-bar [data-ctx="copy"]');
    await ui.click(copyBtn.cx, copyBtn.cy);
    const clip = await waitFor(() => ui.evalJs("navigator.clipboard.readText().catch(() => '')"), "clipboard");
    assert.match(clip, new RegExp(`class="layer-${rectId}"`));
  });

  // ---------------------------------------------------------------- layers panel
  await t.test("layers: click selects, twist collapses, double-click renames, filter finds", async () => {
    const row = await rect(`#layers .row[data-id="${textId}"]`);
    await ui.click(row.cx, row.cy);
    assert.equal(await uiSel(), textId);
    await ui.click(row.x + 40, row.cy, 2);
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('#layers .row input'))`), "rename input");
    await ui.evalJs(`document.querySelector('#layers .row input').select()`);
    await ui.type("Headline");
    await ui.key("Enter");
    await waitFor(async () => (await nodeBy((n) => n.id === textId)).name === "Headline", "renamed in layers");

    await ui.evalJs(`select(null)`);
    const twist = await rect(`#layers .row[data-id="${board}"] [data-twist]`);
    await ui.click(twist.cx, twist.cy);
    assert.equal(await ui.evalJs(`Boolean(document.querySelector('#layers .row[data-id="${textId}"]'))`), false, "collapsed");
    await ui.click(twist.cx, twist.cy);
    assert.equal(await ui.evalJs(`Boolean(document.querySelector('#layers .row[data-id="${textId}"]'))`), true, "expanded");

    await ui.key("f", 2);
    assert.equal(await ui.evalJs("document.activeElement.id"), "layer-filter");
    await ui.type("headl");
    assert.deepEqual(await ui.evalJs(`[...document.querySelectorAll('#layers .row')].map((r) => r.dataset.id)`), [textId]);
    await ui.key("Escape");
    assert.ok((await ui.evalJs(`document.querySelectorAll('#layers .row').length`)) > 1, "Escape clears the filter");
  });

  await t.test("layers: drag to reorder; artboards cannot be nested", async () => {
    const dnd = (fromId, toId, frac) => ui.evalJs(`(() => {
      const from = document.querySelector('#layers .row[data-id="${fromId}"]'), to = document.querySelector('#layers .row[data-id="${toId}"]');
      const r = to.getBoundingClientRect(), dt = new DataTransfer(), y = r.top + r.height * ${frac};
      from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
      to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
      from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    })()`);
    const kids0 = (await nodeBy((n) => n.id === board)).children;
    const last = kids0[kids0.length - 1];
    await dnd(last, kids0[0], 0.1);
    await waitFor(async () => (await nodeBy((n) => n.id === board)).children[0] === last, "moved to the top");

    const second = await mcp(B, "create_artboard", { name: "Second board" });
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('#layers .row[data-id="${second.id}"]'))`), "second board row");
    await dnd(second.id, board, 0.5);
    await settle();
    assert.equal((await nodeBy((n) => n.id === second.id)).parentId, (await state()).rootId, "an artboard dropped on another artboard stays top-level");
    await mcp(B, "delete_nodes", { nodeIds: [second.id] });
  });

  // ---------------------------------------------------------------- view
  await t.test("zoom: Ctrl+wheel, zoom menu, Shift+0/1/2, HUD fit; pan with Hand and Space", async () => {
    const z = () => ui.evalJs("view.z");
    await ui.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 700, y: 400, deltaX: 0, deltaY: -200, modifiers: 2 });
    await waitFor(async () => (await z()) > 1.2, "ctrl+wheel zooms in");
    await ui.key("0", 8);
    assert.equal(await z(), 1, "Shift+0 → 100%");
    const zb = await rect("#zoom-btn");
    await ui.click(zb.cx, zb.cy);
    const zin = await rect('#zoom-menu [data-zoom="in"]');
    await ui.click(zin.cx, zin.cy);
    assert.equal(await z(), 1.25);
    await ui.key("1", 8);
    const fitZ = await z();
    assert.ok(fitZ > 0 && fitZ <= 1, `Shift+1 fits (z=${fitZ})`);
    await ui.evalJs(`select(${JSON.stringify(rectId)})`);
    await ui.key("2", 8);
    assert.ok((await z()) > fitZ, "Shift+2 zooms to the selection");
    const hud = await rect("#hud-fit");
    await ui.click(hud.cx, hud.cy);
    assert.equal(await z(), fitZ);

    const v0 = await ui.evalJs("({ x: view.x, y: view.y })");
    await ui.key("h");
    await ui.drag(300, 700, 360, 740);
    const v1 = await ui.evalJs("({ x: view.x, y: view.y })");
    assert.deepEqual([Math.round(v1.x - v0.x), Math.round(v1.y - v0.y)], [60, 40], "hand tool pans");
    await ui.key("v");
    await ui.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
    await ui.drag(300, 700, 280, 690);
    await ui.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    const v2 = await ui.evalJs("({ x: view.x, y: view.y })");
    assert.deepEqual([Math.round(v2.x - v1.x), Math.round(v2.y - v1.y)], [-20, -10], "space+drag pans");
    assert.equal(await ui.evalJs("tool"), "select");
  });

  await t.test("Ctrl+\\ hides and shows the studio UI", async () => {
    await ui.key("\\", 2);
    assert.equal(await ui.evalJs(`app.classList.contains("ui-hidden")`), true);
    const show = await rect("#show-ui");
    await ui.click(show.cx, show.cy);
    assert.equal(await ui.evalJs(`app.classList.contains("ui-hidden")`), false);
  });

  // ---------------------------------------------------------------- command palette
  await t.test("command palette: Ctrl+K, search, arrow + Enter runs, Escape closes", async () => {
    await ui.evalJs("select(null)");
    await ui.key("k", 2);
    assert.equal(await ui.evalJs(`document.getElementById("cmdk").hidden`), false);
    await ui.type("headline");
    await ui.key("Enter");
    assert.equal(await ui.evalJs(`document.getElementById("cmdk").hidden`), true);
    assert.equal(await uiSel(), textId, "running a layer entry selects it");
    await ui.key("k", 2);
    await ui.type("tool rect");
    await ui.key("Enter");
    assert.equal(await ui.evalJs("tool"), "rect");
    await ui.key("v");
    await ui.key("k", 2);
    await ui.key("Escape");
    assert.equal(await ui.evalJs(`document.getElementById("cmdk").hidden`), true);
  });

  // ---------------------------------------------------------------- pages
  await t.test("pages: add, switch, rename, delete (with confirm)", async () => {
    const first = (await state()).rootId;
    await ui.evalJs(`document.getElementById("add-page").click()`);
    const page2 = await waitFor(async () => { const s = await state(); return s.pages.length === 2 && s.rootId !== first ? s.rootId : null; }, "page added + current");
    await waitFor(() => ui.evalJs(`document.querySelectorAll("#pages .page-row").length === 2`), "page rows");
    const row1 = await rect(`#pages .page-row[data-page="${first}"]`);
    await ui.click(row1.cx - 40, row1.cy);
    await waitFor(async () => (await state()).rootId === first, "switched back");
    const row2 = await rect(`#pages .page-row[data-page="${page2}"] .nm`);
    await ui.click(row2.cx, row2.cy, 2);
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector("#pages input"))`), "page rename input");
    await ui.evalJs(`document.querySelector("#pages input").select()`);
    await ui.type("Mobile");
    await ui.key("Enter");
    await waitFor(async () => (await state()).nodes[page2]?.name === "Mobile", "page renamed");
    await ui.evalJs("window.confirm = () => true");
    await ui.evalJs(`document.querySelector('[data-del-page="${page2}"]').click()`);
    await waitFor(async () => (await state()).pages.length === 1, "page deleted");
  });

  await t.test("page panel: background chips, Google font add/remove, font upload, MCP copy", async () => {
    await ui.evalJs("select(null)");
    await settle();
    await ui.evalJs(`document.querySelector('[data-action="page-bg"][data-bg="#282828"]').click()`);
    await waitFor(async () => { const s = await state(); return s.nodes[s.rootId].styles.backgroundColor === "#282828"; }, "dark page");
    await ui.evalJs(`document.querySelector('[data-action="page-bg"][data-bg="#eef2f6"]').click()`);

    await ui.evalJs(`(() => { document.getElementById("google-family").value = "Inter"; document.querySelector('[data-action="add-google"]').click(); })()`);
    const inter = await waitFor(async () => (await (await fetch(`${B}/api/fonts`)).json()).find((f) => f.family === "Inter"), "Google font added");
    await waitFor(() => ui.evalJs(`[...document.querySelectorAll("#inspector .font-row .fam")].some((e) => e.textContent === "Inter")`), "font listed");

    const ttf = Buffer.alloc(64);
    ttf.writeUInt32BE(0x00010000, 0);
    const fontPath = path.join(srv.dataDir, "Brand-Bold.ttf");
    await fs.writeFile(fontPath, ttf);
    const { root } = await ui.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await ui.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#font-file" });
    await ui.send("DOM.setFileInputFiles", { nodeId, files: [fontPath] });
    await ui.evalJs(`document.getElementById("font-file").dispatchEvent(new Event("change", { bubbles: true }))`);
    await waitFor(async () => (await (await fetch(`${B}/api/fonts`)).json()).some((f) => f.family === "Brand" && f.weight === 700), "font uploaded");

    await ui.evalJs("window.confirm = () => true");
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('[data-action="remove-font"][data-id="${inter.id}"]'))`), "remove button");
    await ui.evalJs(`document.querySelector('[data-action="remove-font"][data-id="${inter.id}"]').click()`);
    await waitFor(async () => !(await (await fetch(`${B}/api/fonts`)).json()).some((f) => f.id === inter.id), "font removed");

    await ui.evalJs(`document.querySelector('[data-action="copy-mcp"]').click()`);
    await waitFor(async () => (await ui.evalJs("navigator.clipboard.readText().catch(() => '')")) === `claude mcp add --transport http weft ${B}/mcp`, "MCP command copied");
  });

  await t.test("export: page Copy JSX and project ZIP download", async () => {
    await ui.evalJs(`document.querySelector('#inspector [data-action="copy"][data-format="jsx"]').click()`);
    await waitFor(async () => /export function/.test(await ui.evalJs("navigator.clipboard.readText().catch(() => '')")), "JSX copied");
    await ui.evalJs(`document.querySelector('#inspector [data-action="export-zip"][data-format="both"]').click()`);
    await waitFor(() => ui.evalJs(`document.getElementById("toast").textContent.startsWith("Exported")`), "zip exported toast");
    await waitFor(() => ui.downloads.some((f) => f.endsWith(".zip")), "zip download started");
  });

  // ---------------------------------------------------------------- projects
  await t.test("project menu: new, rename, duplicate, switch, delete", async () => {
    const projects = async () => (await fetch(`${B}/api/projects`)).json();
    const startId = (await state()).id;
    const openMenu = async () => { const b = await rect("#project-btn"); await ui.click(b.cx, b.cy); };

    await openMenu();
    await ui.evalJs(`document.querySelector('#project-menu [data-act="rename"]').click()`);
    await ui.evalJs(`document.getElementById("menu-input").select()`);
    await ui.type("Studio");
    await ui.key("Enter");
    await waitFor(async () => (await state()).name === "Studio", "renamed project");

    await openMenu();
    await ui.evalJs(`document.querySelector('#project-menu [data-act="duplicate"]').click()`);
    await waitFor(async () => (await projects()).some((p) => p.name === "Studio copy"), "duplicated project");

    await openMenu();
    await ui.evalJs(`document.querySelector('#project-menu [data-act="new"]').click()`);
    await ui.evalJs(`document.getElementById("menu-input").select()`);
    await ui.type("Fresh");
    await ui.key("Enter");
    await waitFor(async () => (await state()).name === "Fresh", "new project opened");
    await waitFor(() => ui.evalJs(`document.getElementById("project-name").textContent === "Fresh"`), "UI shows new project");

    await openMenu();
    await ui.evalJs(`document.querySelector('#project-menu [data-open="${startId}"]').click()`);
    await waitFor(async () => (await state()).id === startId, "switched project");
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('#world [data-node-id="${board}"]'))`), "canvas shows the reopened project");

    const fresh = (await projects()).find((p) => p.name === "Fresh");
    await ui.evalJs(`document.querySelector('#project-menu [data-open="${fresh.id}"]')?.click() ?? (document.getElementById("project-btn").click(), document.querySelector('#project-menu [data-open="${fresh.id}"]').click())`);
    await waitFor(async () => (await state()).id === fresh.id, "opened Fresh");
    await openMenu();
    await ui.evalJs(`document.querySelector('#project-menu [data-act="delete"]').click()`);
    await ui.evalJs(`document.querySelector('#project-menu [data-ok]').click()`);
    await waitFor(async () => !(await projects()).some((p) => p.id === fresh.id), "deleted project");
    await waitFor(async () => (await state()).id !== fresh.id, "another project opens after deleting the active one");
    await waitFor(() => ui.evalJs(`document.getElementById("project-name").textContent !== "Fresh"`), "UI follows to the remaining project");
  });

  await t.test("dashboard: open, search, sort, list/grid, card menu, open project, back", async () => {
    await ui.key("p", 10);
    await waitFor(() => ui.evalJs(`!document.getElementById("dashboard").hidden`), "dashboard via Ctrl+Shift+P");
    await waitFor(() => ui.evalJs(`document.querySelectorAll("#dash-content .dash-card").length >= 2`), "cards");
    await ui.evalJs(`(() => { const s = document.getElementById("dash-search"); s.value = "copy"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    assert.equal(await ui.evalJs(`document.querySelectorAll("#dash-content .dash-card").length`), 1);
    await ui.evalJs(`document.getElementById("dash-search-clear").click()`);
    await ui.evalJs(`(() => { const s = document.getElementById("dash-sort"); s.value = "name"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    const names = await ui.evalJs(`[...document.querySelectorAll("#dash-content .dash-name")].map((e) => e.textContent)`);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "sorted by name");
    await ui.evalJs(`document.querySelector('[data-dash-view="list"]').click()`);
    assert.ok(await ui.evalJs(`document.querySelectorAll("#dash-content .dash-row").length >= 2`));
    await ui.evalJs(`document.querySelector('[data-dash-view="grid"]').click()`);

    const copyCard = await ui.evalJs(`[...document.querySelectorAll("#dash-content .dash-card")].find((c) => c.textContent.includes("Studio copy")).dataset.pid`);
    await ui.evalJs(`document.querySelector('[data-dash-menu="${copyCard}"]').click()`);
    await ui.evalJs(`document.querySelector('#dash-menu [data-dact="rename"]').click()`);
    await ui.evalJs(`document.getElementById("dash-modal-input").select()`);
    await ui.type("Archive");
    await ui.key("Enter");
    await waitFor(async () => (await (await fetch(`${B}/api/projects`)).json()).some((p) => p.name === "Archive"), "renamed from dashboard");
    await waitFor(() => ui.evalJs(`[...document.querySelectorAll("#dash-content .dash-name")].some((e) => e.textContent === "Archive")`), "dashboard refreshed");

    await ui.evalJs(`document.querySelector('[data-dash-menu="${copyCard}"]').click()`);
    await ui.evalJs(`document.querySelector('#dash-menu [data-dact="delete"]').click()`);
    await ui.evalJs(`document.getElementById("dash-modal-ok").click()`);
    await waitFor(async () => !(await (await fetch(`${B}/api/projects`)).json()).some((p) => p.id === copyCard), "deleted from dashboard");

    await ui.evalJs(`document.getElementById("dash-new").click()`);
    await ui.evalJs(`document.getElementById("dash-modal-input").select()`);
    await ui.type("From dashboard");
    await ui.key("Enter");
    await waitFor(async () => (await state()).name === "From dashboard", "created + opened from dashboard");
    await waitFor(() => ui.evalJs(`document.getElementById("dashboard").hidden`), "dashboard closes after creating");

    await ui.evalJs(`document.getElementById("dash-btn").click()`);
    const studio = (await (await fetch(`${B}/api/projects`)).json()).find((p) => p.name === "Studio");
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('#dash-content [data-open-project="${studio.id}"]'))`), "studio card");
    await ui.evalJs(`document.querySelector('#dash-content .dash-meta[data-open-project="${studio.id}"]').click()`);
    await waitFor(async () => (await state()).id === studio.id, "opened from card");
    await waitFor(() => ui.evalJs(`document.getElementById("dashboard").hidden`), "dashboard closed");
  });

  // ---------------------------------------------------------------- live sync with an agent
  await t.test("agent edits over MCP appear live, with selection focus and presence badges", async () => {
    const res = await mcp(B, "write_html", { parentId: board, html: `<div data-name="Agent card" style="position:absolute; left:10px; top:300px; width:120px; height:40px; background:#a7e66b">hi</div>` });
    const id = res.created[0].id;
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('#world [data-node-id="${id}"]'))`), "agent node rendered");
    // set_selection focuses the layer in the UI, which also expands its parent in the layers tree.
    await mcp(B, "set_selection", { nodeIds: [id] });
    await waitFor(async () => (await uiSel()) === id, "agent selection focused in UI");
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('#layers .row[data-id="${id}"] .mcp-badge'))`), "MCP badge in layers");
    await mcp(B, "finish_working_on_nodes");
    await waitFor(() => ui.evalJs(`!document.querySelector('#layers .mcp-badge')`), "badges cleared");
    // set_selection zooms to the layer on the next animation frame. Measure only once the view has stopped moving,
    // or the click can land where the layer used to be and deselect it instead.
    await waitFor(() => ui.evalJs(`new Promise((r) => { const w = document.getElementById("world"), t0 = w.style.transform;
      requestAnimationFrame(() => requestAnimationFrame(() => r(w.style.transform === t0))); })`), "view settled after agent zoom");
    const rr = await nodeRect(id);
    await ui.click(rr.cx, rr.cy);
    await waitFor(async () => (await (await fetch(`${B}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_selection", arguments: {} } }),
    })).text()).includes(id), "UI selection visible to agents");
  });

  // ---------------------------------------------------------------- export menu, cmdk hl/tab, activity, cursors, comments
  await t.test("export menu: syntax preview, Ctrl C hint, layer count and ZIP slug", async () => {
    const res = await mcp(B, "write_html", { parentId: board, html: `<div data-name="Hero Card" style="position:absolute;left:16px;top:16px;width:180px;height:60px;background:#ffffff;border-radius:12px">Export me</div>` });
    const heroId = res.created[0].id;
    await pick(heroId);
    await ui.evalJs(`document.getElementById("export-btn").click()`);
    await waitFor(() => ui.evalJs(`!document.getElementById("export-menu").hidden`), "export menu open");
    const info = await ui.evalJs(`(() => {
      const m = document.getElementById("export-menu");
      return {
        hasTags: Boolean(m.querySelector(".exp-code .t")),
        hasNums: Boolean(m.querySelector(".exp-code .n")),
        hasStrs: Boolean(m.querySelector(".exp-code .s")),
        ctrlC: m.querySelector('[data-exp="copy-sel-html"] .exp-kbd')?.textContent,
        meta: m.querySelector(".exp-scope.subtle .exp-meta")?.textContent,
        dl: m.querySelector('[data-exp="download-zip"]')?.textContent?.trim(),
      };
    })()`);
    assert.ok(info.hasTags && info.hasNums && info.hasStrs, "syntax spans rendered");
    assert.equal(info.ctrlC, "Ctrl C");
    assert.match(info.meta, /layer/, "project layer count shown");
    assert.match(info.dl, /^Download [a-z0-9-]+\.zip$/, "slug filename trimmed");
    await ui.evalJs(`document.querySelector('#export-menu [data-exp-fmt="jsx"]').click()`);
    assert.equal(await ui.evalJs(`document.querySelector('#export-menu [data-exp-fmt="jsx"]').classList.contains("on")`), true);
    await ui.key("Escape");
    await waitFor(() => ui.evalJs(`document.getElementById("export-menu").hidden`), "export menu closed on Escape");
  });

  await t.test("command palette: hl() entity escaping and Tab / Shift+Tab group cycling", async () => {
    const ampersand = await mcp(B, "write_html", { parentId: board, html: `<p data-name="Terms & Conditions">Legal &amp; copy</p>` });
    const ampId = ampersand.created[0].id;
    await waitFor(() => ui.evalJs(`Boolean(S?.nodes[${JSON.stringify(ampId)}])`), "ampersand node synced");
    await pick(null);
    await ui.key("k", 2);
    await waitFor(() => ui.evalJs(`!document.getElementById("cmdk").hidden`), "cmdk open");
    const beforeGroup = await ui.evalJs(`(() => {
      const on = document.querySelector(".cmdk-item.on");
      let p = on?.previousElementSibling;
      while (p && !p.classList.contains("cmdk-group")) p = p.previousElementSibling;
      return p?.textContent || "";
    })()`);
    await ui.key("Tab");
    const afterGroup = await ui.evalJs(`(() => {
      const on = document.querySelector(".cmdk-item.on");
      let p = on?.previousElementSibling;
      while (p && !p.classList.contains("cmdk-group")) p = p.previousElementSibling;
      return p?.textContent || "";
    })()`);
    assert.notEqual(afterGroup, beforeGroup, "Tab jumps to next group");
    await ui.key("Tab", 8);
    const backGroup = await ui.evalJs(`(() => {
      const on = document.querySelector(".cmdk-item.on");
      let p = on?.previousElementSibling;
      while (p && !p.classList.contains("cmdk-group")) p = p.previousElementSibling;
      return p?.textContent || "";
    })()`);
    assert.equal(backGroup, beforeGroup, "Shift+Tab jumps back to previous group");

    await ui.evalJs(`(() => { const i = document.getElementById("cmdk-input"); i.value = "& conditions"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    const labelHtml = await ui.evalJs(`document.querySelector(".cmdk-item .cmdk-label")?.innerHTML || ""`);
    assert.ok(labelHtml.includes("<mark>&amp;</mark>"), `expected clean highlighted entity in ${labelHtml}`);
    assert.ok(!labelHtml.includes("&<mark>amp</mark>"), "entity must not be corrupted by hl()");
    await ui.key("Escape");
  });

  await t.test("dashboard activity: live/ended agent sessions and revert to checkpoint", async () => {
    await mcp(B, "set_session_title", { text: "Polish Pricing Card" });
    await mcp(B, "write_html", { parentId: board, html: `<div data-name="Session Target" style="width:80px;height:30px">V1</div>` });
    await ui.key("p", 10);
    await waitFor(() => ui.evalJs(`!document.getElementById("dashboard").hidden`), "dashboard open");
    await waitFor(() => ui.evalJs(`document.querySelectorAll("#dash-activity .dash-act-row").length >= 1`), "activity rows shown");
    const rowTitle = await ui.evalJs(`document.querySelector("#dash-activity .dash-act-info strong")?.textContent || ""`);
    assert.equal(rowTitle, "Polish Pricing Card");
    assert.equal(await ui.evalJs(`document.querySelector("#dash-activity .dash-act-pill.live")?.textContent`), "Live");
    await ui.evalJs(`document.querySelector('[data-act-filter="agent"]').click()`);
    assert.ok(await ui.evalJs(`document.querySelectorAll("#dash-activity .dash-act-row").length >= 1`), "agent filter matches active session");
    await ui.evalJs(`document.querySelector('[data-act-filter="all"]').click()`);
    await mcp(B, "finish_working_on_nodes");
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector('#dash-activity [data-act-revert]:not([disabled])'))`), "revert button enabled after agent finishes");
    await ui.evalJs(`document.querySelector('#dash-activity [data-act-revert]:not([disabled])').click()`);
    await waitFor(() => ui.evalJs(`document.getElementById("toast").textContent.includes("Reverted")`), "revert toast shown");
    await ui.evalJs(`document.getElementById("dash-back").click()`);
    await waitFor(() => ui.evalJs(`document.getElementById("dashboard").hidden`), "returned to editor");
  });

  await t.test("multi-agent cursors: .agent-cursor.look renders dynamic agent color, follow button & top chip", async () => {
    const targetRes = await mcp(B, "write_html", { parentId: board, html: `<div data-name="Cursor Target" style="position:absolute;left:24px;top:360px;width:120px;height:40px">cursor</div>` });
    const tid = targetRes.created[0].id;
    const callAsAgent = async (agentKey, name, tool, args) => {
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-weft-client": agentKey };
      await fetch(`${B}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } } }) });
      const res = await fetch(`${B}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }) });
      const raw = await res.text();
      const line = raw.split(/\r?\n/).find((l) => l.startsWith("data: "));
      const body = JSON.parse(line ? line.slice(6) : raw);
      if (body.error || body.result?.isError) throw new Error(body.error?.message || "MCP call failed");
    };
    await callAsAgent("agent-primary", "Claude", "update_styles", { updates: [{ nodeIds: [tid], styles: { opacity: 0.95 } }] });
    await callAsAgent("agent-reader", "Reviewer", "get_node_info", { nodeId: tid });
    await waitFor(() => ui.evalJs(`!document.getElementById("top-agent-chip").hidden && document.querySelectorAll("#agents .agent-cursor.look").length >= 1`), "agent chip & outline cursor visible");

    const curStyle = await ui.evalJs(`(() => {
      const look = document.querySelector("#agents .agent-cursor.look");
      const tag = look?.querySelector(".agent-cursor-tag");
      const box = document.querySelector("#agents .agent-box");
      return {
        borderColor: tag?.style.borderColor || "",
        color: tag?.style.color || "",
        hasPulse: box?.classList.contains("pulse") || false,
        followPressed: document.getElementById("follow-agent-btn")?.getAttribute("aria-pressed"),
      };
    })()`);
    assert.ok(curStyle.borderColor && curStyle.color, "look cursor has dynamic inline border and text color");
    assert.equal(curStyle.hasPulse, false, "agent-box is static without pulse flicker");
    assert.equal(curStyle.borderColor, curStyle.color, "look cursor border and text match dynamic c.color");

    await ui.evalJs(`document.getElementById("follow-agent-btn").click()`);
    assert.equal(await ui.evalJs(`document.getElementById("follow-agent-btn").classList.contains("follow-on")`), true);
    await ui.evalJs(`document.getElementById("follow-agent-btn").click()`);
    await callAsAgent("agent-primary", "Claude", "finish_working_on_nodes", {});
    await callAsAgent("agent-reader", "Reviewer", "finish_working_on_nodes", {});
  });

  await t.test("comments: create, MCP readAt/reply with linked step, draft preservation, resolve toggle and orphan restore", async () => {
    const boxRes = await mcp(B, "write_html", { parentId: board, html: `<div data-name="Comment Target" style="position:absolute;left:30px;top:420px;width:140px;height:48px">commentable</div>` });
    const cidNode = boxRes.created[0].id;
    await pick(cidNode);
    await ui.evalJs(`openNewComment(${JSON.stringify(cidNode)})`);
    await waitFor(() => ui.evalJs(`!document.getElementById("comment-thread").hidden`), "draft comment composer open");

    await ui.type("Make this card pop");
    await ui.evalJs(`document.querySelector('#comment-thread [data-ct="send"]').click()`);
    await waitFor(() => ui.evalJs(`document.querySelectorAll("#comment-pins .cmt-pin").length >= 1 && document.getElementById("comments-tab-count").textContent === "1"`), "comment pin and tab badge rendered");
    const cmtId = await ui.evalJs(`activeThreadId`);

    const listed = await mcp(B, "get_comments", {});
    const found = listed.find((x) => x.id === cmtId);
    assert.equal(found.status, "read");
    assert.ok(found.readAt, "readAt timestamp recorded");

    await ui.evalJs(`(() => { const ta = document.getElementById("ct-input"); ta.focus(); ta.value = "Draft reply in progress"; })()`);
    await mcp(B, "reply_to_comment", { id: cmtId, text: "Updated padding and contrast", linkStep: true });

    await waitFor(() => ui.evalJs(`document.querySelectorAll("#comment-thread .ct-msg").length === 2`), "agent reply appeared via SSE");
    const draftAfter = await ui.evalJs(`document.getElementById("ct-input")?.value`);
    assert.equal(draftAfter, "Draft reply in progress", "SSE comments update must not wipe user draft in #ct-input");
    assert.ok(await ui.evalJs(`document.getElementById("toast").textContent.includes("replied to your comment")`), "reply toast shown");
    assert.match(await ui.evalJs(`document.querySelector("#comment-thread .ct-link code")?.textContent || ""`), /· step \d+/, "linkedStep shows step number");

    await ui.evalJs(`document.querySelector('#right-tabs [data-tab="comments"]').click()`);
    await waitFor(() => ui.evalJs(`!document.getElementById("comments-panel").hidden && document.querySelectorAll("#comments-panel .cmt-row").length >= 1`), "comments panel populated");
    assert.equal(await ui.evalJs(`document.querySelector(".cmts-scope")?.textContent`), "This page");
    await ui.evalJs(`document.querySelector('#comment-thread [data-ct="resolve"]').click()`);
    await waitFor(() => ui.evalJs(`document.getElementById("comment-thread").hidden && document.querySelectorAll("#comment-pins .cmt-pin").length === 0`), "resolved pin hidden by default");
    await ui.evalJs(`document.getElementById("show-resolved-pins").click()`);
    await waitFor(() => ui.evalJs(`document.querySelectorAll("#comment-pins .cmt-pin.resolved").length === 1`), "resolved pin shown when checkbox checked");

    const orphanNodeRes = await mcp(B, "write_html", { parentId: board, html: `<div data-name="Orphan Banner" style="position:absolute;left:30px;top:490px;width:140px;height:36px">bye</div>` });
    const orphanNodeId = orphanNodeRes.created[0].id;
    await fetch(`${B}/api/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: orphanNodeId, text: "Check alignment" }) });
    await mcp(B, "delete_nodes", { nodeIds: [orphanNodeId] });
    await waitFor(() => ui.evalJs(`Boolean(document.querySelector("#comments-panel .cmt-row.orphaned .cmt-warn-pill"))`), "orphaned comment badge shown");
    assert.equal(await ui.evalJs(`document.querySelector("#comments-panel .cmt-row.orphaned strong.del")?.textContent`), "Orphan Banner");
    assert.match(await ui.evalJs(`document.querySelector("#comments-panel .cmt-row.orphaned .cmt-row-meta")?.textContent || ""`), /Removed in step \d+/);
    await ui.evalJs(`document.querySelector('#comments-panel [data-restore-orphan]').click()`);
    await waitFor(() => ui.evalJs(`!document.querySelector("#comments-panel .cmt-row.orphaned")`), "Restore recovers deleted layer & clears orphan state");
  });
  await t.test("no runtime errors in the UI and none logged by the server", () => {
    assert.deepEqual(ui.errors, []);
    assert.doesNotMatch(srv.logs(), /TypeError|ReferenceError|\[weft\] (?!MCP)/);
  });
});
