// Layers panel callbacks (../components/LayersPanel.svelte): expand / collapse, hover, rename, and the rules for
// dropping a layer onto or between others.
import { ed } from "./state.js";
import { SVG_TAGS, VOID_TAGS, expanded, isTextNode, patch, saveExpanded, toast } from "./core.js";
import { renderLayers, updateOverlay } from "./render.js";
import { select } from "./selection.js";

// Clicks, hover, rename and drag & drop on rows are handled in LayersPanel.svelte, which calls back into the
// functions below through window.weft.
export function toggleExpanded(id) {
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  saveExpanded();
  renderLayers();
}
export function hoverLayer(id) {
  if (id !== ed.hoverId) { ed.hoverId = id; updateOverlay(); }
}
// Start renaming a layer in the tree (also used by double-clicking an artboard's label on the canvas).
export function renameRow(id) {
  select(id);
  window.weft.events.dispatchEvent(new CustomEvent("layer-rename", { detail: id }));
}
export async function renameLayer(id, name) {
  const ok = await patch(id, { name });
  if (!ok) renderLayers();
  return ok;
}

// Can the dragged layer become a child of target? Artboards stay top-level, and HTML and SVG don't mix.
export function canNestIn(dragId, targetId) {
  const target = ed.S.nodes[targetId], drag = ed.S.nodes[dragId];
  if (!target || !drag || drag.parentId === ed.S.rootId) return false;
  if (VOID_TAGS.has(target.tag) || isTextNode(targetId)) return false;
  const targetSvg = SVG_TAGS.has(target.tag), dragSvg = SVG_TAGS.has(drag.tag);
  if (targetSvg) return dragSvg && (target.tag === "svg" || target.tag === "g") && drag.tag !== "svg";
  return !dragSvg || drag.tag === "svg";
}
// Move layer `id` before / after / inside `targetId`, enforcing the tree's rules. zone: "before" | "after" | "inside".
export function dropLayer(id, targetId, zone) {
  if (!ed.S.nodes[id] || !ed.S.nodes[targetId] || id === targetId) return;
  const target = ed.S.nodes[targetId];
  const dragIsArtboard = ed.S.nodes[id].parentId === ed.S.rootId;
  if (dragIsArtboard && target.parentId !== ed.S.rootId) return toast("Artboards stay at the top level");
  // A layer dropped on an artboard row goes into that artboard (there's no "between artboards" for layers).
  if (!dragIsArtboard && target.parentId === ed.S.rootId) zone = "inside";
  if (zone === "inside" && !canNestIn(id, target.id)) return toast(`Can't put ${ed.S.nodes[id].tag} inside ${target.tag}`);
  if (zone === "inside") return patch(id, { parentId: target.id });
  const parent = ed.S.nodes[target.parentId];
  let index = parent.children.indexOf(target.id) + (zone === "after" ? 1 : 0);
  const cur = parent.children.indexOf(id);
  if (cur >= 0 && cur < index) index -= 1;
  return patch(id, { parentId: parent.id, index });
}
