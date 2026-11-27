// Selection, inline text editing, creating / duplicating / deleting layers, and the current tool.
import { ed } from "./state.js";
import { api, elOf, expanded, isTextNode, patch, saveExpanded, stage } from "./core.js";
import { markStale, render, renderLayers, updateOverlay } from "./render.js";
import { renderInspector } from "./inspector.js";

export function select(id) {
  ed.pendingSel = null; // an explicit choice wins over a selection still waiting on the server (e.g. a fresh duplicate)
  ed.selEpoch += 1;
  if (id === ed.sel) return;
  if (ed.editingId) finishEdit(true);
  elOf(ed.sel)?.classList.remove("is-selected");
  ed.sel = id;
  if (ed.sel) { for (let p = ed.S.nodes[ed.sel]?.parentId; p && p !== ed.S.rootId; p = ed.S.nodes[p]?.parentId) expanded.add(p); saveExpanded(); }
  elOf(ed.sel)?.classList.add("is-selected");
  renderLayers();
  renderInspector(true);
  updateOverlay();
  shareSelection();
}

export function shareSelection() {
  clearTimeout(shareSelection.t);
  shareSelection.t = setTimeout(() => api("POST", "/api/selection", { ids: ed.sel ? [ed.sel] : [] }), 120);
}

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
  if (!ed.sel || !ed.S?.nodes[ed.sel]) return;
  const epoch = ed.selEpoch, parent = ed.S.nodes[ed.sel].parentId;
  const ok = await api("DELETE", `/api/nodes/${encodeURIComponent(ed.sel)}`);
  if (ok && ed.selEpoch === epoch) select(parent === ed.S.rootId || !ed.S.nodes[parent] ? null : parent);
}

// Only jump to the new layer if the user hasn't selected something else (or switched tools) while the request ran.
export async function duplicateSelected() {
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
