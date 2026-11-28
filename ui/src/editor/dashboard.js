// Dashboard (all projects): its header (search, sort, view), the card menu and dialog, and project thumbnails.
// The grid, recent list and activity feed are ../components/dashboard/*.svelte.
import { ed } from "./state.js";
import { $, api, plural, toast } from "./core.js";
import { buildNodeEl, layerStyleList } from "./render.js";
import { copyText, downloadZip } from "./inspector.js";

export const dashEl = $("#dashboard"), dashContent = $("#dash-content"), dashMenu = $("#dash-menu"), dashModal = $("#dash-modal");
let dashQuery = "", dashSort = "updated", dashView = localStorage.getItem("paper-lite:dash-view") || "grid";
const dashPreviews = new Map();

const applyDashViewSeg = () => document.querySelectorAll("[data-dash-view]").forEach((b) => b.classList.toggle("on", b.dataset.dashView === dashView));

function closeDashMenu() {
  dashMenu.hidden = true;
  dashContent.querySelectorAll('[data-dash-menu][aria-expanded="true"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
}

export function openDashboard(open = dashEl.hidden) {
  dashEl.hidden = !open;
  closeDashMenu();
  if (open) {
    if (location.hash !== "#dashboard") history.replaceState(null, "", "#dashboard");
    renderDashboard();
    api("GET", "/api/activity").then((d) => {
      if (d?.sessions) { ed.activitySessions = d.sessions; if (!dashEl.hidden) renderDashActivity(); }
    });
  } else {
    if (location.hash === "#dashboard") history.replaceState(null, "", location.pathname + location.search);
    closeDashModal();
  }
}

function fitThumb(thumbEl, preview) {
  const worldEl = thumbEl.querySelector(".dash-thumb-world");
  if (!worldEl) return;
  if (!preview?.rootIds?.length) return;
  // Each thumbnail gets its own scoped copy of its project's root CSS and layer styles.
  const scope = thumbEl.dataset.thumbScope || (thumbEl.dataset.thumbScope = `t${Math.random().toString(36).slice(2, 9)}`);
  worldEl.dataset.scope = scope;
  let styleEl = thumbEl.querySelector("style.thumb-css");
  if (!styleEl) { styleEl = document.createElement("style"); styleEl.className = "thumb-css"; thumbEl.prepend(styleEl); }
  styleEl.textContent = WeftRootCss.canvasCss(preview.rootCss || { vars: {}, rules: [] }, layerStyleList(preview.nodes, preview.rootIds), `.dash-thumb-world[data-scope="${scope}"]`);
  worldEl.replaceChildren(...preview.rootIds.map((id) => buildNodeEl(preview.nodes, id)));
  const kids = [...worldEl.children];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of kids) {
    const x = el.offsetLeft, y = el.offsetTop, w = el.offsetWidth || 390, h = el.offsetHeight || 844;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  if (!Number.isFinite(x0)) return;
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const rw = thumbEl.clientWidth || 300, rh = thumbEl.clientHeight || 196;
  const pad = rw < 120 ? 4 : 14;
  const scale = Math.min((rw - pad * 2) / bw, (rh - pad * 2) / bh, 0.5);
  const tx = (rw - bw * scale) / 2 - x0 * scale;
  const ty = (rh - bh * scale) / 2 - y0 * scale;
  worldEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

export async function loadThumb(thumbEl, p) {
  const key = `${p.updatedAt}:${p.bg || ""}`;
  const cached = dashPreviews.get(p.id);
  if (cached?.key === key) return fitThumb(thumbEl, cached.data);
  const data = await api("GET", `/api/projects/${encodeURIComponent(p.id)}/preview`);
  if (!data || dashEl.hidden || !thumbEl.isConnected) return;
  dashPreviews.set(p.id, { key, data });
  fitThumb(thumbEl, data);
}

function sortedProjects() {
  const q = dashQuery.trim().toLowerCase();
  const list = ed.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
  if (dashSort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  else if (dashSort === "layers") list.sort((a, b) => (b.layers || 0) - (a.layers || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  else list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return list;
}

// The dashboard's project grid / list, recent projects and activity feed are ui/src/components/dashboard/*.svelte.
// This keeps the header (counts, search, sort, view), the card menu, the dialog and thumbnail drawing (loadThumb),
// and its delegated click listeners still handle the cards (data-open-project, data-dash-menu, data-act-revert).
export function dashModel() {
  return {
    list: sortedProjects(),
    view: dashView,
    query: dashQuery.trim(),
    recent: [...ed.projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 4),
    sessions: ed.activitySessions,
  };
}
export function renderDashActivity() {
  window.weft.events.dispatchEvent(new Event("dashboard"));
}
export function clearDashSearch() {
  dashQuery = ""; $("#dash-search").value = "";
  $("#dash-search-clear").hidden = true; $("#dash-search-kbd").hidden = false;
  renderDashboard();
}

export function renderDashboard() {
  if (dashEl.hidden) return;
  $("#dash-count").textContent = String(ed.projects.length);
  $("#dash-back-label").textContent = "Back to canvas";
  const totalLayers = ed.projects.reduce((a, p) => a + (p.layers || 0), 0);
  const list = sortedProjects();
  $("#dash-heading").textContent = "All projects";
  $("#dash-summary").textContent = dashQuery.trim()
    ? `${plural(list.length, "matching project")} · ${ed.projects.length} total`
    : `${plural(ed.projects.length, "project")} · ${totalLayers.toLocaleString()} layers`;
  const mcpUrlEl = $("#dash-mcp-url");
  if (mcpUrlEl) mcpUrlEl.textContent = `${location.origin}/mcp`;
  window.weft.events.dispatchEvent(new Event("dashboard"));
}
export function closeDashModal() {
  dashModal.hidden = true;
  ed.dashModalOpts = null;
  window.weft.events.dispatchEvent(new Event("dash-modal"));
}

function openDashModal({ title, message = "", value = "", okText, danger = false, input = true, onOk }) {
  ed.dashModalOpts = { title, message, value, okText, danger, input, onOk };
  dashModal.hidden = false;
  window.weft.events.dispatchEvent(new Event("dash-modal"));
}

export async function openProjectFromDash(id) {
  if (id !== ed.S?.id) await api("POST", `/api/projects/${encodeURIComponent(id)}/open`);
  openDashboard(false);
}

// A card's menu button (../components/dashboard/DashContent.svelte): open the menu (DashMenu.svelte) below it.
export function openDashMenu(pid, btn) {
  if (!ed.projects.some((x) => x.id === pid)) return;
  closeDashMenu();
  btn.setAttribute("aria-expanded", "true");
  dashMenu.dataset.pid = pid;
  window.weft.events.dispatchEvent(new Event("dash-menu")); // DashMenu.svelte
  const r = btn.getBoundingClientRect();
  dashMenu.hidden = false;
  dashMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - 208, r.right - 200))}px`;
  dashMenu.style.top = `${Math.min(window.innerHeight - 200, r.bottom + 4)}px`;
}

// The card menu's items, on the project it was opened for.
export async function dashMenuAction(act) {
  const pid = dashMenu.dataset.pid;
  const p = ed.projects.find((x) => x.id === pid);
  closeDashMenu();
  if (!p) return;
  if (act === "open") return openProjectFromDash(pid);
  if (act === "rename") return openDashModal({
    title: "Rename project",
    value: p.name,
    okText: "Rename",
    onOk: (name) => api("PATCH", `/api/projects/${encodeURIComponent(pid)}`, { name }),
  });
  if (act === "duplicate") {
    const copy = await api("POST", `/api/projects/${encodeURIComponent(pid)}/duplicate`, {});
    if (copy) toast(`Created “${copy.name}”`);
    return;
  }
  if (act === "export-zip") return downloadZip(pid);
  if (act === "delete") return openDashModal({
    title: `Delete ${p.name}?`,
    message: `This permanently removes ${plural(p.pages ?? 1, "page")}, ${plural(p.artboards ?? 0, "artboard")}, and ${(p.layers ?? 0).toLocaleString()} ${p.layers === 1 ? "layer" : "layers"} from disk. This action cannot be undone.`,
    okText: "Delete project",
    danger: true,
    input: false,
    onOk: () => api("DELETE", `/api/projects/${encodeURIComponent(pid)}`),
  });
}

// "Revert session" in the activity feed (DashActivity.svelte).
export async function revertSession(id) {
  const url = `/api/activity/${encodeURIComponent(id)}/revert`;
  // By default only this session's own changes are taken back; anything you or another agent changed since stays.
  const done = (res) => {
    if (!res?.ok) return;
    if (res.mode === "restore") return toast("Restored the project to before the session");
    const kept = res.kept?.length || 0, shared = res.keptShared?.length || 0;
    toast(kept || shared
      ? `Reverted the session. Kept ${plural(kept + shared, "change")} others made afterwards`
      : "Reverted the session's changes");
  };
  const res = await api("POST", url, {}, {
    onError: (status, data) => {
      if (status !== 409 || !data?.needsRestore) return false;
      // Its steps aren't in the undo history any more (restart, or too old): offer the whole-project restore.
      const loses = data.othersEdits ? ` This also discards ${plural(data.othersEdits, "later edit")} by ${data.othersWho.join(", ")}.` : "";
      openDashModal({
        title: "Restore to before this session?",
        message: `${data.error.replace(/ Restore the project.*$/, "")}${loses}`,
        okText: "Restore project",
        danger: true,
        input: false,
        onOk: async () => done(await api("POST", url, { mode: "restore", force: true })),
      });
      return true;
    },
  });
  done(res);
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  applyDashViewSeg();

  $("#dash-btn").addEventListener("click", () => openDashboard(true));
  $("#dash-back").addEventListener("click", () => openDashboard(false));
  $("#dash-search").addEventListener("input", (e) => {
    dashQuery = e.target.value;
    $("#dash-search-clear").hidden = !dashQuery;
    $("#dash-search-kbd").hidden = Boolean(dashQuery);
    renderDashboard();
  });
  $("#dash-search").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation(); e.preventDefault();
      if (dashQuery) { $("#dash-search-clear").click(); }
      else { $("#dash-search").blur(); openDashboard(false); }
    }
  });
  $("#dash-search-clear").addEventListener("click", () => { clearDashSearch(); $("#dash-search").focus(); });
  $("#dash-sort").addEventListener("change", (e) => { dashSort = e.target.value; renderDashboard(); });
  document.querySelectorAll("[data-dash-view]").forEach((b) => b.addEventListener("click", () => {
    dashView = b.dataset.dashView;
    localStorage.setItem("paper-lite:dash-view", dashView);
    applyDashViewSeg();
    renderDashboard();
  }));
  $("#dash-new").addEventListener("click", () => openDashModal({
    title: "New project",
    message: "Creates a clean canvas synced live with MCP.",
    value: "Untitled",
    okText: "Create project",
    onOk: async (name) => {
      const res = await api("POST", "/api/projects", { name });
      if (res) { toast(`Created “${res.name}”`); openDashboard(false); }
    },
  }));

  $("#dash-copy-mcp")?.addEventListener("click", () => {
    copyText(`claude mcp add --transport http weft ${location.origin}/mcp`, "Copied MCP command");
  });
  dashModal.addEventListener("pointerdown", (e) => { if (e.target === dashModal) closeDashModal(); });
  document.addEventListener("pointerdown", (e) => { if (!dashMenu.hidden && !e.target.closest("#dash-menu, [data-dash-menu]")) closeDashMenu(); });
  window.addEventListener("hashchange", () => openDashboard(location.hash === "#dashboard"));
}
