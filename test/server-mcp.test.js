import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAPER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-srv-test-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: PAPER_ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_URL: baseUrl,
      DATA_DIR: dataDir,
      CHROME_PATH: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (d) => { logs += d.toString(); });
  child.stderr.on("data", (d) => { logs += d.toString(); });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}):\n${logs}`);
    try {
      const res = await fetch(`${baseUrl}/api/projects`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 60));
  }

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => {
        const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} r(); }, 1500);
        child.once("exit", () => { clearTimeout(t); r(); });
      });
    }
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };

  return { baseUrl, dataDir, stop };
}

async function mcp(baseUrl, method, params = {}, id = 1) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(res.status, 200);
  const ct = res.headers.get("content-type") || "";
  let body;
  if (ct.includes("text/event-stream")) {
    const raw = await res.text();
    const dataLine = raw.split(/\r?\n/).find((l) => l.startsWith("data: "));
    assert.ok(dataLine, `Expected SSE data line in:\n${raw}`);
    body = JSON.parse(dataLine.slice(6));
  } else {
    body = await res.json();
  }
  if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
  return body.result;
}

function mcpTextJson(res) {
  const item = res.content.find((c) => c.type === "text");
  assert.ok(item, "Expected text content in MCP response");
  return JSON.parse(item.text);
}

test("server + MCP integration & edge cases", { timeout: 120_000 }, async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.stop());

  await t.test("blocks foreign Host / Origin headers", async () => {
    const res = await fetch(`${srv.baseUrl}/api/projects`, {
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("bootstraps clean #eef2f6 workspace and blocks deleting the last project", async () => {
    const projects = await (await fetch(`${srv.baseUrl}/api/projects`)).json();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].bg, "#eef2f6");
    assert.equal(projects[0].active, true);

    const preview = await (await fetch(`${srv.baseUrl}/api/projects/${projects[0].id}/preview`)).json();
    assert.equal(preview.bg, "#eef2f6");

    const del = await fetch(`${srv.baseUrl}/api/projects/${projects[0].id}`, { method: "DELETE" });
    assert.equal(del.status, 400);
  });

  await t.test("manages pages and prevents deleting the final page", async () => {
    const state1 = await (await fetch(`${srv.baseUrl}/api/state`)).json();
    const firstPageId = state1.rootId;

    const delOnly = await fetch(`${srv.baseUrl}/api/pages/${firstPageId}`, { method: "DELETE" });
    assert.equal(delOnly.status, 400);

    const p2 = await (await fetch(`${srv.baseUrl}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mobile" }),
    })).json();
    assert.equal(p2.name, "Mobile");

    const delP2 = await fetch(`${srv.baseUrl}/api/pages/${p2.id}`, { method: "DELETE" });
    assert.equal(delP2.status, 200);

    const undo = await (await fetch(`${srv.baseUrl}/api/undo`, { method: "POST" })).json();
    assert.equal(undo.ok, true);
    const stateAfter = await (await fetch(`${srv.baseUrl}/api/state`)).json();
    assert.equal(stateAfter.pages.length, 2);

    await fetch(`${srv.baseUrl}/api/pages/${firstPageId}/open`, { method: "POST" });
  });

  await t.test("guards circular reparenting and supports duplicate offsets", async () => {
    const state = await (await fetch(`${srv.baseUrl}/api/state`)).json();
    const parent = await (await fetch(`${srv.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: state.rootId, name: "Card", tag: "div", styles: { width: 300, height: 200 } }),
    })).json();
    const child = await (await fetch(`${srv.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: parent.id, name: "Child", tag: "p", text: "Hello" }),
    })).json();

    const badMove = await fetch(`${srv.baseUrl}/api/nodes/${parent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: child.id }),
    });
    assert.equal(badMove.status, 400);

    const dup = await (await fetch(`${srv.baseUrl}/api/nodes/${parent.id}/duplicate`, { method: "POST" })).json();
    assert.equal(dup.name, "Card copy");
    assert.equal(dup.styles.left, "380px");
  });

  await t.test("MCP endpoint initializes, builds HTML, manages selection, exports HTML/JSX/ZIP", async () => {
    const badMethod = await fetch(`${srv.baseUrl}/mcp`, { method: "GET" });
    assert.equal(badMethod.status, 405);

    const init = await mcp(srv.baseUrl, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    assert.equal(init.serverInfo.name, "weft");

    const info = mcpTextJson(await mcp(srv.baseUrl, "tools/call", { name: "get_basic_info", arguments: {} }));
    assert.equal(info.page.fill, "#eef2f6");

    const ab = mcpTextJson(await mcp(srv.baseUrl, "tools/call", {
      name: "create_artboard",
      arguments: { name: "Hero Screen", width: 390, height: "fit-content", styles: { backgroundColor: "#ffffff" } },
    }));
    assert.equal(ab.name, "Hero Screen");

    const wh = mcpTextJson(await mcp(srv.baseUrl, "tools/call", {
      name: "write_html",
      arguments: {
        parentId: ab.id,
        html: `<div data-name="Banner" class="unused" style="display:flex; gap:12px; padding:16px">
          <h2 data-name="Headline" style="color:#0a0b0d; font-size:20px">Light Precision</h2>
          <button data-name="CTA" style="background-color:#0000ff; color:#ffffff; padding:8px 14px">Open</button>
        </div><script>evil()</script>`,
      },
    }));
    assert.equal(wh.layers, 3);
    assert.equal(wh.warnings.length, 1);

    const bannerId = wh.created[0].id;
    await fetch(`${srv.baseUrl}/api/selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [bannerId] }),
    });
    const selInfo = mcpTextJson(await mcp(srv.baseUrl, "tools/call", { name: "get_selection", arguments: {} }));
    assert.equal(selInfo.nodes.length, 1);
    assert.equal(selInfo.nodes[0].artboard, "Hero Screen");

    // Edge case: set_selection([]) clears selection without throwing 404
    const cleared = mcpTextJson(await mcp(srv.baseUrl, "tools/call", {
      name: "set_selection",
      arguments: { nodeIds: [], zoom: false },
    }));
    assert.deepEqual(cleared.selected, []);

    const children = mcpTextJson(await mcp(srv.baseUrl, "tools/call", {
      name: "get_children",
      arguments: { nodeId: bannerId },
    }));
    const replaced = mcpTextJson(await mcp(srv.baseUrl, "tools/call", {
      name: "write_html",
      arguments: {
        mode: "replace",
        targetNodeId: children[0].id,
        html: `<h1 data-name="Updated Title" style="color:#0000ff">Replaced Heading</h1>`,
      },
    }));
    assert.equal(replaced.created[0].name, "Updated Title");

    await mcp(srv.baseUrl, "tools/call", { name: "finish_working_on_nodes", arguments: {} });
    const info2 = mcpTextJson(await mcp(srv.baseUrl, "tools/call", { name: "get_basic_info", arguments: {} }));
    assert.deepEqual(info2.agentWorkingOn, []);

    const htmlExport = await (await fetch(`${srv.baseUrl}/api/export?format=html&nodeId=${ab.id}`)).text();
    assert.match(htmlExport, /Replaced Heading/);
    assert.match(htmlExport, /\.layer-/);

    const jsxExport = await (await fetch(`${srv.baseUrl}/api/export?format=jsx&nodeId=${ab.id}`)).text();
    assert.match(jsxExport, /export function HeroScreen\(\)/);

    const badFormat = await fetch(`${srv.baseUrl}/api/export?format=pdf`);
    assert.equal(badFormat.status, 400);

    const zipRes = await fetch(`${srv.baseUrl}/api/export/zip?format=both`);
    assert.equal(zipRes.status, 200);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    assert.equal(zipBuf.readUInt32LE(0), 0x04034b50);
    assert.ok(zipBuf.includes("index.html"));
    assert.ok(zipBuf.includes("hero-screen.html"));
    assert.ok(zipBuf.includes("hero-screen.jsx"));
  });
});
