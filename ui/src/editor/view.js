// View: pan and zoom (wheel, zoom menu, fit to selection or page), and the Hand tool / Space panning.
import { ed } from "./state.js";
import { elOf, stage, toast, world } from "./core.js";
import { applyView } from "./render.js";
import { setFollowAgent } from "./comments.js";

const clampZ = (z) => Math.min(8, Math.max(0.03, z));
function zoomAt(factor, sx, sy) {
  const nz = clampZ(ed.view.z * factor);
  ed.view.x = sx - (sx - ed.view.x) * (nz / ed.view.z);
  ed.view.y = sy - (sy - ed.view.y) * (nz / ed.view.z);
  ed.view.z = nz;
  applyView();
}
function stageCenter() { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; }

export function worldBounds(els) {
  if (!els.length) return null;
  const s = stage.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    x0 = Math.min(x0, (r.left - s.left - ed.view.x) / ed.view.z);
    y0 = Math.min(y0, (r.top - s.top - ed.view.y) / ed.view.z);
    x1 = Math.max(x1, (r.right - s.left - ed.view.x) / ed.view.z);
    y1 = Math.max(y1, (r.bottom - s.top - ed.view.y) / ed.view.z);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function fitTo(b, maxZ = 2) {
  if (!b) return;
  const r = stage.getBoundingClientRect();
  const pad = 72;
  ed.view.z = clampZ(Math.min((r.width - pad * 2) / Math.max(1, b.w), (r.height - pad * 2) / Math.max(1, b.h), maxZ));
  ed.view.x = (r.width - b.w * ed.view.z) / 2 - b.x * ed.view.z;
  ed.view.y = (r.height - b.h * ed.view.z) / 2 - b.y * ed.view.z;
  applyView();
}

export function zoomCmd(mode) {
  const [cx, cy] = stageCenter();
  if (mode === "in") zoomAt(1.25, cx, cy);
  else if (mode === "out") zoomAt(0.8, cx, cy);
  else if (mode === "100") zoomAt(1 / ed.view.z, cx, cy);
  else if (mode === "fit") fitTo(worldBounds([...world.children]), 1);
  else if (mode === "selection") fitTo(ed.sel && elOf(ed.sel) ? worldBounds([elOf(ed.sel)]) : worldBounds([...world.children]), 4);
  toast({ in: "Zoom in", out: "Zoom out", 100: "Zoom to 100%", fit: "Zoom to fit", selection: "Zoom to selection" }[mode]);
}

export function startPan(e) {
  if (ed.followAgent) setFollowAgent(false, true);
  stage.setPointerCapture(e.pointerId);
  stage.classList.add("panning");
  let lx = e.clientX, ly = e.clientY;
  const move = (m) => { ed.view.x += m.clientX - lx; ed.view.y += m.clientY - ly; lx = m.clientX; ly = m.clientY; applyView(); };
  const up = () => {
    stage.classList.remove("panning");
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", up);
    stage.removeEventListener("pointercancel", up);
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    if (ed.followAgent) setFollowAgent(false, true);
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
    else { ed.view.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX; ed.view.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY; applyView(); }
  }, { passive: false });
}
