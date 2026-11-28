// Regressions found by driving the MCP tools with odd and edge-case input.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mcpCall, startServer } from "./helpers.js";

test("MCP edge cases: instances in duplicated containers, artboard sizes and placement, override and patch typos, var loops", { timeout: 60_000 }, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pl-edge-"));
  const srv = await startServer(dataDir);
  t.after(() => srv.stop());
  const call = (name, args) => mcpCall(srv.baseUrl, name, args);
  const state = async () => (await fetch(`${srv.baseUrl}/api/state`)).json();

  await t.test("artboard sizes must be positive and sane; keywords still pass", async () => {
    for (const width of [-5, 0, "0px", 1e9]) await assert.rejects(call("create_artboard", { width }), /between 1 and/);
    const ok = await call("create_artboard", { name: "Fluid", width: "100%", height: "fit-content" });
    await call("delete_nodes", { nodeIds: [ok.id] });
  });

  const a = await call("create_artboard", { name: "A", width: 400, height: 400, x: 0, y: 0 });
  const b = await call("create_artboard", { name: "B", width: 400, height: 400, x: 480, y: 0 });
  await call("create_component", { name: "chip", html: `<div data-name="Chip"><span data-slot="label">Default</span></div>` });

  await t.test("an override key that matches no slot is reported", async () => {
    const res = await call("instantiate_component", { component: "chip", parentId: a.id, overrides: { label: "Mine", nope: "x" } });
    assert.ok(res.warnings?.some((w) => /"nope" matches no slot/.test(w)), JSON.stringify(res));
  });

  await t.test("a duplicated artboard's instances keep their overrides through update_component", async () => {
    const [copy] = await call("duplicate_nodes", { nodeIds: [a.id] });
    await call("update_component", { component: "chip", slot: "root", patch: { styles: { padding: "4px" } } });
    const s = await state();
    const inst = s.nodes[s.nodes[copy.id].children[0]];
    assert.equal(s.nodes[inst.children[0]].text, "Mine");
    assert.equal(inst.styles.padding, "4px");
    // The copy went to a free spot instead of on top of B, which sits right of A.
    const left = parseFloat(s.nodes[copy.id].styles.left);
    assert.ok(left >= 480 + 400, `copy at ${left} overlaps B`);
    assert.ok(s.nodes[b.id]);
  });

  await t.test("update_component refuses no-ops and misshapen patch / appendHtml", async () => {
    await assert.rejects(call("update_component", { component: "chip" }), /Nothing to update/);
    await assert.rejects(call("update_component", { component: "chip", patch: { label: { styles: { color: "red" } } } }), /Unrecognized key/);
    await assert.rejects(call("update_component", { component: "chip", appendHtml: { slot: "label", html: "<b>x</b>" } }), /Unrecognized key/);
  });

  await t.test("update_root_css warns about var() loops", async () => {
    const res = await call("update_root_css", { vars: { "--x": "var(--y)", "--y": "var(--x)", "--fine": "var(--x)" } });
    assert.ok(res.warnings.some((w) => w.includes("--x → --y → --x")), JSON.stringify(res.warnings));
    assert.ok(!res.warnings.some((w) => w.includes("--fine →")));
  });
});
