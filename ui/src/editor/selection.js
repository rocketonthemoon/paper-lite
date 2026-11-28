// Selection, inline text editing, creating / duplicating / deleting layers, and the current tool.
import { ed } from "./state.js";
import { api, elOf, expanded, isTextNode, markSelected, patch, saveExpanded, selectedIds, stage, topmostSelected } from "./core.js";
import { markStale, render, renderLayers, updateOverlay } from "./render.js";
import { renderInspector } from "./inspector.js";

export function select(id) {
  ed.pendingSel = null; // an explicit choice wins over a selection still waiting on the server (e.g. a fresh duplicate)
  ed.pendingMulti = null;
  ed.selEpoch += 1;
  const wasMulti = ed.multi.length > 0;
  ed.multi = [];
  if (id === ed.sel && !wasMulti) return;
  if (ed.editingId) finishEdit(true);
  ed.sel = id;
  if (ed.sel) { for (let p = ed.S.nodes[ed.sel]?.parentId; p && p !== ed.S.rootId; p = ed.S.nodes[p]?.parentId) expanded.add(p); saveExpanded(); }
  markSelected();
  renderLayers();
  renderInspector(true);
  updateOverlay();
  shareSelection();
}

// Several layers at once (marquee, Shift+click, Ctrl+A). `primary` is the one the inspector shows.
export function selectMany(ids, primary) {
  const list = [...new Set(ids)].filter((id) => ed.S.nodes[id] && id !== ed.S.rootId);
  if (list.length <= 1) return select(list[0] ?? null);
  ed.pendingSel = null;
  ed.pendingMulti = null;
  ed.selEpoch += 1;
  if (ed.editingId) finishEdit(true);
  ed.multi = list;
  ed.sel = list.includes(primary) ? primary : list[list.length - 1];
  for (const id of list) for (let p = ed.S.nodes[id].parentId; p && p !== ed.S.rootId; p = ed.S.nodes[p]?.parentId) expanded.add(p);
  saveExpanded();
  markSelected();
  renderLayers();
  renderInspector(true);
  updateOverlay();
  shareSelection();
}

// Shift / Ctrl / Cmd + click: add a layer to the selection, or take it out.
export function toggleSelected(id) {
  const cur = selectedIds();
  if (cur.includes(id)) selectMany(cur.filter((x) => x !== id));
  else selectMany([...cur, id], id);
}

// While a marquee is dragged: outline what it covers, without rebuilding the inspector and layers on every move.
export function previewSelection(ids) {
  const list = [...new Set(ids)].filter((id) => ed.S.nodes[id]);
  ed.multi = list.length > 1 ? list : [];
  ed.sel = list[list.length - 1] ?? null;
  markSelected();
  updateOverlay();
}

export function shareSelection() {
  clearTimeout(shareSelection.t);
  shareSelection.t = setTimeout(() => api("POST", "/api/selection", { ids: selectedIds() }), 120);
}

// Several edits as one undo step (see POST /api/nodes/batch).
export const batchEdit = (ops) => api("POST", "/api/nodes/batch", { ops });

export function pathTo(id) {
  const path = [];
  for (let n = ed.S.nodes[id]; n && n.id !== ed.S.rootId; n = ed.S.nodes[n.parentId]) path.unshift(n.id);
  return path;
}

export function pickTarget(deepest) {
  const path = pathTo(deepest);
  if (ed.sel) {
    const i = path.indexOf(ed.sel);
    if (i > 0) return ed.sel;
    const pi = path.indexOf(ed.S.nodes[ed.sel]?.parentId);
    if (pi >= 0 && path[pi + 1]) return path[pi + 1];
  }
  return path[1] || path[0];
}

export function startEdit(id) {
  const el = elOf(id);
  if (!el) { ed.pendingEdit = id; return; }
  if (!isTextNode(id)) return;
  select(id);
  ed.editingId = id;
  ed.editOriginal = ed.S.nodes[id].text;
  el.contentEditable = "plaintext-only";
  if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
  el.classList.add("editing");
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  el.addEventListener("keydown", (k) => {
    k.stopPropagation();
    if (k.key === "Escape") { k.preventDefault(); finishEdit(false); }
    else if (k.key === "Enter" && !k.shiftKey) { k.preventDefault(); finishEdit(true); }
  });
  el.addEventListener("input", updateOverlay);
  el.addEventListener("blur", () => finishEdit(true), { once: true });
}

export function finishEdit(commit) {
  if (!ed.editingId) return;
  const id = ed.editingId;
  const el = elOf(id);
  ed.editingId = null;
  const text = el ? el.innerText.replace(/\n$/, "") : ed.editOriginal;
  if (el) { el.contentEditable = "false"; el.classList.remove("editing"); markStale(el); }
  getSelection().removeAllRanges();
  if (commit && text !== ed.editOriginal) patch(id, { text });
  else render();
}

export async function removeSelected() {
  if (ed.multi.length) {
    const epoch = ed.selEpoch;
    const ok = await batchEdit(topmostSelected().map((id) => ({ op: "delete", id })));
    if (ok && ed.selEpoch === epoch) select(null);
    return;
  }
  if (!ed.sel || !ed.S?.nodes[ed.sel]) return;
  const epoch = ed.selEpoch, parent = ed.S.nodes[ed.sel].parentId;
  const ok = await api("DELETE", `/api/nodes/${encodeURIComponent(ed.sel)}`);
  if (ok && ed.selEpoch === epoch) select(parent === ed.S.rootId || !ed.S.nodes[parent] ? null : parent);
}

// Only jump to the new layer if the user hasn't selected something else (or switched tools) while the request ran.
export async function duplicateSelected() {
  if (ed.multi.length) {
    const epoch = ed.selEpoch;
    const res = await batchEdit(topmostSelected().map((id) => ({ op: "duplicate", id })));
    // The copies arrive over SSE; render() selects them once they are all there.
    if (res && ed.selEpoch === epoch) { ed.pendingMulti = res.results.map((r) => r.id); render(); }
    return;
  }
  if (!ed.sel || !ed.S?.nodes[ed.sel]) return;
  const epoch = ed.selEpoch;
  const dup = await api("POST", `/api/nodes/${encodeURIComponent(ed.sel)}/duplicate`);
  if (dup && ed.selEpoch === epoch) { ed.pendingSel = dup.id; render(); }
}

export async function createNode(body, { edit = false } = {}) {
  const epoch = ed.selEpoch, fromToolEpoch = ed.toolEpoch;
  const node = await api("POST", "/api/nodes", body);
  if (!node || ed.selEpoch !== epoch) return;
  ed.pendingSel = node.id;
  if (edit) ed.pendingEdit = node.id;
  render();
  // Only fall back to Select if nobody picked a tool since this layer was drawn (e.g. pressing R again to draw
  // another rectangle while this request was in flight must not be undone mid-gesture).
  if (ed.toolEpoch === fromToolEpoch) setTool("select");
}

export function setTool(t) {
  ed.tool = t;
  ed.toolEpoch += 1;
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  stage.className = `tool-${t}`;
  updateOverlay();
}
