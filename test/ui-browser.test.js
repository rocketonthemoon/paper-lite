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
      agent: cs.getPropertyValue("--agent").trim(),
      title: document.title,
      favicon: document.querySelector('link[rel="icon"]')?.getAttribute("href"),
      stage: cs.getPropertyValue("--stage").trim(),
      hasFavicon: Boolean(document.querySelector('link[rel="icon"]')),
      hudVisible: getComputedStyle(document.getElementById("stage-hud")).display !== "none"
    };
  })()`);
  assert.equal(theme.panel, "#ffffff");
  assert.equal(theme.accent, "#4c7dff", "selection blue is the focus accent");
  assert.equal(theme.agent, "#d97757", "agent orange");
  assert.match(theme.title, /weft$/);
  assert.equal(theme.favicon, "/favicon.svg");
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
      rightKind: rh.querySelector(".right-id")?.dataset.kind,
      hasMcpBadge: Boolean(mcpBadge),
      footHidden: foot.hidden,
      cssJsonCollapsed: !cssJson,
      pickedHex: colorInput?.value
    };
  })()`);
  assert.equal(selCheck.ctxDisplay, "flex");
  assert.equal(selCheck.ctxName, "Deep Target Label");
  assert.equal(selCheck.ctxFlexHidden, false);
  assert.equal(selCheck.rightKind, "layer");
  assert.equal(selCheck.hasMcpBadge, true);
  assert.equal(selCheck.footHidden, true, "copy actions moved to the context bar and Export menu");
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
    hudToggle: document.getElementById("hud-hide-ui").textContent,
    showUiDisplay: getComputedStyle(document.getElementById("show-ui")).display
  })`), { hidden: true, hudDisplay: "flex", hudToggle: "Show UI", showUiDisplay: "flex" });

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
      const bar = document.getElementById("topbar").getBoundingClientRect();
      const tools = document.getElementById("rail").getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        hudInside: hud.left >= s.left - 1 && hud.right <= s.right + 1,
        toolsInside: tools.left >= bar.left - 1 && tools.right <= bar.right + 1
      };
    })()`);
    assert.equal(box.overflow, false, `Horizontal overflow at ${w}x${h}`);
    assert.equal(box.hudInside, true, `HUD clipped at ${w}x${h}`);
    assert.equal(box.toolsInside, true, `Toolbar clipped at ${w}x${h}`);
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

test("browser: edits arrive as patches and only changed canvas elements are rebuilt", { timeout: 120_000 }, async (t) => {
  const browserBin = findBrowser();
  if (!browserBin) {
    t.skip("No headless Chromium/Chrome binary found");
    return;
  }
  const srv = await startTestServer();
  t.after(() => srv.stop());
  const cdp = await startBrowser(browserBin);
  t.after(() => cdp.stop());
  const rest = async (method, url, body) => {
    const res = await fetch(srv.baseUrl + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    assert.ok(res.ok, `${method} ${url} → ${res.status}`);
    return res.json();
  };

  const ab = await mcpCall(srv.baseUrl, "create_artboard", { name: "Patch board", width: 400, height: 900 });
  await mcpCall(srv.baseUrl, "write_html", {
    parentId: ab.id,
    html: `<div data-name="List" style="display:flex;flex-direction:column;gap:4px">${Array.from({ length: 40 }, (_, i) => `<p data-name="Item ${i}">Item ${i}</p>`).join("")}</div>`,
  });
  const list = (await mcpCall(srv.baseUrl, "find_nodes", { query: "List" })).find((n) => n.name === "List").id;
  const items = (await rest("GET", "/api/state")).nodes[list].children;

  await cdp.send("Page.navigate", { url: srv.baseUrl });
  const waitFor = async (expr, label) => {
    for (let i = 0; i < 100; i++) { if (await cdp.evalJs(expr)) return; await sleep(50); }
    assert.fail(`timed out waiting for ${label}`);
  };
  await waitFor(`document.querySelectorAll('#world [data-node-id]').length >= 42 && document.querySelector("#live.live")`, "canvas + live");

  // Tag every canvas element so we can tell reused elements from rebuilt ones.
  const tag = () => cdp.evalJs(`(() => { let i = 0; for (const el of document.querySelectorAll('#world [data-node-id]')) el.__probe = ++i; return i; })()`);
  const kept = (ids) => cdp.evalJs(`${JSON.stringify(ids)}.map((id) => Boolean(document.querySelector('#world [data-node-id="' + id + '"]')?.__probe))`);
  const text = (id) => cdp.evalJs(`document.querySelector('#world [data-node-id="${id}"]')?.textContent ?? null`);
  const version = () => cdp.evalJs("S.version");

  // A style edit: only that element is rebuilt; its siblings and ancestors stay the same DOM objects.
  await tag();
  let v = await version();
  await mcpCall(srv.baseUrl, "update_styles", { updates: [{ nodeIds: [items[3]], styles: { color: "rgb(255, 0, 0)" } }] });
  await waitFor(`S.version > ${v}`, "style patch");
  await waitFor(`getComputedStyle(document.querySelector('#world [data-node-id="${items[3]}"]')).color === "rgb(255, 0, 0)"`, "new color");
  assert.deepEqual(await kept([ab.id, list, items[0], items[4], items[39]]), [true, true, true, true, true]);
  assert.deepEqual(await kept([items[3]]), [false], "the edited element was rebuilt");

  // Text edit, delete and reorder.
  await tag();
  v = await version();
  await mcpCall(srv.baseUrl, "set_text_content", { updates: [{ nodeId: items[5], text: "Changed" }] });
  await mcpCall(srv.baseUrl, "delete_nodes", { nodeIds: [items[6]] });
  await rest("PATCH", `/api/nodes/${items[39]}`, { parentId: list, index: 0 });
  await waitFor(`S.version >= ${v + 3}`, "three patches");
  assert.equal(await text(items[5]), "Changed");
  assert.equal(await text(items[6]), null, "deleted element is gone");
  assert.equal(await cdp.evalJs(`document.querySelector('#world [data-node-id="${list}"]').firstElementChild.dataset.nodeId`), items[39]);
  assert.deepEqual(await kept([items[0], items[10], items[39]]), [true, true, true], "moved and untouched elements are reused");

  // Undo and redo patch too.
  v = await version();
  await rest("POST", "/api/undo");
  await rest("POST", "/api/undo");
  await waitFor(`S.version >= ${v + 2}`, "undo patches");
  assert.equal(await text(items[6]), "Item 6", "undo brings the deleted element back");
  assert.equal(await cdp.evalJs(`document.querySelector('#world [data-node-id="${list}"]').firstElementChild.dataset.nodeId`), items[0]);
  await rest("POST", "/api/redo");
  await waitFor(`S.version >= ${v + 3}`, "redo patch");
  assert.equal(await text(items[6]), null);

  // A tab that missed a step reloads the whole document and ends up identical to the server.
  await cdp.evalJs("S.version -= 5");
  await mcpCall(srv.baseUrl, "rename_nodes", { updates: [{ nodeId: items[7], name: "Renamed" }] });
  const server = await rest("GET", "/api/state");
  await waitFor(`S.version === ${server.version}`, "resync");
  assert.equal(await cdp.evalJs("JSON.stringify(S.nodes)"), JSON.stringify(server.nodes));
  assert.equal(await cdp.evalJs("document.querySelectorAll('#world [data-node-id]').length"), Object.keys(server.nodes).length - server.pages.length);
});

test("browser: History panel (Svelte) shows steps, saves and restores checkpoints, filters, keeps git drafts", { timeout: 120_000 }, async (t) => {
  const browserBin = findBrowser();
  if (!browserBin) {
    t.skip("No headless Chromium/Chrome binary found");
    return;
  }
  const srv = await startTestServer();
  t.after(() => srv.stop());
  const cdp = await startBrowser(browserBin);
  t.after(() => cdp.stop());
  const rest = async (method, url, body) => {
    const res = await fetch(srv.baseUrl + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    assert.ok(res.ok, `${method} ${url} → ${res.status}`);
    return res.json();
  };
  const waitFor = async (expr, label) => {
    for (let i = 0; i < 100; i++) { if (await cdp.evalJs(expr)) return; await sleep(50); }
    assert.fail(`timed out waiting for ${label}`);
  };
  const click = (sel) => cdp.evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const type = (sel, value) => cdp.evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const key = (sel, k) => cdp.evalJs(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
  const count = (sel) => cdp.evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

  const s0 = await rest("GET", "/api/state");
  const board = await rest("POST", "/api/nodes", { parentId: s0.rootId, tag: "div", name: "Board" });
  await rest("PATCH", `/api/nodes/${board.id}`, { name: "Board 2" });
  await mcpCall(srv.baseUrl, "rename_nodes", { updates: [{ nodeId: board.id, name: "Agent board" }] });

  await cdp.send("Page.navigate", { url: srv.baseUrl });
  await waitFor(`document.querySelector("#live.live") && document.querySelector('#right-tabs [data-tab="history"]')`, "app");
  await click('#right-tabs [data-tab="history"]');
  await waitFor(`!document.querySelector("#history-panel").hidden && document.querySelectorAll("#history-panel .hist-step").length === 3`, "three steps");
  assert.equal(await cdp.evalJs(`document.querySelector("#history-panel .hist-step.cur .hist-av").textContent`), "AI", "newest (agent) step is current");
  assert.equal(await cdp.evalJs(`document.querySelector(".hist-count").textContent`), "3 / 60");

  // Jump back by clicking the oldest step; the server moves and the panel follows.
  await click('#history-panel .hist-step[data-index="0"]');
  await waitFor(`document.querySelector(".hist-count").textContent === "1 / 60"`, "jump");
  assert.equal((await rest("GET", "/api/history")).cursor, 0);
  assert.equal(await count("#history-panel .hist-step.undone"), 2);
  await rest("POST", "/api/history/jump", { index: 2 });
  await waitFor(`document.querySelector(".hist-count").textContent === "3 / 60"`, "jump forward");

  // Save a checkpoint: the name field appears focused with a default, Enter saves.
  await click('[data-hist="cp-new"]');
  await waitFor(`document.activeElement?.id === "cp-name" && /^Checkpoint /.test(document.activeElement.value)`, "name field focused");
  await type("#cp-name", "Before experiment");
  await key("#cp-name", "Enter");
  await waitFor(`[...document.querySelectorAll(".hist-cps .cp-name")].some((e) => e.textContent === "Before experiment")`, "checkpoint listed");
  const cp = (await rest("GET", "/api/checkpoints")).find((c) => c.name === "Before experiment");
  assert.ok(cp, "saved on the server");
  // Escape cancels naming without saving.
  await click('[data-hist="cp-new"]');
  await waitFor(`document.activeElement?.id === "cp-name"`, "name field again");
  await key("#cp-name", "Escape");
  await waitFor(`!document.querySelector("#cp-name")`, "naming cancelled");

  // Restore it after a change.
  await rest("PATCH", `/api/nodes/${board.id}`, { name: "Changed" });
  await click(`[data-hist="cp-restore"][data-id="${cp.id}"]`);
  for (let i = 0; i < 100 && (await rest("GET", "/api/state")).nodes[board.id].name !== "Agent board"; i++) await sleep(50);
  assert.equal((await rest("GET", "/api/state")).nodes[board.id].name, "Agent board");

  // Filter: Agent shows only MCP steps; closing the filter resets it.
  const steps = await count("#history-panel .hist-step");
  await click('[data-hist="filter-toggle"]');
  await click('[data-hist="filter"][data-f="agent"]');
  await waitFor(`[...document.querySelectorAll("#history-panel .hist-step .hist-av")].every((a) => a.textContent === "AI")`, "agent filter");
  assert.ok((await count("#history-panel .hist-step")) < steps);
  await click('[data-hist="filter-toggle"]');
  await waitFor(`document.querySelectorAll("#history-panel .hist-step").length === ${steps}`, "filter reset");

  // Git form: what you type survives live updates; Escape closes it.
  await click('[data-hist="git-edit"]');
  await waitFor(`document.activeElement?.id === "git-url"`, "git form focused");
  await type("#git-url", "https://github.com/you/design.git");
  await type("#git-token", "secret-token");
  await rest("PATCH", `/api/nodes/${board.id}`, { name: "Live update" }); // sends a history event
  await waitFor(`document.querySelector(".hist-count").textContent.startsWith("${steps + 1} ")`, "history event arrived");
  assert.equal(await cdp.evalJs(`document.querySelector("#git-url").value`), "https://github.com/you/design.git");
  assert.equal(await cdp.evalJs(`document.querySelector("#git-token").value`), "secret-token");
  await key("#git-token", "Escape");
  await waitFor(`!document.querySelector(".git-form") && document.querySelector('[data-hist="git-edit"]')`, "git form closed");

  // Undo last agent run is enabled while an agent step is in effect, and undoes back to before it.
  assert.equal(await cdp.evalJs(`document.querySelector('[data-hist="undo-agent"]').disabled`), false);
  await click('[data-hist="undo-agent"]');
  await waitFor(`document.querySelector('[data-hist="undo-agent"]').disabled`, "agent run undone");
  assert.equal((await rest("GET", "/api/history")).cursor, 1);
});

test("browser: command palette (Svelte): arrows wrap, count, empty state, Esc button, reopen resets, click runs", { timeout: 120_000 }, async (t) => {
  const browserBin = findBrowser();
  if (!browserBin) {
    t.skip("No headless Chromium/Chrome binary found");
    return;
  }
  const srv = await startTestServer();
  t.after(() => srv.stop());
  const cdp = await startBrowser(browserBin);
  t.after(() => cdp.stop());
  const rest = async (method, url, body) => {
    const res = await fetch(srv.baseUrl + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    assert.ok(res.ok, `${method} ${url} → ${res.status}`);
    return res.json();
  };
  const waitFor = async (expr, label) => {
    for (let i = 0; i < 100; i++) { if (await cdp.evalJs(expr)) return; await sleep(50); }
    assert.fail(`timed out waiting for ${label}`);
  };
  const s0 = await rest("GET", "/api/state");
  const board = await rest("POST", "/api/nodes", { parentId: s0.rootId, tag: "div", name: "Board" });
  const a = await rest("POST", "/api/nodes", { parentId: board.id, tag: "p", name: "Alpha", text: "a" });
  const b = await rest("POST", "/api/nodes", { parentId: board.id, tag: "p", name: "Beta", text: "b" });

  await cdp.send("Page.navigate", { url: srv.baseUrl });
  await waitFor(`document.querySelector("#live.live") && S?.nodes?.[${JSON.stringify(a.id)}]`, "app");

  // Palette: open, filter, arrows wrap, count, Esc button.
  await cdp.evalJs(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`);
  await waitFor(`!document.getElementById("cmdk").hidden && document.activeElement?.id === "cmdk-input"`, "palette open + focused");
  await cdp.evalJs(`(() => { const i = document.getElementById("cmdk-input"); i.value = "alpha"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const n = await cdp.evalJs(`document.querySelectorAll("#cmdk-list .cmdk-item").length`);
  assert.ok(n >= 1);
  assert.equal(await cdp.evalJs(`document.getElementById("cmdk-count").textContent`), `${n} ${n === 1 ? "result" : "results"}`);
  const keyIn = (k) => cdp.evalJs(`document.getElementById("cmdk-input").dispatchEvent(new KeyboardEvent("keydown", { key: "${k}", bubbles: true, cancelable: true }))`);
  await keyIn("ArrowUp");
  assert.equal(await cdp.evalJs(`document.querySelector(".cmdk-item.on")?.dataset.cmdkIdx`), String(n - 1), "ArrowUp from the top wraps to the last");
  await keyIn("ArrowDown");
  assert.equal(await cdp.evalJs(`document.querySelector(".cmdk-item.on")?.dataset.cmdkIdx`), "0", "ArrowDown from the last wraps to the first");
  await cdp.evalJs(`(() => { const i = document.getElementById("cmdk-input"); i.value = "zzzz nothing"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  assert.equal(await cdp.evalJs(`document.querySelector("#cmdk-list .cmdk-empty")?.textContent`), "No matching commands or layers.");
  await cdp.evalJs(`document.getElementById("cmdk-esc").click()`);
  assert.equal(await cdp.evalJs(`document.getElementById("cmdk").hidden`), true);
  // Reopening starts from an empty query; clicking a layer result selects it.
  await cdp.evalJs(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`);
  assert.equal(await cdp.evalJs(`document.getElementById("cmdk-input").value`), "");
  await cdp.evalJs(`(() => { const i = document.getElementById("cmdk-input"); i.value = "beta"; i.dispatchEvent(new Event("input", { bubbles: true })); [...document.querySelectorAll("#cmdk-list .cmdk-item")].find((x) => x.querySelector(".cmdk-label").textContent === "Beta").click(); })()`);
  await waitFor(`sel === ${JSON.stringify(b.id)} && document.getElementById("cmdk").hidden`, "clicked result selects the layer");
});

test("browser: Comments panel (Svelte): open/resolved tabs, rows open threads, live updates", { timeout: 120_000 }, async (t) => {
  const browserBin = findBrowser();
  if (!browserBin) {
    t.skip("No headless Chromium/Chrome binary found");
    return;
  }
  const srv = await startTestServer();
  t.after(() => srv.stop());
  const cdp = await startBrowser(browserBin);
  t.after(() => cdp.stop());
  const rest = async (method, url, body) => {
    const res = await fetch(srv.baseUrl + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    assert.ok(res.ok, `${method} ${url} → ${res.status}`);
    return res.json();
  };
  const waitFor = async (expr, label) => {
    for (let i = 0; i < 100; i++) { if (await cdp.evalJs(expr)) return; await sleep(50); }
    assert.fail(`timed out waiting for ${label}`);
  };
  const s0 = await rest("GET", "/api/state");
  const board = await rest("POST", "/api/nodes", { parentId: s0.rootId, tag: "div", name: "Board" });
  const a = await rest("POST", "/api/nodes", { parentId: board.id, tag: "p", name: "Alpha", text: "a" });
  const b = await rest("POST", "/api/nodes", { parentId: board.id, tag: "p", name: "Beta", text: "b" });
  const ca = await rest("POST", "/api/comments", { nodeId: a.id, text: "Fix alpha" });
  const cb = await rest("POST", "/api/comments", { nodeId: b.id, text: "Beta is fine" });
  await rest("PATCH", `/api/comments/${cb.id}`, { status: "resolved" });
  await cdp.send("Page.navigate", { url: srv.baseUrl });
  await waitFor(`document.querySelector("#live.live") && S?.nodes?.[${JSON.stringify(a.id)}]`, "app");

  // Open / resolved tabs with counts; a row opens its thread.
  await cdp.evalJs(`document.querySelector('#right-tabs [data-tab="comments"]').click()`);
  await waitFor(`document.querySelectorAll("#comments-panel .cmt-row").length === 1`, "one open comment");
  assert.equal(await cdp.evalJs(`document.querySelector('#comments-panel [data-cf="open"]').textContent`), "Open · 1");
  assert.equal(await cdp.evalJs(`document.querySelector('#comments-panel [data-cf="resolved"]').textContent`), "Resolved · 1");
  assert.equal(await cdp.evalJs(`document.querySelector("#comments-panel .cmt-row strong").textContent`), "Alpha");
  await cdp.evalJs(`document.querySelector('#comments-panel [data-cf="resolved"]').click()`);
  assert.equal(await cdp.evalJs(`document.querySelector("#comments-panel .cmt-row strong").textContent`), "Beta");
  assert.ok(await cdp.evalJs(`Boolean(document.querySelector("#comments-panel .cmt-row .cmt-pin.resolved svg"))`), "resolved pin shows a check");
  await cdp.evalJs(`document.querySelector('#comments-panel [data-cf="open"]').click()`);
  await cdp.evalJs(`document.querySelector('#comments-panel .cmt-row[data-open-cmt="${ca.id}"]').click()`);
  await waitFor(`!document.getElementById("comment-thread").hidden && document.querySelector("#comment-thread .ct-text")?.textContent === "Fix alpha"`, "thread opened");
  // A new comment from elsewhere shows up live.
  await rest("POST", "/api/comments", { nodeId: b.id, text: "Another" });
  await waitFor(`document.querySelector('#comments-panel [data-cf="open"]').textContent === "Open · 2"`, "live update");
});

test("browser: Layers panel (Svelte): rename cancel / live updates / artboard label, hover box, refused drops", { timeout: 120_000 }, async (t) => {
  const browserBin = findBrowser();
  if (!browserBin) {
    t.skip("No headless Chromium/Chrome binary found");
    return;
  }
  const srv = await startTestServer();
  t.after(() => srv.stop());
  const cdp = await startBrowser(browserBin);
  t.after(() => cdp.stop());
  const rest = async (method, url, body) => {
    const res = await fetch(srv.baseUrl + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    assert.ok(res.ok, `${method} ${url} → ${res.status}`);
    return res.json();
  };
  const waitFor = async (expr, label) => {
    for (let i = 0; i < 100; i++) { if (await cdp.evalJs(expr)) return; await sleep(50); }
    assert.fail(`timed out waiting for ${label}`);
  };
  const s0 = await rest("GET", "/api/state");
  const board = await rest("POST", "/api/nodes", { parentId: s0.rootId, tag: "div", name: "Board", styles: { width: "300px", height: "200px" } });
  const card = await rest("POST", "/api/nodes", { parentId: board.id, tag: "div", name: "Card" });
  const img = await rest("POST", "/api/nodes", { parentId: board.id, tag: "img", name: "Photo", attrs: { src: "data:image/png;base64,iVBORw0KGgo=" } });
  await cdp.send("Page.navigate", { url: srv.baseUrl });
  const row = (id) => `document.querySelector('#layers .row[data-id="${id}"]')`;
  await waitFor(`document.querySelector("#live.live") && ${row(board.id)}`, "tree");
  await cdp.evalJs(`${row(board.id)}.querySelector("[data-twist]").click()`); // new artboards start collapsed
  await waitFor(`${row(card.id)} && ${row(img.id)}`, "board expanded");
  const keyIn = (k) => cdp.evalJs(`document.querySelector("#layers .row input").dispatchEvent(new KeyboardEvent("keydown", { key: "${k}", bubbles: true }))`);

  // Double-click → rename box; a live update meanwhile keeps it and what was typed; Escape cancels.
  await cdp.evalJs(`${row(card.id)}.querySelector(".nm").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
  await waitFor(`document.activeElement === document.querySelector('#layers .row[data-id="${card.id}"] input')`, "rename input focused");
  await cdp.evalJs(`(() => { const i = document.querySelector("#layers .row input"); i.value = "Half typed"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await rest("PATCH", `/api/nodes/${board.id}`, { name: "Board (edited elsewhere)" });
  await waitFor(`${row(board.id)}.querySelector(".nm").textContent === "Board (edited elsewhere)"`, "live update arrived");
  assert.equal(await cdp.evalJs(`document.querySelector("#layers .row input")?.value`), "Half typed", "rename survives live updates");
  await keyIn("Escape");
  await waitFor(`!document.querySelector("#layers .row input")`, "rename closed");
  assert.equal(await cdp.evalJs(`${row(card.id)}.querySelector(".nm").textContent`), "Card");
  assert.equal((await rest("GET", "/api/state")).nodes[card.id].name, "Card", "Escape doesn't save");

  // Double-clicking an artboard's label on the canvas renames it in the tree.
  await cdp.evalJs(`document.querySelector('#labels .ab-label[data-id="${board.id}"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
  await waitFor(`document.activeElement === document.querySelector('#layers .row[data-id="${board.id}"] input')`, "artboard rename");
  await cdp.evalJs(`(() => { const i = document.querySelector("#layers .row input"); i.value = "Renamed board"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await keyIn("Enter");
  for (let i = 0; i < 100 && (await rest("GET", "/api/state")).nodes[board.id].name !== "Renamed board"; i++) await sleep(50);
  assert.equal((await rest("GET", "/api/state")).nodes[board.id].name, "Renamed board");

  // Hovering a row shows the canvas hover box; leaving the tree hides it.
  await cdp.evalJs(`${row(card.id)}.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))`);
  assert.equal(await cdp.evalJs("hoverId"), card.id);
  assert.equal(await cdp.evalJs(`getComputedStyle(document.getElementById("hover-box")).display`), "block");
  await cdp.evalJs(`document.getElementById("layers").dispatchEvent(new PointerEvent("pointerleave"))`);
  assert.equal(await cdp.evalJs("hoverId"), null);

  // Dropping into an <img> is refused with a toast; nothing moves.
  await cdp.evalJs(`(() => {
    const from = ${row(card.id)}, to = ${row(img.id)};
    const r = to.getBoundingClientRect(), dt = new DataTransfer(), y = r.top + r.height * 0.5;
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
  })()`);
  await sleep(300);
  assert.equal((await rest("GET", "/api/state")).nodes[card.id].parentId, board.id, "card stays in the board");
  assert.equal(await cdp.evalJs(`document.querySelectorAll("#layers .drop-before, #layers .drop-after, #layers .drop-inside").length`), 0, "drop highlight cleared");

  // An agent's edit shows up live, with its MCP badge while it works.
  await mcpCall(srv.baseUrl, "write_html", { parentId: card.id, html: `<p data-name="From agent">Hi</p>` });
  await waitFor(`!${row(card.id)}.querySelector(".tw").classList.contains("none")`, "card gains an expand arrow");
  await cdp.evalJs(`${row(card.id)}.querySelector("[data-twist]").click()`);
  await waitFor(`[...document.querySelectorAll("#layers .row .nm")].some((n) => n.textContent === "From agent")`, "agent layer in tree");
});
