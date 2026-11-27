// Command palette (Ctrl/Cmd+K): opening and closing it, and the entries it lists (layers, pages, projects,
// comments, commands). Its UI is ../components/CommandPalette.svelte.
import { ed } from "./state.js";
import { $, api, app, setSnap, snapInput, toast } from "./core.js";
import { ICONS, commentPinMap, iconFor, pageCommentsList } from "./render.js";
import { copyExport, downloadZip, openPreview, screenOf } from "./inspector.js";
import { select, setTool } from "./selection.js";
import { zoomCmd } from "./view.js";
import { openProjectMenu } from "./projects.js";
import { openDashboard } from "./dashboard.js";
import { openExportMenu, setUiHidden } from "./chrome.js";
import { openCommentThread, openNewComment } from "./comments.js";

// The palette's UI (search, highlighting, keyboard, list) is ui/src/components/CommandPalette.svelte. This script
// builds the entries (buildCmdkEntries, called through window.weft) because they depend on the editor's state.
export const cmdkEl = $("#cmdk");

const CMDK_ICONS = {
  code: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  comment: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3.5h10a1 1 0 011 1v6a1 1 0 01-1 1H7l-3 2.5V11.5H3a1 1 0 01-1-1v-6a1 1 0 011-1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  grid: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 2v12M10.5 2v12M2 5.5h12M2 10.5h12" stroke="currentColor" stroke-width="1.3"/></svg>`,
  zoom: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  panel: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M6 2.5v11" stroke="currentColor" stroke-width="1.4"/></svg>`,
  dash: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" stroke="currentColor" stroke-width="1.4"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="9" width="4.5" height="4.5" rx="1.2" stroke="currentColor" stroke-width="1.4"/></svg>`,
  plus: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  export: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  undo: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 6.5H10a3.5 3.5 0 010 7H7M6.5 4l-2.5 2.5L6.5 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  redo: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.5 6.5H6a3.5 3.5 0 000 7h3M9.5 4l2.5 2.5L9.5 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  page: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 2.5h5.5L12.5 5.5v8a1 1 0 01-1 1H4a1 1 0 01-1-1v-10a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  select: `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 1.5v12.2l3.3-3.1 2.2 4.9 2-.9-2.2-4.8 4.5-.3z"/></svg>`,
  hand: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 8.5V4a1 1 0 012 0v3.5M7 7V2.75a1 1 0 012 0V7M9 7V3.5a1 1 0 012 0V9c0 3-1.8 5-4.3 5C4.6 14 3.5 12.4 2.7 10.6L2 9.2a1 1 0 011.7-1L5 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  rect: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/></svg>`,
};

export function openCmdk(open = cmdkEl.hidden) {
  // Release focus on close so canvas shortcuts (V, F, Delete…) work right away.
  if (!open && cmdkEl.contains(document.activeElement)) document.activeElement.blur();
  cmdkEl.hidden = !open;
  if (open) {
    openExportMenu(false);
    openProjectMenu(false);
    window.weft.events.dispatchEvent(new Event("cmdk-open"));
  }
}

export function buildCmdkEntries() {
  if (!ed.S) return [];
  const entries = [];
  if (ed.sel && ed.S.nodes[ed.sel]) {
    const selName = ed.S.nodes[ed.sel].name;
    entries.push({ group: "Quick actions", icon: CMDK_ICONS.code, label: "Copy HTML + CSS", dim: `· ${selName}`, kbd: "Ctrl C", isKbd: true, search: `copy html css ${selName}`.toLowerCase(), run: () => copyExport("html", ed.sel) });
    entries.push({ group: "Quick actions", icon: CMDK_ICONS.code, label: "Copy JSX", dim: `· ${selName}`, kbd: "", search: `copy jsx ${selName}`.toLowerCase(), run: () => copyExport("jsx", ed.sel) });
    entries.push({ group: "Quick actions", icon: CMDK_ICONS.comment, label: "Comment on", dim: selName, kbd: "C", isKbd: true, search: `comment on ${selName}`.toLowerCase(), run: () => openNewComment(ed.sel) });
  }
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.grid, label: `${snapInput.checked ? "Disable" : "Enable"} 8px snap grid`, kbd: "Shift G", isKbd: true, run: () => { setSnap(!snapInput.checked); toast(snapInput.checked ? "Snap 8px on" : "Snap 8px off"); } });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.zoom, label: "Zoom to fit all artboards", kbd: "Shift 1", isKbd: true, run: () => zoomCmd("fit") });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.zoom, label: "Zoom to 100%", kbd: "Shift 0", isKbd: true, run: () => zoomCmd("100") });
  if (ed.sel && ed.S.nodes[ed.sel]) entries.push({ group: "Quick actions", icon: CMDK_ICONS.zoom, label: "Zoom to selection", kbd: "Shift 2", isKbd: true, run: () => zoomCmd("selection") });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.panel, label: app.classList.contains("ui-hidden") ? "Show studio UI" : "Hide studio UI", kbd: "Ctrl \\", isKbd: true, run: () => setUiHidden() });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.dash, label: "All projects dashboard", kbd: "Ctrl Shift P", isKbd: true, run: () => openDashboard(true) });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.plus, label: "New artboard", kbd: "", run: () => $("#add-artboard").click() });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.plus, label: "New page", kbd: "", run: () => api("POST", "/api/pages", {}) });
  const previewId = ed.sel && ed.S.nodes[ed.sel] && !ed.S.pages.includes(ed.sel) ? screenOf(ed.sel) : ed.S.nodes[ed.S.rootId].children[0];
  if (previewId) entries.push({ group: "Quick actions", icon: CMDK_ICONS.export, label: `Preview “${ed.S.nodes[previewId].name}” in a new tab`, kbd: ed.sel ? "P" : "", isKbd: Boolean(ed.sel), run: () => openPreview(previewId) });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.export, label: "Export project (.zip)", kbd: "", run: () => downloadZip(ed.S.id, "html") });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.undo, label: "Undo", kbd: "Ctrl Z", isKbd: true, run: () => api("POST", "/api/undo") });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.redo, label: "Redo", kbd: "Ctrl Shift Z", isKbd: true, run: () => api("POST", "/api/redo") });

  const pinMap = commentPinMap();
  const openComments = pageCommentsList().filter((x) => x.status !== "resolved" && !x.deletedInStep && ed.S.nodes[x.nodeId]);
  openComments.forEach((c) => {
    const nm = ed.S.nodes[c.nodeId]?.name || c.layerName || "Deleted layer";
    const txt = c.messages?.[0]?.text || "";
    const statusLabel = c.status === "replied" ? "Claude replied" : c.status === "read" ? "Read" : "Open";
    entries.push({
      group: "Comments",
      pinNum: pinMap.get(c.id) || "",
      label: nm,
      dim: txt ? `· “${txt.slice(0, 42)}${txt.length > 42 ? "…" : ""}”` : "",
      kbd: statusLabel,
      isAgentReply: c.status === "replied",
      search: `comment ${nm} ${txt} ${statusLabel}`.toLowerCase(),
      run: () => openCommentThread(c.id),
    });
  });

  const toolIcons = { select: CMDK_ICONS.select, hand: CMDK_ICONS.hand, frame: ICONS.frame, rect: CMDK_ICONS.rect, text: ICONS.text, comment: CMDK_ICONS.comment };
  for (const [label, t, kbd] of [["Tool: Select", "select", "V"], ["Tool: Hand", "hand", "H"], ["Tool: Frame", "frame", "F"], ["Tool: Rectangle", "rect", "R"], ["Tool: Text", "text", "T"], ["Tool: Comment", "comment", "C"]]) {
    entries.push({ group: "Tools", icon: toolIcons[t], label, kbd: ed.tool === t ? `Active · ${kbd}` : kbd, isKbd: ed.tool !== t, run: () => setTool(t) });
  }

  for (const pid of ed.S.pages) {
    const p = ed.S.nodes[pid];
    if (!p) continue;
    entries.push({
      group: "Pages", icon: CMDK_ICONS.page, label: p.name, kbd: pid === ed.S.rootId ? "Current page" : "Switch page",
      run: () => { if (pid !== ed.S.rootId) api("POST", `/api/pages/${encodeURIComponent(pid)}/open`); },
    });
  }

  // Collect all layers & artboards on current page, then filter & slice for results
  const agentIds = new Set(ed.agentNodes.map((a) => a.id));
  const curPageNum = String(Math.max(0, ed.S.pages.indexOf(ed.S.rootId)) + 1).padStart(2, "0");
  const visit = (id, abName) => {
    const n = ed.S.nodes[id];
    if (!n) return;
    const isAb = n.parentId === ed.S.rootId;
    const trail = isAb ? `${curPageNum} · Artboard` : `${curPageNum} · ${abName} · ${n.tag}`;
    entries.push({
      group: "Layers & artboards",
      icon: iconFor(n),
      label: n.name,
      kbd: trail,
      mcp: agentIds.has(id),
      search: `${n.name} ${n.tag} ${abName} ${n.text || ""}`.toLowerCase(),
      run: () => { if (ed.S?.nodes[id]) { select(id); requestAnimationFrame(() => zoomCmd("selection")); } },
    });
    for (const c of n.children || []) visit(c, isAb ? n.name : abName);
  };
  for (const ab of ed.S.nodes[ed.S.rootId].children) visit(ab, ed.S.nodes[ab]?.name || "");

  for (const pr of ed.projects) {
    entries.push({
      group: "Projects", icon: CMDK_ICONS.dash, label: pr.name, kbd: pr.id === ed.S.id ? "Open" : "Open project",
      run: () => { if (pr.id !== ed.S.id) api("POST", `/api/projects/${encodeURIComponent(pr.id)}/open`); },
    });
  }
  return entries;
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  cmdkEl.addEventListener("pointerdown", (e) => { if (e.target === cmdkEl) openCmdk(false); });
  $("#hud-cmdk").addEventListener("click", () => openCmdk(true));
  $("#stage-pill").addEventListener("click", () => openCmdk(true));
}
