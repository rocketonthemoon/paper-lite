// Pointer handling on the canvas: click to select (deepest layer with Ctrl/Cmd), double-click to edit text,
// hover, comment placement, and the artboard labels.
import { ed } from "./state.js";
import { $, commentThreadEl, isTextNode, stage } from "./core.js";
import { render, updateOverlay } from "./render.js";
import { finishEdit, pathTo, pickTarget, select, setTool, startEdit } from "./selection.js";
import { startPan } from "./view.js";
import { startCreate } from "./draw.js";
import { closeCommentThread, openNewComment } from "./comments.js";

function releasePointer() {
  if (!ed.pointerHeld) return;
  ed.pointerHeld = false;
  if (ed.pendingRender && !ed.busy && !ed.editingId) render();
}
function pickHover(deepest) { const p = pathTo(deepest); const i = p.indexOf(ed.sel); return i >= 0 ? p[Math.min(i + 1, p.length - 1)] : pickTarget(deepest); }

// Pressing an artboard label (../components/canvas/ArtboardLabels.svelte) selects the artboard, or pans with the
// Hand tool, Space or the middle button. Dragging it is interact.js (./drag.js); double-click renames (renameRow).
export function labelPointerDown(e, id) {
  if (ed.spaceDown || ed.tool === "hand" || e.button === 1) return startPan(e);
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
    select(hit ? pickTarget(hit.dataset.nodeId) : null);
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
