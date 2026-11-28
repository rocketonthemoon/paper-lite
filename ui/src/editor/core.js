// Shared basics: tag sets, DOM handles and helpers ($, px, num, elOf…), formatting (clock, ago, plural), the
// server API wrapper (api, patch) with its error toasts, and the snap-to-grid toggle.
import { ed } from "./state.js";

const CLIENT = Math.random().toString(36).slice(2);
export const GRID = 8;
export const TEXT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "strong", "em", "small", "label", "a", "button", "li", "figcaption"]);
export const VOID_TAGS = new Set(["img", "hr", "br"]);
export const SVG_TAGS = new Set(["svg", "g", "path", "circle", "rect", "ellipse", "line", "polyline", "polygon"]);
export const SVG_NS = "http://www.w3.org/2000/svg";
export const TAGS = ["div", "section", "header", "footer", "nav", "main", "article", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span",
  "strong", "em", "small", "label", "a", "button", "img", "ul", "ol", "li", "figure", "figcaption", "hr", "br",
  "svg", "g", "path", "circle", "rect", "ellipse", "line", "polyline", "polygon"];
export const GENERIC_FONTS = ["system-ui", "sans-serif", "serif", "monospace", "inherit"];
export const viewKey = () => (ed.S ? `paper-lite:view:${ed.S.id}:${ed.S.rootId}` : null);
export const expanded = new Set(JSON.parse(localStorage.getItem("paper-lite:expanded") || "[]"));
export const saveExpanded = () => localStorage.setItem("paper-lite:expanded", JSON.stringify([...expanded].slice(-400)));
export { clock, stamp, fullStamp } from "./time.js";

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export const $ = (s, r = document) => r.querySelector(s);
export const app = $("#app"), stage = $("#stage"), world = $("#world"),
  inspector = $("#inspector"), rightHead = $("#right-head"), inspectorFoot = $("#inspector-foot"),
  commentsPanelEl = $("#comments-panel"), commentThreadEl = $("#comment-thread");
export const px = (v) => (v == null ? "" : String(v).replace(/^(-?[\d.]+)px$/, "$1"));
export const num = (v, fallback = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; };
export const elOf = (id) => world.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
// Everything selected: the multi-selection, else the single selected layer.
export const selectedIds = () => (ed.multi.length ? ed.multi : ed.sel ? [ed.sel] : []);
// Without layers inside other selected layers (moving or deleting a parent already takes its children along).
export const topmostSelected = () => {
  const ids = selectedIds(), set = new Set(ids);
  return ids.filter((id) => { for (let p = ed.S.nodes[id]?.parentId; p; p = ed.S.nodes[p]?.parentId) if (set.has(p)) return false; return true; });
};
// The .is-selected class (outline, and what interact.js drags) on exactly the selected layers' elements.
export function markSelected() {
  const ids = new Set(selectedIds());
  for (const el of world.querySelectorAll(".is-selected")) if (!ids.has(el.dataset.nodeId)) el.classList.remove("is-selected");
  for (const id of ids) elOf(id)?.classList.add("is-selected");
}
export const isArtboard = (id) => ed.S && ed.S.nodes[id] && ed.S.nodes[id].parentId === ed.S.rootId;
export const isTextNode = (id) => { const n = ed.S.nodes[id]; return n && !n.children.length && !VOID_TAGS.has(n.tag) && !SVG_TAGS.has(n.tag) && (n.text !== "" || TEXT_TAGS.has(n.tag)); };
export const isDarkColor = (c) => {
  const m = /^#?([0-9a-f]{6})$/i.exec((c || "").trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum < 0.45;
};
export function toast(msg, { agent = false, action = null, onAction = null, ms = 1600 } = {}) {
  const t = $("#toast");
  ed.toastNow = { msg: String(msg), agent, action, onAction };
  window.weft?.events.dispatchEvent(new Event("toast")); // before window.weft exists, main.js replays it
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), action ? Math.max(ms, 5000) : ms);
}

// `onError(status, data)`: handle an error response yourself (return true) instead of the default toast.
export async function api(method, url, body, { onError } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", "x-client-id": CLIENT },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    if (!res.ok && onError?.(res.status, data)) return null;
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } catch (err) {
    toast(err.message);
    return null;
  }
}
export const patch = (id, body) => api("PATCH", `/api/nodes/${encodeURIComponent(id)}`, body);
export const patchStyles = (id, styles) => patch(id, { styles });

// Snap state synced with Floating HUD button
export const snapInput = $("#snap"), snapBtn = $("#snap-btn");
export function setSnap(on) {
  snapInput.checked = Boolean(on);
  snapBtn.classList.toggle("snap-on", snapInput.checked);
  snapBtn.setAttribute("aria-pressed", String(snapInput.checked));
  app.classList.toggle("grid-on", snapInput.checked);
  localStorage.setItem("paper-lite:snap", snapInput.checked ? "1" : "0");
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  setSnap(localStorage.getItem("paper-lite:snap") === "1");
  snapBtn.addEventListener("click", () => { setSnap(!snapInput.checked); toast(snapInput.checked ? "Snap 8px on" : "Snap 8px off"); });
}
