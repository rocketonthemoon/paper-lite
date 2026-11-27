// Measuring layers for get_computed_styles. The server asks every open editor tab first (a "measure" event): the
// canvas already has the page laid out with the same CSS as the render page, so answering takes a few ms, where
// headless Chrome would have to load the artboard. A tab only answers when what it shows is exactly what the server
// has; otherwise it says it can't, and the server falls back to headless Chrome.
import { ed } from "./state.js";
import { api, elOf } from "./core.js";

// Same values and filtering as the headless Chrome renderer (renderer.js, computed()), so either answer is the same.
const SKIP = new Set(["none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)"]);
// On the canvas an artboard sits at its world position (position: absolute, left, top); on the render page and in
// exports it is position: relative at 0,0 (server.js, exportStyles). With a fixed width and height that changes
// nothing inside it, so those properties are reported as the render page has them.
const PLACEMENT = new Set(["position", "left", "top", "right", "bottom", "inset"]);
const FIXED = /^\d+(\.\d+)?(px)?$/;
const fixedSize = (n) => FIXED.test(String(n.styles.width ?? "")) && FIXED.test(String(n.styles.height ?? ""));

function canMeasure(req) {
  return ed.S && ed.S.id === req.projectId && ed.S.version === req.version && ed.fontsRev === req.fontsRev
    && document.fonts?.status !== "loading"
    && !ed.busy && !ed.pendingRender && !ed.pointerHeld && !ed.editingId // a drag, resize or text edit changes the DOM
    && ed.S.nodes[req.artboardId]?.parentId === ed.S.rootId && elOf(req.artboardId) // on the page this tab shows
    && fixedSize(ed.S.nodes[req.artboardId]); // a "hug" artboard could lay out differently when not absolute
}

export function measure(req) {
  const z = ed.view.z; // the canvas is scaled by the zoom; boxes are reported in design pixels
  const root = elOf(req.artboardId).getBoundingClientRect();
  const out = {};
  for (const id of req.nodeIds) {
    const el = elOf(id);
    if (!el) { out[id] = null; continue; }
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), styles = {};
    for (const p of req.properties) {
      const v = id === req.artboardId && PLACEMENT.has(p) ? (p === "position" ? "relative" : "auto") : cs.getPropertyValue(p);
      if (v && !SKIP.has(v)) styles[p] = v;
    }
    out[id] = { box: {
      x: Math.round((r.left - root.left) / z), y: Math.round((r.top - root.top) / z),
      width: Math.round(r.width / z), height: Math.round(r.height / z),
    }, styles };
  }
  return out;
}

export function answerMeasure(req) {
  let result = null;
  try { if (canMeasure(req)) result = measure(req); } catch (err) { console.error("[weft] measure", err); }
  return api("POST", `/api/measure/${encodeURIComponent(req.id)}`, result ? { result, version: req.version } : { unavailable: true });
}
