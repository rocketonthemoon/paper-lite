// Live sync and the right panel: the SSE connection (state patches, history, projects, presence, comments,
// fonts, focus), the right panel tabs, and window.weft, the bridge the Svelte components read.
import { ed } from "./state.js";
import { $, GENERIC_FONTS, SVG_TAGS, TAGS, TEXT_TAGS, VOID_TAGS, ago, api, clock, commentsPanelEl, elOf, expanded, inspector, num, plural, px, rightHead, toast, viewKey, world } from "./core.js";
import { applyView, baseStylesOf, kebabCss, layerRows, render, renderLayers, resolveVars, rootOf, rulesUsing, updateOverlay } from "./render.js";
import { classableStyles, copyText, ctxAction, downloadZip, hex6, inspectorAction, inspectorChange, inspectorFocusout, inspectorInput, inspectorKeydown, inspectorModel, renderInspector, renderRightHead, rightHeadModel } from "./inspector.js";
import { createNode, select, shareSelection } from "./selection.js";
import { fitTo, worldBounds } from "./view.js";
import { labelPointerDown } from "./pointer.js";
import { canNestIn, dropLayer, hoverLayer, renameLayer, renameRow, toggleExpanded } from "./layers.js";
import { fontStack, renderFontList } from "./fonts.js";
import { pagesModel } from "./pages.js";
import { openProjectMenu, projectMenuModel } from "./projects.js";
import { buildCmdkEntries, openCmdk } from "./cmdk.js";
import { clearDashSearch, closeDashModal, dashEl, dashMenuAction, dashModel, loadThumb, openDashMenu, openDashboard, openProjectFromDash, renderDashActivity, renderDashboard, revertSession } from "./dashboard.js";
import { exportAction, exportMenuModel, openExportMenu } from "./chrome.js";
import { closeCommentThread, commentPins, commentRows, commentThread, focusAgentNode, openCommentThread, renderCommentPins, renderCommentThread, renderCommentsPanel, submitComment, updateCommentsBadge } from "./comments.js";

let hist = { entries: [], cursor: -1, limit: 60, checkpoints: [] };
const historyEl = $("#history-panel");
function renderHistory() {
  window.weft.history = hist;
  window.weft.events.dispatchEvent(new Event("history"));
}

export function setRightTab(tab) {
  if (!$(`#right-tabs [data-tab="${tab}"]`)) tab = "design";
  ed.rightTab = tab;
  localStorage.setItem("weft:right-tab", tab);
  for (const b of $("#right-tabs").children) {
    b.classList.toggle("on", b.dataset.tab === tab);
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  }
  const design = tab === "design";
  rightHead.hidden = !design;
  inspector.hidden = !design;
  historyEl.hidden = tab !== "history";
  if (design) renderInspector(true);
  if (tab === "history") renderHistory();
  ed.renderRightPanels?.();
}

export function connect() {
  const es = new EventSource("/events");
  const live = $("#live");
  es.addEventListener("open", () => { live.classList.add("live"); $("#live-text").textContent = "Live · synced"; if (ed.S) shareSelection(); });
  es.addEventListener("error", () => { live.classList.remove("live"); $("#live-text").textContent = "Reconnecting…"; });
  // Events that change S are applied one at a time, so a resync (below) can't interleave with a patch.
  let syncChain = Promise.resolve();
  const serially = (fn) => { syncChain = syncChain.then(fn).catch((err) => console.error("[weft] sync", err)); };
  es.addEventListener("state", (ev) => serially(() => { const { source, state } = JSON.parse(ev.data); applyState(source, state); }));
  // Edits arrive as patches of changed nodes on top of a known version. If this tab missed one (or is on another
  // project), it reloads the whole document instead.
  es.addEventListener("patch", (ev) => serially(async () => {
    const p = JSON.parse(ev.data);
    if (!ed.S || ed.S.id !== p.id || ed.S.version !== p.baseVersion) {
      if (ed.S && ed.S.id === p.id && p.version <= ed.S.version) return; // already have this (e.g. after a resync)
      const full = await api("GET", "/api/state");
      if (full) applyState(p.source, full);
      return;
    }
    for (const [id, n] of Object.entries(p.nodes)) {
      if (n) ed.S.nodes[id] = n;
      else delete ed.S.nodes[id];
    }
    applyState(p.source, { ...ed.S, version: p.version, name: p.name, pages: p.pages, rootId: p.rootId, rootCss: p.rootCss || ed.S.rootCss });
  }));
  function applyState(source, state) {
    const prevProject = ed.S?.id, prevKey = viewKey();
    ed.S = state;
    if (!dashEl.hidden) $("#dash-back-label").textContent = "Back to canvas";
    if (source === "mcp") toast("Updated by agent (MCP)");
    if (viewKey() === prevKey) return render();
    if (prevProject && prevProject !== ed.S.id) expanded.clear();
    ed.sel = null; ed.hoverId = null; ed.pendingSel = ed.pendingSel && ed.S.nodes[ed.pendingSel] ? ed.pendingSel : null;
    const saved = localStorage.getItem(viewKey());
    if (saved) ed.view = JSON.parse(saved);
    applyView();
    render();
    if (!saved) requestAnimationFrame(() => { const b = worldBounds([...world.children]); if (b) fitTo(b, 1); });
    shareSelection();
  }
  es.addEventListener("history", (ev) => {
    hist = JSON.parse(ev.data);
    renderHistory();
  });
  es.addEventListener("projects", (ev) => {
    ed.projects = JSON.parse(ev.data).projects || [];
    window.weft.events.dispatchEvent(new Event("projects"));
    if (!dashEl.hidden) renderDashboard();
  });
  es.addEventListener("activity", (ev) => {
    ed.activitySessions = JSON.parse(ev.data).sessions || [];
    if (!dashEl.hidden) renderDashActivity();
  });
  es.addEventListener("fonts", (ev) => {
    const { fonts, v } = JSON.parse(ev.data);
    ed.fontLib = fonts || [];
    renderFontList();
    if (v) { $("#fonts-css").href = `/fonts.css?v=${v}`; document.fonts?.ready.then(updateOverlay); }
    if (ed.S && !ed.sel) renderInspector();
  });
  es.addEventListener("presence", (ev) => {
    const data = JSON.parse(ev.data);
    ed.agentNodes = data.nodes || [];
    ed.agentCursors = data.agents || [];
    const st = $("#agent-status");
    st.textContent = ed.agentNodes.length ? `MCP · ${ed.agentNodes.length}` : "MCP · ready";
    st.classList.toggle("on", ed.agentNodes.length > 0);
    const chip = $("#top-agent-chip");
    if (chip) {
      chip.hidden = ed.agentNodes.length === 0;
      if (ed.agentNodes.length) chip.textContent = `Agent editing ${plural(ed.agentNodes.length, "layer")}`;
    }
    renderLayers();
    if (ed.S) renderRightHead();
    if (!commentsPanelEl.hidden) renderCommentsPanel();
    updateOverlay();
    if (ed.followAgent && ed.agentNodes.length && ed.S) {
      const now = Date.now();
      if (now - ed.followTimer > 600) {
        ed.followTimer = now;
        const els = ed.agentNodes.map((a) => elOf(a.id)).filter(Boolean);
        if (els.length) requestAnimationFrame(() => fitTo(worldBounds(els), 2));
      }
    }
  });
  es.addEventListener("comments", (ev) => {
    const data = JSON.parse(ev.data);
    ed.comments = data.comments || [];
    updateCommentsBadge();
    renderLayers();
    renderCommentPins();
    if (!commentsPanelEl.hidden) renderCommentsPanel();
    if (ed.activeThreadId) renderCommentThread();
    if (data.replyNotification) {
      const rn = data.replyNotification;
      toast(`${rn.author || "Claude"} replied to your comment`, {
        agent: true,
        action: "View",
        onAction: () => openCommentThread(rn.commentId),
      });
    }
  });
  es.addEventListener("focus", (ev) => {
    const { ids, zoom } = JSON.parse(ev.data);
    if (!ed.S) return;
    if (!ids || !ids.length) { ed.pendingSel = null; ed.sel = null; render(); return; }
    const id = ids[0];
    if (!id || !ed.S.nodes[id]) return;
    ed.pendingSel = id;
    render();
    if (zoom) requestAnimationFrame(() => fitTo(worldBounds(ids.map(elOf).filter(Boolean)), 2));
    toast("Agent selected a layer");
  });
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  // Bridge to the Svelte components in ui/src (loaded after this script): helpers they call and live data they
  // render. renderHistory() hands the latest history to the Svelte History panel (ui/src/components/HistoryPanel).
  window.weft = {
    api, toast, clock, history: hist, events: new EventTarget(),
    // Command palette (CommandPalette.svelte)
    cmdkEntries: () => buildCmdkEntries(),
    closeCmdk: () => openCmdk(false),
    // Inspector (inspector/*.svelte): its data and the helpers its templates use
    inspectorModel: () => inspectorModel(),
    h: { px, num, hex6, resolveVars, baseStylesOf, rulesUsing, kebabCss, fontStack, classableStyles, TAGS, TEXT_TAGS, VOID_TAGS, SVG_TAGS },
    // Inspector header (RightHead.svelte)
    rightHeadModel: () => rightHeadModel(),
    // Project menu (ProjectMenu.svelte)
    projectMenu: () => projectMenuModel(),
    closeProjectMenu: () => openProjectMenu(false),
    openDashboard: () => openDashboard(true),
    downloadZip: (id) => downloadZip(id),
    // Dashboard (dashboard/*.svelte)
    dashboard: () => dashModel(),
    loadThumb: (el, p) => loadThumb(el, p),
    clearDashSearch: () => clearDashSearch(),
    ago: (iso) => ago(iso),
    plural: (n, word) => plural(n, word),
    // Pages (PagesList.svelte)
    pages: () => pagesModel(),
    // Layers tree (LayersPanel.svelte)
    layerRows: () => layerRows(),
    select: (id) => select(id),
    toggleExpanded: (id) => toggleExpanded(id),
    hoverLayer: (id) => hoverLayer(id),
    renameLayer: (id, name) => renameLayer(id, name),
    canNestIn: (dragId, targetId) => canNestIn(dragId, targetId),
    dropLayer: (id, targetId, zone) => dropLayer(id, targetId, zone),
    // Comments tab (CommentsPanel.svelte)
    commentRows: () => commentRows(),
    openCommentThread: (id) => openCommentThread(id),
    get showResolvedPins() { return ed.showResolvedPins; },
    set showResolvedPins(on) { ed.showResolvedPins = Boolean(on); renderCommentPins(); },
    // Pins and thread popover on the canvas (comments/*.svelte)
    commentPins: () => commentPins(),
    commentThread: () => commentThread(),
    submitComment: (text, agentsCanSee) => submitComment(text, agentsCanSee),
    closeCommentThread: () => closeCommentThread(),
    // Canvas overlay and breadcrumb (canvas/*.svelte), measured by updateOverlay()
    // Export menu (ExportMenu.svelte) and font suggestions (FontList.svelte)
    exportMenu: () => exportMenuModel(),
    closeExportMenu: () => openExportMenu(false),
    exportAction: (act, zipFmt) => exportAction(act, zipFmt),
    fontFamilies: () => [...new Set([...ed.fontLib.map((f) => f.family), ...GENERIC_FONTS])],
    // Toast (Toast.svelte), CSS variable suggestions (RootVars.svelte)
    toastModel: () => ed.toastNow,
    toastAction: () => { $("#toast").classList.remove("show"); ed.toastNow?.onAction?.(); },
    rootVarNames: () => (ed.S ? Object.keys(rootOf().vars) : []),
    // Dashboard dialog and card menu (dashboard/DashDialog.svelte, DashMenu.svelte)
    dashModal: () => ed.dashModalOpts,
    closeDashModal: () => closeDashModal(),
    dashMenuModel: () => ({ onlyProject: ed.projects.length < 2 }),
    overlay: { labels: [], ctx: null, agents: { boxes: [], cursors: [] }, crumbs: { page: "Page 1", artboard: "" } },
    ctxAction: (act) => ctxAction(act),
    // Inspector and its header (inspector/Inspector.svelte, RightHead.svelte): field events and data-action buttons
    inspectorInput: (e) => inspectorInput(e),
    inspectorChange: (e) => inspectorChange(e),
    inspectorKeydown: (e) => inspectorKeydown(e),
    inspectorFocusout: () => inspectorFocusout(),
    inspectorAction: (button) => inspectorAction(button),
    openProject: (id) => openProjectFromDash(id),
    openDashMenu: (pid, btn) => openDashMenu(pid, btn),
    dashMenuAction: (act) => dashMenuAction(act),
    revertSession: (id) => revertSession(id),
    focusAgentNode: (id) => focusAgentNode(id),
    labelPointerDown: (e, id) => labelPointerDown(e, id),
    renameRow: (id) => renameRow(id),
  };
  $("#right-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setRightTab(b.dataset.tab); });

  $("#empty-onboarding")?.addEventListener("click", (e) => {
    const preset = e.target.closest("[data-onb-preset]")?.dataset.onbPreset;
    if (preset === "desktop") {
      return createNode({ parentId: ed.S.rootId, tag: "section", name: "Desktop · 1440×900", styles: { left: 0, top: 0, width: 1440, height: 900, backgroundColor: "#ffffff" } });
    }
    if (preset === "mobile") {
      return createNode({ parentId: ed.S.rootId, tag: "section", name: "Mobile · 390×844", styles: { left: 0, top: 0, width: 390, height: 844, backgroundColor: "#ffffff" } });
    }
    if (e.target.closest("#onb-copy-mcp")) {
      return copyText(`claude mcp add --transport http weft ${location.origin}/mcp`, "Copied MCP command");
    }
  });
}
