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

async function startTestServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-ui-srv-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PAPER_ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: baseUrl, DATA_DIR: dataDir, CHROME_PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d.toString(); });
  child.stderr.on("data", (d) => { logs += d.toString(); });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}):\n${logs}`);
    try { if ((await fetch(`${baseUrl}/api/projects`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 60));
  }
  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => {
          const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} r(); }, 1500);
          child.once("exit", () => { clearTimeout(t); r(); });
        });
      }
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function startBrowser(bin) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-ui-prof-"));
  const cdpPort = await freePort();
  const isHeadlessShell = path.basename(bin).includes("headless");
  const proc = spawn(bin, [
    ...(isHeadlessShell ? [] : ["--headless=new"]),
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1440,900",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let errLogs = "";
  proc.stderr.on("data", (d) => { errLogs += d.toString(); });

  const kill = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      await new Promise((r) => {
        const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} r(); }, 1500);
        proc.once("exit", () => { clearTimeout(t); r(); });
      });
    }
    proc.stderr?.destroy(); // helper processes can inherit this pipe and keep the test process alive
    for (let i = 0; i < 6; i++) {
      try { await fs.rm(profileDir, { recursive: true, force: true }); break; } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  };

  // A cold Chrome on a busy CI runner can take well over 15s to open its DevTools port. If it never does, kill it:
  // a leaked browser keeps this test file's process alive and the whole `node --test` run hangs until CI gives up.
  let ws;
  try {
    let wsUrl = null;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`Chrome exited (${proc.exitCode}):\n${errLogs}`);
      try {
        const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        const page = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
        if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(wsUrl, `Timed out waiting for Chrome DevTools target:\n${errLogs}`);
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
  } catch (err) {
    try { ws?.close(); } catch {}
    await kill();
    throw err;
  }

  let seq = 0;
  const pending = new Map();
  const runtimeErrors = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      runtimeErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || "Runtime exception");
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (!/fonts\.googleapis|fonts\.gstatic|interactjs/i.test(txt)) runtimeErrors.push(txt);
    }
  });

  // A dead browser must fail the test, not hang it: reject in-flight calls when the socket closes or a call stalls.
  ws.addEventListener("close", () => { for (const { reject } of pending.values()) reject(new Error("Chrome connection closed")); pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error(`${method}: Chrome connection closed`)); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no answer from Chrome in 30s`)); }, 30_000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evalJs = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Eval failed");
    }
    return res.result?.value;
  };

  const stop = async () => {
    // Chrome often drops the socket before answering Browser.close, so never wait on the reply for long.
    await Promise.race([send("Browser.close").catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    try { ws.close(); } catch {}
    await kill();
  };

  return { send, evalJs, runtimeErrors, stop };
}

async function mcpCall(baseUrl, name, args = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const dataLine = raw.split(/\r?\n/).find((l) => l.startsWith("data: "));
  const body = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(raw);
  if (body.error) throw new Error(body.error.message);
  return JSON.parse(body.result.content[0].text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("browser E2E: Light Precision UI, Command Palette (250+ layers), HUD, Context Bar, Dashboard & Viewports", { timeout: 180_000 }, async (t) => {
  const browserBin = findBrowser();
  if (!browserBin) {
    t.skip("No headless Chromium/Chrome binary found");
    return;
  }

  // Register each cleanup as soon as its resource exists, so a failed browser start still stops the server.
  const srv = await startTestServer();
  t.after(() => srv.stop());
  const cdp = await startBrowser(browserBin);
  t.after(() => cdp.stop());

  const ab = await mcpCall(srv.baseUrl, "create_artboard", {
    name: "Studio Landing",
    width: 420,
    height: 1600,
    styles: { backgroundColor: "#ffffff" },
  });
  const items = Array.from({ length: 245 }, (_, i) => `<p data-name="Row ${i}" style="font-size:12px">Row ${i}</p>`).join("");
  await mcpCall(srv.baseUrl, "write_html", {
    parentId: ab.id,
    html: `<div data-name="Main Stack" style="display:flex; flex-direction:column; gap:4px; padding:16px">
      ${items}
      <button data-name="Deep Target Label" style="background-color:rgb(0, 0, 255); color:#ffffff; padding:8px 12px">Deep Action</button>
      <img data-name="Hero Image" src="data:image/png;base64,iVBORw0KGgo=" alt="Hero">
    </div>`,
  });
  const found = await mcpCall(srv.baseUrl, "find_nodes", { query: "Deep Target Label" });
  const deepId = found[0].id;
  await mcpCall(srv.baseUrl, "update_styles", {
    updates: [{ nodeIds: [deepId], styles: { borderRadius: 6 } }],
  });

  await cdp.send("Page.navigate", { url: srv.baseUrl });
  await sleep(600);

  await cdp.evalJs(`new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("SSE live timeout")), 6000);
    const tick = () => document.querySelector("#live.live") ? (clearTimeout(t), res(true)) : setTimeout(tick, 50);
    tick();
  })`);

  // 1. Light Precision CSS tokens + SVG logo favicon
  const theme = await cdp.evalJs(`(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      panel: cs.getPropertyValue("--panel").trim(),
      accent: cs.getPropertyValue("--accent").trim(),
      stage: cs.getPropertyValue("--stage").trim(),
      hasFavicon: Boolean(document.querySelector('link[rel="icon"]')),
      hudVisible: getComputedStyle(document.getElementById("stage-hud")).display !== "none"
    };
  })()`);
  assert.equal(theme.panel, "#ffffff");
  assert.equal(theme.accent, "#0000ff");
  assert.equal(theme.stage, "#eef2f6");
  assert.equal(theme.hasFavicon, true);
  assert.equal(theme.hudVisible, true);

  // 2. Command Palette (⌘K): finds Deep Target Label beyond index 240 with breadcrumb & selects it
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "k", code: "KeyK", modifiers: 2 });
  await sleep(100);
  await cdp.evalJs(`(() => {
    const inp = document.getElementById("cmdk-input");
    inp.value = "Deep Target";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    return document.querySelectorAll("#cmdk-list .cmdk-item").length;
  })()`);
  const cmdkResult = await cdp.evalJs(`(() => {
    const item = document.querySelector("#cmdk-list .cmdk-item");
    if (!item) return null;
    const text = item.textContent;
    item.click();
    return text;
  })()`);
  assert.ok(cmdkResult && cmdkResult.includes("Deep Target Label"), `Expected Deep Target Label in CmdK, got: ${cmdkResult}`);
  assert.match(cmdkResult, /Studio Landing · button/);
  await sleep(250);

  // 3. Selection -> Context Bar, Right Inspector Header + Footer + Collapsed CSS JSON + Live MCP badge + RGB hex conversion
  const selCheck = await cdp.evalJs(`(() => {
    const ctx = document.getElementById("ctx-bar");
    const rh = document.getElementById("right-head");
    const foot = document.getElementById("inspector-foot");
    const cssJson = document.getElementById("css-json");
    const colorInput = document.querySelector('.swatch input[data-style="backgroundColor"]');
    const mcpBadge = rh.querySelector(".mcp-badge");
    return {
      ctxDisplay: getComputedStyle(ctx).display,
      ctxName: document.getElementById("ctx-name").textContent,
      ctxFlexHidden: document.getElementById("ctx-flex").hidden,
      rightPill: rh.querySelector(".type-pill")?.textContent,
      hasMcpBadge: Boolean(mcpBadge),
      footHidden: foot.hidden,
      cssJsonCollapsed: !cssJson,
      pickedHex: colorInput?.value
    };
  })()`);
  assert.equal(selCheck.ctxDisplay, "flex");
  assert.equal(selCheck.ctxName, "Deep Target Label");
  assert.equal(selCheck.ctxFlexHidden, false);
  assert.equal(selCheck.rightPill, "LAYER");
  assert.equal(selCheck.hasMcpBadge, true);
  assert.equal(selCheck.footHidden, false);
  assert.equal(selCheck.cssJsonCollapsed, true);
  assert.equal(selCheck.pickedHex, "#0000ff");

  // finish_working_on_nodes clears the MCP badge live in #right-head via SSE
  await mcpCall(srv.baseUrl, "finish_working_on_nodes", {});
  await sleep(150);
  assert.equal(await cdp.evalJs(`Boolean(document.querySelector("#right-head .mcp-badge"))`), false);

  // Expand Raw CSS JSON on click
  await cdp.evalJs(`document.querySelector('[data-action="toggle-css-json"]').click()`);
  assert.equal(await cdp.evalJs(`Boolean(document.getElementById("css-json"))`), true);

  // Select tall Studio Landing artboard and pan slightly off-top -> ctx-bar stays clamped visible
  await cdp.evalJs(`(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    const inp = document.getElementById("cmdk-input");
    inp.value = "Studio Landing Artboard";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#cmdk-list .cmdk-item")?.click();
  })()`);
  await sleep(150);
  const clampedCtx = await cdp.evalJs(`(() => {
    const st = document.getElementById("stage");
    st.dispatchEvent(new WheelEvent("wheel", { deltaY: 220, cancelable: true }));
    const ctx = document.getElementById("ctx-bar");
    const r = ctx.getBoundingClientRect();
    const sr = st.getBoundingClientRect();
    return {
      display: getComputedStyle(ctx).display,
      topRel: Math.round(r.top - sr.top),
      bottomRel: Math.round(sr.bottom - r.bottom),
    };
  })()`);
  assert.equal(clampedCtx.display, "flex");
  assert.ok(clampedCtx.topRel >= 47, `Expected ctx-bar top >= 48, got ${clampedCtx.topRel}`);

  // Selecting Hero Image via Cmd+K hides + Flex button & shows empty fill swatch
  await cdp.evalJs(`(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    const inp = document.getElementById("cmdk-input");
    inp.value = "Hero Image";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#cmdk-list .cmdk-item")?.click();
  })()`);
  await sleep(150);
  const imgCheck = await cdp.evalJs(`({
    ctxFlexHidden: document.getElementById("ctx-flex").hidden,
    emptySwatch: Boolean(document.querySelector('.swatch.empty input[data-style="backgroundColor"]'))
  })`);
  assert.equal(imgCheck.ctxFlexHidden, true);
  assert.equal(imgCheck.emptySwatch, true);

  // 4. Floating HUD: Snap toggle + Hide UI + Show UI
  await cdp.evalJs(`document.getElementById("snap-btn").click()`);
  assert.equal(await cdp.evalJs(`document.getElementById("snap-btn").classList.contains("snap-on")`), true);

  await cdp.evalJs(`document.getElementById("hud-hide-ui").click()`);
  await sleep(60);
  assert.deepEqual(await cdp.evalJs(`({
    hidden: document.getElementById("app").classList.contains("ui-hidden"),
    hudDisplay: getComputedStyle(document.getElementById("stage-hud")).display,
    ctxDisplay: getComputedStyle(document.getElementById("ctx-bar")).display,
    showUiDisplay: getComputedStyle(document.getElementById("show-ui")).display
  })`), { hidden: true, hudDisplay: "none", ctxDisplay: "none", showUiDisplay: "flex" });

  await cdp.evalJs(`document.getElementById("show-ui").click()`);
  await sleep(60);
  assert.equal(await cdp.evalJs(`document.getElementById("app").classList.contains("ui-hidden")`), false);

  // 5. Layer filter Escape clears filter smoothly
  await cdp.evalJs(`(() => {
    const lf = document.getElementById("layer-filter");
    lf.focus();
    lf.value = "Deep Target";
    lf.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  assert.equal(await cdp.evalJs(`document.querySelectorAll("#layers .row").length`), 1);
  await cdp.evalJs(`document.getElementById("layer-filter").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  assert.equal(await cdp.evalJs(`document.getElementById("layer-filter").value`), "");

  // 6. Responsive viewports: zero overflow + HUD inside #stage at 768, 1024, 1440px
  for (const [w, h] of [[768, 900], [1024, 768], [1440, 900]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(120);
    const box = await cdp.evalJs(`(() => {
      const s = document.getElementById("stage").getBoundingClientRect();
      const hud = document.getElementById("stage-hud").getBoundingClientRect();
      const pill = document.getElementById("stage-pill").getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        hudInside: hud.left >= s.left - 1 && hud.right <= s.right + 1,
        pillInside: pill.left >= s.left - 1 && pill.right <= s.right + 1
      };
    })()`);
    assert.equal(box.overflow, false, `Horizontal overflow at ${w}x${h}`);
    assert.equal(box.hudInside, true, `HUD clipped at ${w}x${h}`);
    assert.equal(box.pillInside, true, `Stage pill clipped at ${w}x${h}`);
  }

  // 7. Dashboard: Grid/List switch, Search + Escape clear, New project modal, Delete modal
  await cdp.evalJs(`document.getElementById("dash-btn").click()`);
  await sleep(150);
  assert.equal(await cdp.evalJs(`document.getElementById("dashboard").hidden`), false);
  await cdp.evalJs(`document.querySelector('[data-dash-view="list"]').click()`);
  assert.equal(await cdp.evalJs(`Boolean(document.querySelector("#dash-content .dash-list"))`), true);
  await cdp.evalJs(`document.querySelector('[data-dash-view="grid"]').click()`);
  assert.equal(await cdp.evalJs(`Boolean(document.querySelector("#dash-content .dash-grid"))`), true);

  await cdp.evalJs(`document.getElementById("dash-new").click()`);
  await cdp.evalJs(`(() => {
    const inp = document.getElementById("dash-modal-input");
    inp.value = "Second Light Project";
    document.getElementById("dash-modal-ok").click();
  })()`);
  await cdp.evalJs(`new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("Project create timeout: " + document.getElementById("project-name").textContent)), 6000);
    const tick = () => document.getElementById("project-name").textContent === "Second Light Project" ? (clearTimeout(t), res(true)) : setTimeout(tick, 40);
    tick();
  })`);
  assert.equal(await cdp.evalJs(`document.getElementById("project-name").textContent`), "Second Light Project");

  await cdp.evalJs(`document.getElementById("dash-btn").click()`);
  await sleep(150);
  const bgStyle = await cdp.evalJs(`(() => {
    const ds = document.getElementById("dash-search");
    ds.value = "Second";
    ds.dispatchEvent(new Event("input", { bubbles: true }));
    const cards = document.querySelectorAll(".dash-card");
    const thumbBg = cards[0]?.querySelector(".dash-thumb")?.style.background;
    ds.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { countWhileFiltered: cards.length, clearedValue: ds.value, thumbBg };
  })()`);
  assert.equal(bgStyle.countWhileFiltered, 1);
  assert.equal(bgStyle.clearedValue, "");
  assert.match(bgStyle.thumbBg, /238,\s*242,\s*246|#eef2f6/i);

  // Delete Second Light Project via Dashboard actions menu + confirmation modal
  await cdp.evalJs(`(() => {
    const activeCard = document.querySelector(".dash-card.active [data-dash-menu]");
    activeCard.click();
    document.querySelector('#dash-menu [data-dact="delete"]').click();
    document.getElementById("dash-modal-ok").click();
  })()`);
  await cdp.evalJs(`new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("Project delete timeout")), 6000);
    const tick = () => document.querySelectorAll(".dash-card").length === 1 ? (clearTimeout(t), res(true)) : setTimeout(tick, 40);
    tick();
  })`);
  assert.equal(await cdp.evalJs(`document.querySelectorAll(".dash-card").length`), 1);

  assert.deepEqual(cdp.runtimeErrors, [], `Unexpected browser console/runtime errors: ${cdp.runtimeErrors.join(" | ")}`);
});
