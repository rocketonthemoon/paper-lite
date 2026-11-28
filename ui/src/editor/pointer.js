// Pointer handling on the canvas: click to select, Shift/Ctrl/Cmd+click to add or remove a layer, drag a marquee to
// select several, double-click to edit text, hover, comment placement, and the artboard labels.
import { ed } from "./state.js";
import { $, commentThreadEl, elOf, isArtboard, isTextNode, selectedIds, stage } from "./core.js";
import { placeBox, rectOnStage, render, updateOverlay } from "./render.js";
import { finishEdit, pathTo, pickTarget, previewSelection, select, selectMany, setTool, startEdit, toggleSelected } from "./selection.js";
import { startPan } from "./view.js";
import { startCreate } from "./draw.js";
import { closeCommentThread, openNewComment } from "./comments.js";

function releasePointer() {
  if (!ed.pointerHeld) return;
  ed.pointerHeld = false;
  if (ed.pendingRender && !ed.busy && !ed.editingId) render();
}
function pickHover(deepest) { const p = pathTo(deepest); const i = p.indexOf(ed.sel); return i >= 0 ? p[Math.min(i + 1, p.length - 1)] : pickTarget(deepest); }

// Drag a rectangle to select the layers it touches. From empty canvas it selects artboards; from an artboard's own
// background (an artboard that isn't selected; a selected one is dragged instead) it selects that artboard's layers.
// With Shift the covered layers are added to the selection. A press without a drag is a click on `clickTarget`.
function startMarquee(e, scopeId, clickTarget) {
  const s = stage.getBoundingClientRect();
  const a = { x: e.clientX - s.left, y: e.clientY - s.top };
  const additive = e.shiftKey;
  const base = additive ? selectedIds() : [];
  const box = $("#marquee");
  let rect = null, frame = 0;
  stage.setPointerCapture(e.pointerId);
  const covered = () => {
    const ids = (scopeId ? ed.S.nodes[scopeId]?.children : ed.S.nodes[ed.S.rootId].children) || [];
    return ids.filter((id) => {
      const el = elOf(id);
      if (!el) return false;
      const b = rectOnStage(el);
      return b.x < rect.x + rect.w && b.x + b.w > rect.x && b.y < rect.y + rect.h && b.y + b.h > rect.y;
    });
  };
  const move = (m) => {
    const bx = m.clientX - s.left, by = m.clientY - s.top;
    if (!rect && Math.abs(bx - a.x) < 4 && Math.abs(by - a.y) < 4) return; // still a click
    rect = { x: Math.min(a.x, bx), y: Math.min(a.y, by), w: Math.abs(bx - a.x), h: Math.abs(by - a.y) };
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; placeBox(box, rect); previewSelection([...base, ...covered()]); });
  };
  const up = () => {
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", up);
    stage.removeEventListener("pointercancel", up);
    cancelAnimationFrame(frame);
    placeBox(box, null);
    if (!rect) { if (!additive) select(clickTarget); return; }
    selectMany([...base, ...covered()]);
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
}

// Pressing an artboard label (../components/canvas/ArtboardLabels.svelte) selects the artboard, or pans with the
// Hand tool, Space or the middle button. Dragging it is interact.js (./drag.js); double-click renames (renameRow).
export function labelPointerDown(e, id) {
  if (ed.spaceDown || ed.tool === "hand" || e.button === 1) return startPan(e);
  if (e.shiftKey || e.ctrlKey || e.metaKey) return toggleSelected(id);
  if (ed.multi.includes(id)) return; // keep the selection: dragging the label moves all of it
  select(id);
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  stage.addEventListener("pointerdown", (e) => { if (e.button === 0) ed.pointerHeld = true; }, true);
  window.addEventListener("pointerup", releasePointer, true);
  window.addEventListener("pointercancel", releasePointer, true);
  window.addEventListener("blur", releasePointer);
  // Safety net if the release happened outside the window: any move with no button down ends the hold.
  window.addEventListener("pointermove", (e) => { if (ed.pointerHeld && e.buttons === 0) releasePointer(); }, true);

  stage.addEventListener("pointerdown", (e) => {
    // The zoom menu lives inside the stage: let clicks on it land (the document handler closes it on outside clicks).
    if (e.target.closest("#stage-hud, #ctx-bar, #stage-pill, #show-ui, .ab-label, #comment-thread, #comment-pins")) return;
    if (e.button === 1 || ed.spaceDown || ed.tool === "hand") { e.preventDefault(); return startPan(e); }
    if (e.button !== 0) return;
    if (ed.editingId && e.target.closest(".editing")) return;
    if (ed.editingId) finishEdit(true);
    if (ed.tool === "comment") {
      e.preventDefault();
      const hitC = e.target.closest("#world [data-node-id]");
      if (hitC) { const tid = pickTarget(hitC.dataset.nodeId); setTool("select"); openNewComment(tid); }
      return;
    }
    if ((ed.activeThreadId || ed.draftCommentNodeId) && !commentThreadEl.contains(e.target)) closeCommentThread();
    if (ed.tool !== "select") { e.preventDefault(); return startCreate(e); }
    const hit = e.target.closest("#world [data-node-id]");
    const target = hit ? pickTarget(hit.dataset.nodeId) : null;
    if (target && (e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); return toggleSelected(target); }
    // Pressing a layer that's part of a multi-selection keeps it, so dragging moves all of them.
    if (target && ed.multi.includes(target)) return;
    const artboardBackground = hit && e.target === hit && isArtboard(hit.dataset.nodeId) && !hit.classList.contains("is-selected");
    if (!hit || artboardBackground) { e.preventDefault(); return startMarquee(e, hit ? hit.dataset.nodeId : null, target); }
    select(target);
  });

  stage.addEventListener("dblclick", (e) => {
    if (e.target.closest("#stage-hud, #ctx-bar, #stage-pill")) return;
    if (ed.tool !== "select" || ed.editingId) return;
    const hit = e.target.closest("#world [data-node-id]");
    if (!hit) return;
    const path = pathTo(hit.dataset.nodeId);
    const deepest = path[path.length - 1];
    const i = path.indexOf(ed.sel);
    if (isTextNode(deepest) && (ed.sel === deepest || i === path.length - 2)) return startEdit(deepest);
    if (i >= 0 && i < path.length - 1) select(path[i + 1]);
    else if (ed.sel === deepest && isTextNode(deepest)) startEdit(deepest);
  });

  stage.addEventListener("click", (e) => { if (e.target.closest("#world a, #world button")) e.preventDefault(); }, true);

  stage.addEventListener("pointermove", (e) => {
    const placingEl = $("#comment-placing");
    if (ed.tool === "comment" && !ed.busy) {
      const hit = e.target.closest("#world [data-node-id]");
      const id = hit ? pickTarget(hit.dataset.nodeId) : null;
      if (id !== ed.hoverId) { ed.hoverId = id; updateOverlay(); }
      if (id && ed.S?.nodes[id]) {
        const sr = stage.getBoundingClientRect();
        placingEl.style.display = "flex";
        placingEl.style.left = `${Math.round(e.clientX - sr.left + 10)}px`;
        placingEl.style.top = `${Math.round(e.clientY - sr.top + 10)}px`;
        $("#placing-hint").textContent = `Comment on ${ed.S.nodes[id].name}`;
      } else { placingEl.style.display = "none"; }
      return;
    }
    if (placingEl) placingEl.style.display = "none";
    if (ed.busy || ed.tool !== "select") return;
    const hit = e.target.closest("#world [data-node-id]");
    const id = hit ? pickHover(hit.dataset.nodeId) : null;
    if (id !== ed.hoverId) { ed.hoverId = id; updateOverlay(); }
  });
  stage.addEventListener("pointerleave", () => { ed.hoverId = null; const p = $("#comment-placing"); if (p) p.style.display = "none"; updateOverlay(); });
}
