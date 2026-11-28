// Unit tests for server/selective-revert.js: taking back some steps' own changes while keeping everyone else's.
import test from "node:test";
import assert from "node:assert/strict";
import { revertPatches } from "../server/selective-revert.js";

// A tiny document: page P with artboard A holding layers x and y.
const doc = () => ({
  pages: ["P"], rootId: "P",
  rootCss: { vars: { "--c": "#000" }, rules: [] }, icons: {}, components: {},
  nodes: {
    P: { id: "P", name: "Page", tag: "div", parentId: null, children: ["A"], text: "", styles: {}, attrs: {} },
    A: { id: "A", name: "Board", tag: "div", parentId: "P", children: ["x", "y"], text: "", styles: { width: "400px" }, attrs: {} },
    x: { id: "x", name: "X", tag: "div", parentId: "A", children: [], text: "", styles: { color: "red", padding: "4px" }, attrs: {} },
    y: { id: "y", name: "Y", tag: "p", parentId: "A", children: [], text: "hi", styles: {}, attrs: {} },
  },
});
// Run `edit` on a copy of `d` and return the patch { before, after } it made (only the nodes that changed).
const step = (d, edit) => {
  const prev = structuredClone(d);
  edit(d);
  const before = { nodes: {} }, after = { nodes: {} };
  for (const id of new Set([...Object.keys(prev.nodes), ...Object.keys(d.nodes)])) {
    const a = prev.nodes[id] ?? null, b = d.nodes[id] ?? null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    before.nodes[id] = structuredClone(a);
    after.nodes[id] = structuredClone(b);
  }
  const meta = (x) => ({ pages: x.pages, rootCss: x.rootCss, icons: x.icons, components: x.components });
  if (JSON.stringify(meta(prev)) !== JSON.stringify(meta(d))) { before.meta = structuredClone(meta(prev)); after.meta = structuredClone(meta(d)); }
  return { before, after };
};

test("a style the step set goes back; a style someone changed since is kept and reported", () => {
  const d = doc();
  const mine = step(d, (s) => { s.nodes.x.styles.color = "blue"; s.nodes.x.styles.padding = "12px"; });
  step(d, (s) => { s.nodes.x.styles.color = "green"; }); // someone else, later
  const r = revertPatches(d, [mine]);
  assert.equal(d.nodes.x.styles.padding, "4px");
  assert.equal(d.nodes.x.styles.color, "green");
  assert.deepEqual(r.skipped, [{ id: "x", name: "X", fields: ["styles.color"] }]);
});

test("a layer the step created goes away; one someone edited since stays, with its contents", () => {
  const d = doc();
  const mine = step(d, (s) => {
    s.nodes.c = { id: "c", name: "Card", tag: "div", parentId: "A", children: ["t"], text: "", styles: {}, attrs: {} };
    s.nodes.t = { id: "t", name: "Title", tag: "h3", parentId: "c", children: [], text: "T", styles: {}, attrs: {} };
    s.nodes.A.children.push("c");
  });
  const clean = structuredClone(d);
  revertPatches(clean, [mine]);
  assert.ok(!clean.nodes.c && !clean.nodes.t);
  assert.deepEqual(clean.nodes.A.children, ["x", "y"]);

  step(d, (s) => { s.nodes.c.styles.color = "pink"; }); // someone styles the card
  const r = revertPatches(d, [mine]);
  assert.ok(d.nodes.c && d.nodes.t, "the edited card and the title inside it stay");
  assert.deepEqual(d.nodes.A.children, ["x", "y", "c"]);
  assert.equal(r.skipped[0].id, "c");
});

test("a deleted layer comes back in its old place, around layers added since", () => {
  const d = doc();
  const mine = step(d, (s) => { delete s.nodes.x; s.nodes.A.children = ["y"]; });
  step(d, (s) => { s.nodes.z = { id: "z", name: "Z", tag: "div", parentId: "A", children: [], text: "", styles: {}, attrs: {} }; s.nodes.A.children.push("z"); });
  step(d, (s) => { s.nodes.A.name = "Renamed"; });
  revertPatches(d, [mine]);
  assert.ok(d.nodes.x);
  assert.deepEqual(d.nodes.A.children, ["x", "y", "z"]);
  assert.equal(d.nodes.A.name, "Renamed");
});

test("a deleted layer whose parent was deleted since is reported, not orphaned", () => {
  const d = doc();
  const mine = step(d, (s) => { delete s.nodes.x; s.nodes.A.children = ["y"]; });
  step(d, (s) => { delete s.nodes.A; delete s.nodes.y; s.nodes.P.children = []; });
  const r = revertPatches(d, [mine]);
  assert.ok(!d.nodes.x);
  assert.ok(r.skipped.some((k) => k.id === "x" && k.fields.includes("its parent was deleted since")));
});

test("a move goes back, into the old parent at the old position", () => {
  const d = doc();
  d.nodes.B = { id: "B", name: "Other", tag: "div", parentId: "P", children: [], text: "", styles: {}, attrs: {} };
  d.nodes.P.children.push("B");
  const mine = step(d, (s) => { s.nodes.x.parentId = "B"; s.nodes.A.children = ["y"]; s.nodes.B.children = ["x"]; });
  revertPatches(d, [mine]);
  assert.equal(d.nodes.x.parentId, "A");
  assert.deepEqual(d.nodes.A.children, ["x", "y"]);
  assert.deepEqual(d.nodes.B.children, []);
});

test("a reorder goes back unless someone reordered since", () => {
  const d = doc();
  const mine = step(d, (s) => { s.nodes.A.children = ["y", "x"]; });
  const clean = structuredClone(d);
  revertPatches(clean, [mine]);
  assert.deepEqual(clean.nodes.A.children, ["x", "y"]);
  step(d, (s) => { s.nodes.z = { id: "z", name: "Z", tag: "div", parentId: "A", children: [], text: "", styles: {}, attrs: {} }; s.nodes.A.children = ["z", "y", "x"]; });
  revertPatches(d, [mine]);
  assert.deepEqual(d.nodes.A.children, ["z", "y", "x"], "someone else's order is kept");
});

test("root CSS variables go back one by one", () => {
  const d = doc();
  const mine = step(d, (s) => { s.rootCss.vars["--c"] = "#111"; s.rootCss.vars["--new"] = "1px"; });
  step(d, (s) => { s.rootCss.vars["--c"] = "#222"; });
  const r = revertPatches(d, [mine]);
  assert.equal(d.rootCss.vars["--new"], undefined);
  assert.equal(d.rootCss.vars["--c"], "#222");
  assert.deepEqual(r.metaSkipped, ["root CSS --c"]);
});

test("several steps of one author revert newest first", () => {
  const d = doc();
  const s1 = step(d, (s) => { s.nodes.x.styles.color = "blue"; });
  const s2 = step(d, (s) => { s.nodes.x.styles.color = "black"; s.nodes.y.text = "bye"; });
  revertPatches(d, [s1, s2]);
  assert.equal(d.nodes.x.styles.color, "red");
  assert.equal(d.nodes.y.text, "hi");
});

// Found by fuzzing interleaved agents and user edits.
test("a move isn't reverted into a parent that was deleted since", () => {
  const d = doc();
  d.nodes.B = { id: "B", name: "Other", tag: "div", parentId: "P", children: [], text: "", styles: {}, attrs: {} };
  d.nodes.P.children.push("B");
  const mine = step(d, (s) => { s.nodes.x.parentId = "B"; s.nodes.A.children = ["y"]; s.nodes.B.children = ["x"]; });
  step(d, (s) => { delete s.nodes.A; delete s.nodes.y; s.nodes.P.children = ["B"]; });
  const r = revertPatches(d, [mine]);
  assert.equal(d.nodes.x.parentId, "B", "stays where it is instead of becoming an orphan");
  assert.deepEqual(d.nodes.B.children, ["x"]);
  assert.ok(r.skipped.some((k) => k.id === "x" && k.fields[0].startsWith("parentId")));
});

test("a created layer that holds a kept layer stays, so the kept one keeps its parent", () => {
  const d = doc();
  const mine = step(d, (s) => {
    s.nodes.c = { id: "c", name: "Card", tag: "div", parentId: "A", children: ["t"], text: "", styles: {}, attrs: {} };
    s.nodes.t = { id: "t", name: "Title", tag: "h3", parentId: "c", children: [], text: "T", styles: {}, attrs: {} };
    s.nodes.A.children.push("c");
  });
  step(d, (s) => { s.nodes.t.text = "Edited by someone"; }); // the inner layer is edited, not the card
  revertPatches(d, [mine]);
  assert.ok(d.nodes.c && d.nodes.t, "card and title both stay");
  assert.equal(d.nodes.t.parentId, "c");
  assert.deepEqual(d.nodes.A.children, ["x", "y", "c"]);
});

test("a page the step created stays listed when it's kept because someone filled it", () => {
  const d = doc();
  const mine = step(d, (s) => {
    s.nodes.Q = { id: "Q", name: "Page 2", tag: "div", parentId: null, children: [], text: "", styles: {}, attrs: {} };
    s.pages.push("Q");
  });
  step(d, (s) => {
    s.nodes.k = { id: "k", name: "Board 2", tag: "div", parentId: "Q", children: [], text: "", styles: {}, attrs: {} };
    s.nodes.Q.children.push("k");
  });
  revertPatches(d, [mine]);
  assert.ok(d.nodes.Q && d.pages.includes("Q"), "kept page is still a page");
  assert.equal(d.nodes.k.parentId, "Q");
});

test("a component some layer still links to isn't removed; a link to a missing component is detached", () => {
  const d = doc();
  const mine = step(d, (s) => {
    s.components.btn = { id: "btn", name: "btn", tree: { key: "root", tag: "div", name: "X", children: [] } };
    Object.assign(s.nodes.x, { componentId: "btn", componentKey: "root" });
  });
  step(d, (s) => { s.nodes.x.componentKey = "root"; s.nodes.x.componentOverrides = { name: true }; s.nodes.x.name = "Edited"; });
  const clean = structuredClone(d);
  revertPatches(clean, [mine]);
  assert.ok(clean.components.btn, "x still links to btn, so btn stays");

  const d2 = doc();
  d2.components.gone = { id: "gone", name: "gone", tree: { key: "root", tag: "div", name: "Y", children: [] } };
  const del = step(d2, (s) => { delete s.nodes.y; s.nodes.A.children = ["x"]; });
  d2.nodes = { ...d2.nodes }; // y was an instance of "gone" before the step
  del.before.nodes.y = { ...del.before.nodes.y, componentId: "gone", componentKey: "root" };
  step(d2, (s) => { delete s.components.gone; });
  const r = revertPatches(d2, [del]);
  assert.ok(d2.nodes.y, "y comes back");
  assert.equal(d2.nodes.y.componentId, undefined, "…as a plain layer, since its component is gone");
  assert.ok(r.skipped.some((k) => k.id === "y" && k.fields[0].startsWith("component link")));
});
