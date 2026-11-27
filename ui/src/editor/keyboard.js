// Keyboard shortcuts for the canvas (tools, nudging, undo / redo, zoom, copy / paste, …).
import { ed } from "./state.js";
import { $, api, commentThreadEl, isTextNode, num, patchStyles, setSnap, snapInput, stage, toast } from "./core.js";
import { copyExport, openPreview, toggleFlex } from "./inspector.js";
import { duplicateSelected, removeSelected, select, setTool, startEdit } from "./selection.js";
import { zoomCmd } from "./view.js";
import { openProjectMenu, projectMenu } from "./projects.js";
import { cmdkEl, openCmdk } from "./cmdk.js";
import { closeDashModal, dashEl, dashModal, openDashboard } from "./dashboard.js";
import { exportMenu, openExportMenu, setUiHidden } from "./chrome.js";
import { closeCommentThread } from "./comments.js";

const typing = (e) => e.target.matches?.("input, textarea, select") || e.target.isContentEditable;

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "k") {
      e.preventDefault();
      if (!dashEl.hidden) { $("#dash-search").focus(); $("#dash-search").select(); return; }
      return openCmdk();
    }
    if (mod && e.shiftKey && k === "p") { e.preventDefault(); return openDashboard(); }
    if (!cmdkEl.hidden) { if (e.key === "Escape") openCmdk(false); return; }
    if (!exportMenu.hidden && e.key === "Escape") { e.preventDefault(); return openExportMenu(false); }
    if (!projectMenu.hidden && e.key === "Escape") { e.preventDefault(); return openProjectMenu(false); }
    if (mod && k === "f" && dashEl.hidden) { e.preventDefault(); $("#layer-filter").focus(); $("#layer-filter").select(); return; }
    if (typing(e)) return;
    if (!dashModal.hidden) { if (e.key === "Escape") closeDashModal(); return; }
    if (!dashEl.hidden) { if (e.key === "Escape") openDashboard(false); return; }
    if (e.code === "Space" || e.key === " ") { e.preventDefault(); if (!ed.spaceDown) { ed.spaceDown = true; stage.classList.add("pan-ready"); } return; }
    if (mod && k === "z") { e.preventDefault(); return api("POST", e.shiftKey ? "/api/redo" : "/api/undo"); }
    if (mod && k === "y") { e.preventDefault(); return api("POST", "/api/redo"); }
    if (mod && k === "d") { e.preventDefault(); return duplicateSelected(); }
    if (mod && k === "c") { if (getSelection().toString()) return; e.preventDefault(); return copyExport("html", ed.sel); }
    if (mod && (k === "=" || k === "+")) { e.preventDefault(); return zoomCmd("in"); }
    if (mod && k === "-") { e.preventDefault(); return zoomCmd("out"); }
    if (mod && k === "0") { e.preventDefault(); return zoomCmd("100"); }
    if (mod && e.key === "\\") { e.preventDefault(); return setUiHidden(); }
    if (mod || e.altKey) return;
    if (e.shiftKey && (e.code === "Digit1" || e.key === "!")) return zoomCmd("fit");
    if (e.shiftKey && (e.code === "Digit2" || e.key === "@" || e.key === '"')) return zoomCmd("selection");
    if (e.shiftKey && (e.code === "Digit0" || e.key === ")" || e.key === "=")) return zoomCmd("100");
    if (e.shiftKey && k === "g") { setSnap(!snapInput.checked); toast(snapInput.checked ? "Snap 8px on" : "Snap 8px off"); return; }
    if (e.shiftKey && k === "a" && ed.sel) return toggleFlex(ed.sel);
    if (!commentThreadEl.hidden && k === "escape") { e.preventDefault(); return closeCommentThread(); }
    const tools = { v: "select", h: "hand", f: "frame", r: "rect", t: "text", c: "comment" };
    if (!e.shiftKey && tools[k]) return setTool(tools[k]);
    if (!ed.sel) return;
    if (!e.shiftKey && k === "p") return openPreview(ed.sel);
    const n = ed.S.nodes[ed.sel];
    if (k === "delete" || k === "backspace") { e.preventDefault(); return removeSelected(); }
    if (k === "escape" || (k === "enter" && e.shiftKey)) return select(n.parentId === ed.S.rootId ? null : n.parentId);
    if (k === "enter") { e.preventDefault(); if (isTextNode(ed.sel)) return startEdit(ed.sel); if (n.children[0]) select(n.children[0]); return; }
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (arrows[k] && n.styles.position === "absolute") {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      patchStyles(ed.sel, { left: num(n.styles.left) + arrows[k][0] * step, top: num(n.styles.top) + arrows[k][1] * step });
    }
  });
  document.addEventListener("keyup", (e) => { if (e.code === "Space" || e.key === " ") { ed.spaceDown = false; stage.classList.remove("pan-ready"); } });
  window.addEventListener("blur", () => { ed.spaceDown = false; stage.classList.remove("pan-ready"); });
}
