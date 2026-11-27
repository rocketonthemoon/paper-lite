// Drag and resize of the selected layer, with interact.js (bundled from npm). The preview moves the
// element directly; the server gets one patch when the gesture ends.
import interact from "interactjs";
import { ed } from "./state.js";
import { GRID, elOf, num, patchStyles, snapInput } from "./core.js";
import { markStale, render, updateOverlay } from "./render.js";
import { select } from "./selection.js";

let op = null;
const snapV = (v) => (snapInput.checked ? Math.round(v / GRID) * GRID : Math.round(v));

function dragStart(e, id, fromLabel = false) {
  const n = ed.S.nodes[id];
  if (!n || ed.tool !== "select" || ed.spaceDown || ed.editingId || n.styles.position !== "absolute" || (!fromLabel && id !== ed.sel)) {
    e.interaction.stop();
    return;
  }
  const el = elOf(id);
  op = { id, el, x0: num(n.styles.left, el.offsetLeft), y0: num(n.styles.top, el.offsetTop), dx: 0, dy: 0 };
  markStale(el); // the drag preview sets inline left/top
  ed.busy = true;
  if (ed.sel !== id) select(id);
}
function dragMove(e) {
  if (!op) return;
  op.dx += e.dx / ed.view.z; op.dy += e.dy / ed.view.z;
  op.x = snapV(op.x0 + op.dx); op.y = snapV(op.y0 + op.dy);
  op.el.style.left = `${op.x}px`; op.el.style.top = `${op.y}px`;
  updateOverlay();
}
function dragEnd() {
  if (!op) return;
  const { id, x, y, x0, y0 } = op;
  op = null; ed.busy = false;
  if (x !== undefined && (x !== x0 || y !== y0)) patchStyles(id, { left: x, top: y });
  else if (ed.pendingRender) render();
  else updateOverlay();
}

function resizeStart(e) {
  const id = e.target.dataset.nodeId;
  const n = ed.S.nodes[id];
  if (!n || id !== ed.sel || ed.tool !== "select" || ed.spaceDown || ed.editingId) { e.interaction.stop(); return; }
  const el = e.target;
  markStale(el); // the resize preview sets inline width/height
  op = { id, el, abs: n.styles.position === "absolute", w: el.offsetWidth, h: el.offsetHeight,
    x: num(n.styles.left, el.offsetLeft), y: num(n.styles.top, el.offsetTop), moved: false };
  ed.busy = true;
}
function resizeMove(e) {
  if (!op) return;
  const d = e.deltaRect, z = ed.view.z;
  const canLeft = op.abs || !e.edges.left, canTop = op.abs || !e.edges.top;
  if (canLeft) { op.w = Math.max(1, op.w + d.width / z); if (op.abs) op.x += d.left / z; }
  if (canTop) { op.h = Math.max(1, op.h + d.height / z); if (op.abs) op.y += d.top / z; }
  op.moved = true;
  Object.assign(op.el.style, { width: `${snapV(op.w)}px`, height: `${snapV(op.h)}px` });
  if (op.abs) Object.assign(op.el.style, { left: `${snapV(op.x)}px`, top: `${snapV(op.y)}px` });
  updateOverlay();
}
function resizeEnd() {
  if (!op) return;
  const o = op;
  op = null; ed.busy = false;
  if (!o.moved) { if (ed.pendingRender) render(); else updateOverlay(); return; }
  const styles = { width: snapV(o.w), height: snapV(o.h) };
  if (o.abs) Object.assign(styles, { left: snapV(o.x), top: snapV(o.y) });
  patchStyles(o.id, styles);
}

export function setupInteract() {
  interact("#world .is-selected")
    .draggable({ listeners: { start: (e) => dragStart(e, e.target.dataset.nodeId), move: dragMove, end: dragEnd } })
    .resizable({ edges: { left: true, right: true, top: true, bottom: true }, margin: 6,
      listeners: { start: resizeStart, move: resizeMove, end: resizeEnd } });
  interact("#labels .ab-label").draggable({ listeners: { start: (e) => dragStart(e, e.target.dataset.id, true), move: dragMove, end: dragEnd } });
}
