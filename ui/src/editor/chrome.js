// Editor chrome: the tool rail, export menu, layer filter, Hide UI, zoom menu and the add-artboard button.
import { ed } from "./state.js";
import { $, api, app, plural, stage, world } from "./core.js";
import { renderLayers, updateOverlay } from "./render.js";
import { copyExport, downloadZip } from "./inspector.js";
import { createNode, setTool } from "./selection.js";
import { worldBounds, zoomCmd } from "./view.js";
import { openProjectMenu } from "./projects.js";
import { openCmdk } from "./cmdk.js";

export const exportMenu = $("#export-menu");
function countProjectLayers() {
  if (!ed.S) return 0;
  const seen = new Set();
  for (const pid of ed.S.pages || []) {
    const stack = [...(ed.S.nodes[pid]?.children || [])];
    while (stack.length) {
      const nid = stack.pop();
      if (seen.has(nid) || !ed.S.nodes[nid]) continue;
      seen.add(nid);
      for (const c of ed.S.nodes[nid].children || []) stack.push(c);
    }
  }
  return seen.size;
}
// The menu's contents are ui/src/components/ExportMenu.svelte; it reads this when the menu opens.
export function exportMenuModel() {
  if (!ed.S) return null;
  const selNode = ed.sel && ed.S.nodes[ed.sel];
  const root = ed.S.nodes[ed.S.rootId];
  return {
    sel: selNode ? { name: selNode.name, node: { tag: selNode.tag, styles: selNode.styles } } : null,
    page: `${root.name} · ${plural(root.children.length, "artboard")}`,
    project: `.zip · ${plural(ed.S.pages.length, "page")} · ${plural(countProjectLayers(), "layer")}`,
    slug: ed.S.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project",
  };
}
export function exportAction(act, zipFmt) {
  if (act === "copy-sel-html") return copyExport("html", ed.sel);
  if (act === "copy-sel-jsx") return copyExport("jsx", ed.sel);
  if (act === "copy-page-html") return copyExport("html", null);
  if (act === "copy-page-jsx") return copyExport("jsx", null);
  if (act === "download-zip") return downloadZip(ed.S?.id, zipFmt);
}
export function openExportMenu(open = exportMenu.hidden) {
  if (open) openProjectMenu(false);
  exportMenu.hidden = !open;
  $("#export-btn").setAttribute("aria-expanded", String(open));
  if (open) window.weft.events.dispatchEvent(new Event("export-menu"));
}
// Hide UI keeps the canvas controls: the HUD button flips to "Show UI".
export function setUiHidden(on = !app.classList.contains("ui-hidden")) {
  app.classList.toggle("ui-hidden", on);
  const b = $("#hud-hide-ui");
  b.textContent = on ? "Show UI" : "Hide UI";
  b.classList.toggle("show-ui-btn", on);
  b.title = on ? "Show UI (Ctrl+\\)" : "Hide UI (Ctrl+\\)";
  setTimeout(updateOverlay);
}
function setZoomMenuOpen(open) {
  $("#zoom-menu").hidden = !open;
  $("#zoom-btn").setAttribute("aria-expanded", String(open));
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  $("#rail").addEventListener("click", (e) => {
    const b = e.target.closest(".tool");
    if (!b) return;
    if (b.dataset.cmd === "undo") return api("POST", "/api/undo");
    if (b.dataset.cmd === "redo") return api("POST", "/api/redo");
    if (b.dataset.cmd === "fit") return zoomCmd("fit");
    if (b.dataset.cmd === "cmdk") return openCmdk(true);
    if (b.dataset.tool) setTool(b.dataset.tool);
  });
  $("#export-btn").addEventListener("click", () => openExportMenu());
  document.addEventListener("pointerdown", (e) => { if (!exportMenu.hidden && !e.target.closest("#export-menu, #export-btn")) openExportMenu(false); });
  $("#layer-filter").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation(); e.preventDefault();
      if (ed.layerFilter) {
        ed.layerFilter = ""; $("#layer-filter").value = "";
        $("#layer-filter-clear").hidden = true; $("#layer-filter-kbd").hidden = false;
        renderLayers();
      }
      $("#layer-filter").blur();
    }
  });
  $("#layer-filter").addEventListener("input", (e) => {
    ed.layerFilter = e.target.value;
    $("#layer-filter-clear").hidden = !ed.layerFilter;
    $("#layer-filter-kbd").hidden = Boolean(ed.layerFilter);
    renderLayers();
  });
  $("#layer-filter-clear").addEventListener("click", () => {
    ed.layerFilter = ""; $("#layer-filter").value = "";
    $("#layer-filter-clear").hidden = true; $("#layer-filter-kbd").hidden = false;
    renderLayers(); $("#layer-filter").focus();
  });
  $("#show-ui").addEventListener("click", () => setUiHidden(false));
  $("#zoom-btn").addEventListener("click", () => setZoomMenuOpen($("#zoom-menu").hidden));
  $("#zoom-menu").addEventListener("click", (e) => { const b = e.target.closest("[data-zoom]"); if (!b) return; setZoomMenuOpen(false); zoomCmd(b.dataset.zoom); });
  document.addEventListener("pointerdown", (e) => { if (!$("#zoom-menu").hidden && !e.target.closest("#zoom-menu, #zoom-btn")) setZoomMenuOpen(false); });
  $("#hud-fit").addEventListener("click", () => zoomCmd("fit"));
  $("#hud-hide-ui").addEventListener("click", () => setUiHidden());
  $("#hide-ui").addEventListener("click", () => setUiHidden(true));
  $("#add-artboard").addEventListener("click", () => {
    const b = worldBounds([...world.children]);
    createNode({ parentId: ed.S.rootId, tag: "section", name: `Frame ${ed.S.nodes[ed.S.rootId].children.length + 1}`,
      styles: { left: b ? Math.round(b.x + b.w + 80) : 0, top: b ? Math.round(b.y) : 0 } });
  });
  window.addEventListener("resize", updateOverlay);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(updateOverlay).observe(stage);
}
