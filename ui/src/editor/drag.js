// Drag and resize of the selected layer, with interact.js (bundled from npm). The preview moves the
// element directly; the server gets one patch when the gesture ends. Dragging any layer of a multi-selection moves
// all of them (those placed absolutely), saved as one undo step.
import interact from "interactjs";
import { ed } from "./state.js";
import { GRID, elOf, num, patchStyles, snapInput, topmostSelected } from "./core.js";
import { layoutSize, markStale, render, updateOverlay } from "./render.js";
import { batchEdit, select } from "./selection.js";

let op = null;
const snapV = (v) => (snapInput.checked ? Math.round(v / GRID) * GRID : Math.round(v));

function dragStart(e, id, fromLabel = false) {
  const n = ed.S.nodes[id];
  if (n && ed.multi.includes(id) && ed.tool === "select" && !ed.spaceDown && !ed.editingId) {
    const items = topmostSelected().filter((sid) => ed.S.nodes[sid]?.styles.position === "absolute" && elOf(sid)).map((sid) => {
      const el = elOf(sid), st = ed.S.nodes[sid].styles;
      markStale(el);
      return { id: sid, el, x0: num(st.left, el.offsetLeft), y0: num(st.top, el.offsetTop) };
    });
    if (!items.length) { e.interaction.stop(); return; }
    op = { items, dx: 0, dy: 0 };
    ed.busy = true;
    return;
  }
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
  if (op.items) {
    op.dx += e.dx / ed.view.z; op.dy += e.dy / ed.view.z;
    for (const it of op.items) {
      it.x = snapV(it.x0 + op.dx); it.y = snapV(it.y0 + op.dy);
      it.el.style.left = `${it.x}px`; it.el.style.top = `${it.y}px`;
    }
    updateOverlay();
    return;
  }
  op.dx += e.dx / ed.view.z; op.dy += e.dy / ed.view.z;
  op.x = snapV(op.x0 + op.dx); op.y = snapV(op.y0 + op.dy);
  op.el.style.left = `${op.x}px`; op.el.style.top = `${op.y}px`;
  updateOverlay();
}
function dragEnd() {
  if (!op) return;
  if (op.items) {
    const moved = op.items.filter((it) => it.x !== undefined && (it.x !== it.x0 || it.y !== it.y0));
    op = null; ed.busy = false;
    if (moved.length) batchEdit(moved.map((it) => ({ op: "update", id: it.id, patch: { styles: { left: it.x, top: it.y } } })));
    else if (ed.pendingRender) render();
    else updateOverlay();
    return;
  }
  const { id, x, y, x0, y0 } = op;
  op = null; ed.busy = false;
  if (x !== undefined && (x !== x0 || y !== y0)) patchStyles(id, { left: x, top: y });
  else if (ed.pendingRender) render();
  else updateOverlay();
}

// Start resizing layer `id` (it must be the selected one); false when it can't be resized right now.
function beginResize(id, el) {
  const n = ed.S.nodes[id];
  if (!n || !el || id !== ed.sel || ed.tool !== "select" || ed.spaceDown || ed.editingId || ed.multi.length) return false;
  markStale(el); // the resize preview sets inline width/height
  op = { id, el, abs: n.styles.position === "absolute", ...layoutSize(el),
    x: num(n.styles.left, el.offsetLeft), y: num(n.styles.top, el.offsetTop), moved: false };
  ed.busy = true;
  return true;
}
function resizeStart(e) {
  if (!beginResize(e.target.dataset.nodeId, e.target)) e.interaction.stop();
}
// `d`: how the box changed on screen since the last move ({ left, top, width, height }); `edges`: which edges move.
function applyResize(d, edges) {
  if (!op) return;
  const z = ed.view.z;
  // A layer in normal flow can't move, so it only grows or shrinks from its right and bottom edges.
  const canLeft = op.abs || !edges.left, canTop = op.abs || !edges.top;
  if (canLeft) { op.w = Math.max(1, op.w + d.width / z); if (op.abs) op.x += d.left / z; }
  if (canTop) { op.h = Math.max(1, op.h + d.height / z); if (op.abs) op.y += d.top / z; }
  op.moved = true;
  Object.assign(op.el.style, { width: `${snapV(op.w)}px`, height: `${snapV(op.h)}px` });
  if (op.abs) Object.assign(op.el.style, { left: `${snapV(op.x)}px`, top: `${snapV(op.y)}px` });
  updateOverlay();
}
function resizeMove(e) {
  applyResize(e.deltaRect, e.edges);
}

// The corner squares on the selection box are resize grips too (they sit half outside the layer, so its own edges
// can't catch them). Dragging one resizes from that corner, with the same preview and single save as an edge.
function handleDown(e) {
  const corner = e.currentTarget.className; // nw | ne | sw | se
  if (e.button !== 0 || !beginResize(ed.sel, elOf(ed.sel))) return;
  e.preventDefault();
  e.stopPropagation(); // not a click on whatever is behind the handle
  const edges = { left: corner.includes("w"), right: corner.includes("e"), top: corner.includes("n"), bottom: corner.includes("s") };
  const grip = e.currentTarget;
  grip.setPointerCapture?.(e.pointerId);
  let lx = e.clientX, ly = e.clientY;
  const move = (ev) => {
    const dx = ev.clientX - lx, dy = ev.clientY - ly;
    lx = ev.clientX; ly = ev.clientY;
    applyResize({
      left: edges.left ? dx : 0, top: edges.top ? dy : 0,
      width: edges.right ? dx : edges.left ? -dx : 0, height: edges.bottom ? dy : edges.top ? -dy : 0,
    }, edges);
  };
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
    resizeEnd();
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
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
  for (const grip of document.querySelectorAll("#sel-box i")) grip.addEventListener("pointerdown", handleDown);
  interact("#world .is-selected")
    .draggable({ listeners: { start: (e) => dragStart(e, e.target.dataset.nodeId), move: dragMove, end: dragEnd } })
    .resizable({ edges: { left: true, right: true, top: true, bottom: true }, margin: 6,
      listeners: { start: resizeStart, move: resizeMove, end: resizeEnd } })
    // Several layers selected: no resizing (it applies to one layer), so a press near an edge drags them all instead.
    .actionChecker((pointer, event, action) => (action?.name === "resize" && ed.multi.length ? { name: "drag" } : action));
  interact("#labels .ab-label").draggable({ listeners: { start: (e) => dragStart(e, e.target.dataset.id, true), move: dragMove, end: dragEnd } });
}
