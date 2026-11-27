// The editor: canvas rendering (keyed DOM sync of the design tree), pan and zoom, drawing, drag and resize,
// keyboard shortcuts, and the live connection to the server (SSE). Panels and menus are Svelte components in
// ../components; this module runs first (see ../main.js), owns the editor state, and hands the components their data
// through window.weft (../lib/bridge.svelte.js).
// interact.js (drag and resize) and WeftRootCss (/root-css.js, shared with the server) are classic scripts on the page.
"use strict";
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const CLIENT = Math.random().toString(36).slice(2);
const GRID = 8;
const TEXT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "strong", "em", "small", "label", "a", "button", "li", "figcaption"]);
const VOID_TAGS = new Set(["img", "hr", "br"]);
const SVG_TAGS = new Set(["svg", "g", "path", "circle", "rect", "ellipse", "line", "polyline", "polygon"]);
const SVG_NS = "http://www.w3.org/2000/svg";
const TAGS = ["div", "section", "header", "footer", "nav", "main", "article", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span",
  "strong", "em", "small", "label", "a", "button", "img", "ul", "ol", "li", "figure", "figcaption", "hr", "br",
  "svg", "g", "path", "circle", "rect", "ellipse", "line", "polyline", "polygon"];

let S = null;                 // canvas state from server
let sel = null;               // selected node id
let hoverId = null;
let tool = "select", toolEpoch = 0; // toolEpoch counts tool picks, so a late reply can tell it was overtaken
let view = { x: 120, y: 120, z: 1 };
let projects = [];            // [{ id, name, updatedAt, active }]
let fontLib = [];             // font library entries from the server
const GENERIC_FONTS = ["system-ui", "sans-serif", "serif", "monospace", "inherit"];
const viewKey = () => (S ? `paper-lite:view:${S.id}:${S.rootId}` : null);
const expanded = new Set(JSON.parse(localStorage.getItem("paper-lite:expanded") || "[]"));
const saveExpanded = () => localStorage.setItem("paper-lite:expanded", JSON.stringify([...expanded].slice(-400)));
let editingId = null, editOriginal = "", pendingEdit = null, pendingSel = null;
let selEpoch = 0;             // bumps on every explicit select(); async results only auto-select if it hasn't moved
let busy = false, pendingRender = false; // drag/resize in progress
// True while the mouse button is held on the canvas. Re-rendering then would swap out the element a gesture is acting
// on (interact.js grabs it on pointerdown, before busy is set), so live updates wait until release.
let pointerHeld = false;
let spaceDown = false;
let inspectorDirty = false;
let cssJsonOpen = false;      // UX #03: collapsed raw CSS JSON by default
let comments = [];            // thread comments synced via SSE
let agentNodes = [];          // [{ id, label }] nodes an MCP agent is working on
let agentCursors = [];        // live MCP agent cursors
let followAgent = localStorage.getItem("weft:follow-agent") === "1";
let followTimer = 0;
let activeThreadId = null, draftCommentNodeId = null, showResolvedPins = false;
let activitySessions = [];    // dashboard activity sessions
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }); };

const $ = (s, r = document) => r.querySelector(s);
const app = $("#app"), stage = $("#stage"), world = $("#world"),
  inspector = $("#inspector"), rightHead = $("#right-head"), inspectorFoot = $("#inspector-foot"),
  commentsPanelEl = $("#comments-panel"), commentThreadEl = $("#comment-thread");
const px = (v) => (v == null ? "" : String(v).replace(/^(-?[\d.]+)px$/, "$1"));
const num = (v, fallback = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; };
const elOf = (id) => world.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
const isArtboard = (id) => S && S.nodes[id] && S.nodes[id].parentId === S.rootId;
const isTextNode = (id) => { const n = S.nodes[id]; return n && !n.children.length && !VOID_TAGS.has(n.tag) && !SVG_TAGS.has(n.tag) && (n.text !== "" || TEXT_TAGS.has(n.tag)); };
const isDarkColor = (c) => {
  const m = /^#?([0-9a-f]{6})$/i.exec((c || "").trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum < 0.45;
};

// The toast's contents are ui/src/components/Toast.svelte; this shows and hides it.
let toastNow = null;
function toast(msg, { agent = false, action = null, onAction = null, ms = 1600 } = {}) {
  const t = $("#toast");
  toastNow = { msg: String(msg), agent, action, onAction };
  window.weft?.events.dispatchEvent(new Event("toast")); // before window.weft exists, main.js replays it
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), action ? Math.max(ms, 5000) : ms);
}

async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", "x-client-id": CLIENT },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } catch (err) {
    toast(err.message);
    return null;
  }
}
const patch = (id, body) => api("PATCH", `/api/nodes/${encodeURIComponent(id)}`, body);
const patchStyles = (id, styles) => patch(id, { styles });

// Snap state synced with Floating HUD button
const snapInput = $("#snap"), snapBtn = $("#snap-btn");
function setSnap(on) {
  snapInput.checked = Boolean(on);
  snapBtn.classList.toggle("snap-on", snapInput.checked);
  snapBtn.setAttribute("aria-pressed", String(snapInput.checked));
  app.classList.toggle("grid-on", snapInput.checked);
  localStorage.setItem("paper-lite:snap", snapInput.checked ? "1" : "0");
}
setSnap(localStorage.getItem("paper-lite:snap") === "1");
snapBtn.addEventListener("click", () => { setSnap(!snapInput.checked); toast(snapInput.checked ? "Snap 8px on" : "Snap 8px off"); });

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
// Root CSS: one project-wide stylesheet (variables, classes, states, @media, nesting), parsed and serialised by
// /root-css.js exactly like on the server. The canvas renders it as a real stylesheet scoped to the world, with each
// layer's own styles as a rule between the base classes and the state / media / nested rules, the same cascade as
// the exported styles.css. Layer classes are prefixed (wc-card) so they can't pick up the editor's own CSS.
const rootOf = () => S?.rootCss || { vars: {}, rules: [] };
const definedClassList = () => WeftRootCss.definedClasses(rootOf());
const baseStylesOf = (name) => Object.assign({}, ...rootOf().rules.filter((r) => !r.media && r.selector === `.${name}`).map((r) => r.styles));
const rulesUsing = (name) => rootOf().rules.filter((r) => WeftRootCss.classesIn(r.selector).includes(name) && !(WeftRootCss.isBase(r) && r.selector === `.${name}`));
// The inspector sits outside the canvas, so swatches resolve var(--x) themselves.
const resolveVars = (v, depth = 0) => (depth > 8 ? String(v ?? "") : String(v ?? "").replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g,
  (m, name, fb) => (name in rootOf().vars ? resolveVars(rootOf().vars[name], depth + 1) : fb?.trim() || m)));
const kebabCss = (k) => WeftRootCss.kebab(k);
const classUsage = (name) => Object.values(S?.nodes || {}).filter((n) => n.classes?.includes(name)).length;

function scopedSheet(key) {
  let el = document.getElementById(key);
  if (!el) { el = document.createElement("style"); el.id = key; document.head.append(el); }
  return el;
}
// Layers under the given roots, as [id, own styles] for the canvas stylesheet.
function layerStyleList(nodes, rootIds) {
  const out = [];
  const walk = (id) => { const n = nodes[id]; if (!n) return; out.push([id, n.styles]); (n.children || []).forEach(walk); };
  rootIds.forEach(walk);
  return out;
}

// Styles come from the canvas stylesheet (see renderCanvasCss); elements only carry their id and classes.
function buildNodeEl(nodes, id) {
  const n = nodes[id];
  if (!n) return document.createElement("div");
  const svg = SVG_TAGS.has(n.tag);
  const el = svg ? document.createElementNS(SVG_NS, n.tag) : document.createElement(n.tag);
  el.dataset.nodeId = id;
  for (const c of n.classes || []) el.classList.add(`${WeftRootCss.CANVAS_PREFIX}${c}`);
  if (svg) { for (const [k, v] of Object.entries(n.attrs || {})) el.setAttribute(k, v); (n.children || []).forEach((c) => el.append(buildNodeEl(nodes, c))); return el; }
  for (const [k, v] of Object.entries(n.attrs || {})) el.setAttribute(k, v);
  if (n.tag === "button") el.type = "button";
  if (n.tag === "a" || n.tag === "button") el.tabIndex = -1;
  if (n.tag === "img") el.draggable = false;
  if (VOID_TAGS.has(n.tag)) return el;
  if (n.text) el.append(n.text);
  for (const c of n.children || []) el.append(buildNodeEl(nodes, c));
  return el;
}

// The canvas keeps its elements between renders and rebuilds an element only when its node changed. Patches from
// the server replace just the changed node objects in S.nodes, so "changed" is an identity check: builtFrom maps
// each canvas element to the node object it was built from. Code that changes a canvas element directly (text
// editing, drag/resize previews) calls markStale so the next render rebuilds it from the node.
const builtFrom = new WeakMap();
const markStale = (el) => { if (el) builtFrom.delete(el); };

// One element for node n: id, classes, attributes and text, without children.
function nodeShell(n) {
  const svg = SVG_TAGS.has(n.tag);
  const el = svg ? document.createElementNS(SVG_NS, n.tag) : document.createElement(n.tag);
  el.dataset.nodeId = n.id;
  el.classList.add(`${NODE_CLASS}${n.id}`);
  for (const c of n.classes || []) el.classList.add(`${WeftRootCss.CANVAS_PREFIX}${c}`);
  for (const [k, v] of Object.entries(n.attrs || {})) el.setAttribute(k, v);
  if (svg) return el;
  if (n.tag === "button") el.type = "button";
  if (n.tag === "a" || n.tag === "button") el.tabIndex = -1;
  if (n.tag === "img") el.draggable = false;
  if (!VOID_TAGS.has(n.tag) && n.text) el.append(n.text);
  return el;
}

// Bring `el` (or a new element) up to date with node `id`, reusing child elements whose nodes didn't change.
function syncNodeEl(nodes, id, el) {
  const n = nodes[id];
  if (!n) return document.createElement("div");
  if (el && builtFrom.get(el) === n) {
    syncChildEls(nodes, n.children || [], el, el);
    return el;
  }
  const fresh = nodeShell(n);
  builtFrom.set(fresh, n);
  if (!VOID_TAGS.has(n.tag)) syncChildEls(nodes, n.children || [], fresh, el);
  return fresh;
}

// Make `parent`'s element children exactly `childIds`, taking elements to reuse from `from` (the old element).
function syncChildEls(nodes, childIds, parent, from) {
  const cur = parent.children;
  // Usual case: same children in the same order. Sync each in place without building a lookup.
  if (from === parent && cur.length === childIds.length) {
    let same = true;
    for (let i = 0; i < cur.length && same; i++) same = builtFrom.get(cur[i])?.id === childIds[i];
    if (same) {
      for (let i = 0; i < childIds.length; i++) {
        const el = syncNodeEl(nodes, childIds[i], cur[i]);
        if (el !== cur[i]) cur[i].replaceWith(el);
      }
      return;
    }
  }
  const prev = new Map();
  if (from) for (const c of from.children) if (c.dataset?.nodeId) prev.set(c.dataset.nodeId, c);
  const kids = childIds.map((cid) => syncNodeEl(nodes, cid, prev.get(cid)));
  if (kids.length === cur.length && kids.every((k, i) => k === cur[i])) return;
  const texts = [...parent.childNodes].filter((x) => x.nodeType === Node.TEXT_NODE);
  parent.replaceChildren(...texts, ...kids);
}

// The canvas stylesheet is split so an edit only rewrites a small sheet: `canvas-css` (variables, base classes),
// one sheet per artboard with its layers' own styles, then `canvas-css-tail` (states, @media, nesting), in that
// order so the cascade matches the export. Layers are targeted by a per-node class (.wn-<id>) rather than the
// data-node-id attribute: when a sheet changes, the browser then re-styles only elements with the classes it
// mentions, instead of every element on the canvas.
const NODE_CLASS = "wn-";
function renderCanvasCss() {
  const { head, tail } = WeftRootCss.canvasCssParts(rootOf(), "#world");
  const headEl = scopedSheet("canvas-css");
  if (headEl.textContent !== head) headEl.textContent = head;
  const tailEl = scopedSheet("canvas-css-tail");
  if (headEl.nextElementSibling !== tailEl && !headEl.nextElementSibling?.dataset.artboardCss) headEl.after(tailEl);
  const keep = new Set();
  for (const ab of S.nodes[S.rootId].children) {
    const key = `canvas-css-ab-${ab}`;
    let el = document.getElementById(key);
    if (!el) { el = document.createElement("style"); el.id = key; el.dataset.artboardCss = "1"; tailEl.before(el); }
    const css = WeftRootCss.layerCss(layerStyleList(S.nodes, [ab]), "#world", (id) => `.${NODE_CLASS}${id}`);
    if (el.textContent !== css) el.textContent = css;
    keep.add(el);
  }
  for (const el of document.querySelectorAll("style[data-artboard-css]")) if (!keep.has(el)) el.remove();
  if (tailEl.textContent !== tail) tailEl.textContent = tail;
}

function render() {
  if (!S) return;
  if (editingId || busy || pointerHeld) { pendingRender = true; return; }
  pendingRender = false;
  if (pendingSel && S.nodes[pendingSel]) { sel = pendingSel; pendingSel = null; shareSelection(); }
  if (sel && !S.nodes[sel]) sel = null;
  if (hoverId && !S.nodes[hoverId]) hoverId = null;
  stage.style.background = S.nodes[S.rootId].styles.backgroundColor || "";
  updateGrid();
  $("#stage-page-name").textContent = S.nodes[S.rootId].name || "Page 1";
  renderPages();
  renderCanvasCss();
  window.weft.events.dispatchEvent(new Event("root-vars")); // RootVars.svelte
  syncChildEls(S.nodes, S.nodes[S.rootId].children, world, world);
  for (const el of world.querySelectorAll(".is-selected")) el.classList.remove("is-selected");
  const onb = $("#empty-onboarding");
  if (onb) {
    const isEmpty = S.nodes[S.rootId].children.length === 0;
    onb.hidden = !isEmpty;
    if (isEmpty) {
      const pgName = S.nodes[S.rootId].name || "Page 1";
      $("#onb-desc").textContent = `Create a screen preset below, press F to draw a frame, or let Claude Code write HTML directly to ${pgName}.`;
      $("#onb-mcp-cmd").textContent = `claude mcp add --transport http weft ${location.origin}/mcp`;
    }
  }
  if (sel) elOf(sel)?.classList.add("is-selected");
  updateCommentsBadge();
  renderLayers();
  renderInspector();
  if (!commentsPanelEl.hidden) renderCommentsPanel();
  updateOverlay();
  if (pendingEdit && elOf(pendingEdit)) { const id = pendingEdit; pendingEdit = null; startEdit(id); }
}

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  updateGrid();
  $("#zoom-btn").textContent = `${Math.round(view.z * 100)}%`;
  if (viewKey()) localStorage.setItem(viewKey(), JSON.stringify(view));
  updateOverlay();
}

// Keep the snap grid aligned with world coordinates as you pan and zoom.
function updateGrid() {
  const st = app.style, z = view.z;
  st.setProperty("--grid-size", `${GRID * z}px`);
  st.setProperty("--grid-major-size", `${GRID * 8 * z}px`);
  st.setProperty("--grid-x", `${view.x}px`);
  st.setProperty("--grid-y", `${view.y}px`);
  st.setProperty("--grid-line", `${1 / z}px`); // artboard grids live in zoomed world space
  const dark = S && isDarkColor(S.nodes[S.rootId]?.styles.backgroundColor);
  const showMinor = GRID * z >= 6; // 8px cells closer than 6 screen px turn into noise
  st.setProperty("--grid-major", dark ? "rgba(255, 255, 255, 0.14)" : "rgba(10, 11, 13, 0.12)");
  st.setProperty("--grid-minor", showMinor ? (dark ? "rgba(255, 255, 255, 0.06)" : "rgba(10, 11, 13, 0.05)") : "transparent");
  st.setProperty("--grid-ab-minor", showMinor ? "rgba(0, 0, 255, 0.07)" : "transparent");
}

function rectOnStage(el) {
  const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
}

function placeBox(box, r) {
  if (!r) { box.style.display = "none"; return; }
  Object.assign(box.style, { display: "block", left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
}

function nodePageId(nid) {
  let n = S?.nodes?.[nid];
  while (n?.parentId && S.nodes[n.parentId]) n = S.nodes[n.parentId];
  return n && S.pages?.includes(n.id) ? n.id : null;
}
function commentPageId(c) {
  return nodePageId(c.nodeId) || c.pageId || S?.rootId || null;
}
function pageCommentsList() {
  if (!S) return [];
  return comments.filter((c) => commentPageId(c) === S.rootId);
}
function commentPinMap() {
  const map = new Map();
  let numIdx = 0;
  for (const c of pageCommentsList()) {
    if (c.status !== "resolved" && S.nodes[c.nodeId]) {
      numIdx += 1;
      map.set(c.id, numIdx);
    }
  }
  return map;
}

// The overlay's labels, context-bar contents, agent boxes and cursors, and the breadcrumb are
// ui/src/components/canvas/*.svelte. This measures where everything sits (it owns the canvas DOM and view), hands that
// over as window.weft.overlay, and still places the selection and hover boxes and the context bar itself.
function updateOverlay() {
  if (!S || !window.weft) return;
  const hug = (v) => (!v || v === "auto" || v === "fit-content" ? "Hug" : px(v));
  const labels = S.nodes[S.rootId].children.flatMap((id) => {
    const el = elOf(id);
    if (!el) return [];
    const r = rectOnStage(el), st = S.nodes[id].styles;
    const dim = r.w > 220 ? `${hug(st.width)} × ${hug(st.height)} · ${Math.round(view.z * 100)}%` : "";
    return [{ id, name: S.nodes[id].name, dim, sel: id === sel, x: r.x, y: r.y - 20, maxW: Math.max(40, r.w) }];
  });
  const selEl = sel && elOf(sel);
  const selRect = selEl ? rectOnStage(selEl) : null;
  const selNode = sel && S.nodes[sel];
  const onStage = selRect && selRect.x + selRect.w > 0 && selRect.x < stage.clientWidth && selRect.y + selRect.h > 44 && selRect.y < stage.clientHeight;
  const showCtx = Boolean(onStage && selNode && !busy && !editingId && tool === "select");
  const ctx = showCtx ? {
    name: selNode.name,
    preview: isArtboard(sel), // screens only; layers preview from the inspector header or P
    canFlex: !VOID_TAGS.has(selNode.tag) && !SVG_TAGS.has(selNode.tag),
    isFlex: selNode.styles.display === "flex" || selNode.styles.display === "inline-flex",
  } : null;
  const boxes = agentNodes.flatMap(({ id }) => {
    const el = elOf(id);
    if (!el) return [];
    const r = rectOnStage(el);
    return [{ x: r.x - 9, y: r.y - 9, w: r.w + 18, h: r.h + 18 }];
  });
  const cursors = agentCursors.flatMap((c) => {
    const els = (c.nodeIds || []).map(elOf).filter(Boolean);
    if (!els.length) return [];
    const rs = els.map(rectOnStage);
    const cx = Math.max(12, Math.min(stage.clientWidth - 24, Math.max(...rs.map((r) => r.x + r.w)) - 6));
    const cy = Math.max(12, Math.min(stage.clientHeight - 24, Math.max(...rs.map((r) => r.y + r.h)) - 6));
    return [{
      nodeId: c.nodeIds[0], look: c.mode === "look", color: c.color || "#d97757", name: c.name || "Claude",
      sub: [c.tool, c.detail].filter(Boolean).join(" · "),
      x: Math.round(cx), y: Math.round(cy), flipX: cx > stage.clientWidth - 210, flipY: cy > stage.clientHeight - 86,
    }];
  });
  const root = S.nodes[S.rootId];
  let ab = sel && S.nodes[sel];
  while (ab && ab.parentId !== S.rootId) ab = S.nodes[ab.parentId];
  const abNode = ab || S.nodes[root.children[0]];
  const crumbs = { page: root.name || "Page 1", artboard: abNode ? abNode.name : (root.children.length ? "" : "Empty canvas") };
  window.weft.overlay = { labels, ctx, agents: { boxes, cursors }, crumbs };
  window.weft.events.dispatchEvent(new Event("overlay"));

  placeBox($("#sel-box"), selRect);
  if (selEl) $("#sel-size").textContent = `${Math.round(selEl.offsetWidth)} × ${Math.round(selEl.offsetHeight)}`;
  // Contextual quick-action bar above the selection (kept clear of the artboard label, pill and HUD), placed after
  // its contents are rendered so its size is known.
  const ctxBar = $("#ctx-bar");
  if (showCtx) {
    ctxBar.style.display = "flex";
    const abOffset = isArtboard(sel) ? 24 : 8;
    const bw = ctxBar.offsetWidth || 260, bh = ctxBar.offsetHeight || 30;
    ctxBar.style.left = `${Math.max(12, Math.min(Math.max(12, stage.clientWidth - bw - 12), selRect.x))}px`;
    ctxBar.style.top = `${Math.max(48, Math.min(Math.max(48, stage.clientHeight - bh - 68), selRect.y - bh - abOffset))}px`;
  } else {
    ctxBar.style.display = "none";
  }
  renderCommentPins();
  const hovEl = hoverId && hoverId !== sel && elOf(hoverId);
  placeBox($("#hover-box"), hovEl ? rectOnStage(hovEl) : null);
}

const ICONS = {
  frame: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4.5 1v14M11.5 1v14M1 4.5h14M1 11.5h14"/></svg>`,
  text: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4h9M8 4v8.5M6 12.5h4"/></svg>`,
  row: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3 3v8M7 3v8M11 3v8"/></svg>`,
  col: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3 3h8M3 7h8M3 11h8"/></svg>`,
  box: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3" width="10" height="8" rx="1.5"/></svg>`,
  vec: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5 14 4v4.5c0 3.3-2.6 5.4-6 6.5-3.4-1.1-6-3.2-6-6.5V4z"/></svg>`,
  img: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M2 12l4-4 3 3 2-2 3 3"/></svg>`,
};
function iconFor(n) {
  if (n.parentId === S.rootId) return ICONS.frame;
  if (n.tag === "img") return ICONS.img;
  if (SVG_TAGS.has(n.tag)) return ICONS.vec;
  if (isTextNode(n.id)) return ICONS.text;
  if (n.styles.display === "flex") return n.styles.flexDirection === "column" ? ICONS.col : ICONS.row;
  return ICONS.box;
}

let layerFilter = "";
// The tree is ui/src/components/LayersPanel.svelte. This builds its rows (it needs the editor's state: selection,
// expanded artboards, agents, comments) and hands them over through window.weft.
function layerRows() {
  if (!S) return { rows: [], filtered: false };
  for (let p = sel && S.nodes[sel]?.parentId; p && p !== S.rootId; p = S.nodes[p]?.parentId) expanded.add(p);
  const agentIds = new Set(agentNodes.map((a) => a.id));
  const q = layerFilter.trim().toLowerCase();
  const rows = [];
  const row = (id, n, depth, twist) => {
    const open = comments.filter((c) => c.nodeId === id && c.status !== "resolved");
    rows.push({
      id,
      name: n.name,
      depth,
      twist, // "open" | "closed" | "none"
      draggable: !q,
      artboard: n.parentId === S.rootId,
      sel: id === sel,
      agent: agentIds.has(id),
      icon: iconFor(n),
      dim: n.parentId === S.rootId ? `${px(n.styles.width || "auto")}×${px(n.styles.height || "auto")}` : null,
      comments: open.length ? { count: open.length, replied: open.some((c) => c.status === "replied") } : null,
    });
  };
  if (q) {
    const match = (n) => n.name.toLowerCase().includes(q) || n.tag.toLowerCase().includes(q) || (n.text && n.text.toLowerCase().includes(q));
    const visit = (id) => {
      const n = S.nodes[id];
      if (!n) return;
      if (match(n)) row(id, n, 0, "none");
      n.children.forEach(visit);
    };
    S.nodes[S.rootId].children.forEach(visit);
  } else {
    const walk = (id, depth) => {
      const n = S.nodes[id];
      const has = n.children.length > 0;
      const open = expanded.has(id);
      row(id, n, depth, has ? (open ? "open" : "closed") : "none");
      if (has && open) n.children.forEach((c) => walk(c, depth + 1));
    };
    S.nodes[S.rootId].children.forEach((c) => walk(c, 0));
  }
  return { rows, filtered: Boolean(q) };
}
function renderLayers() {
  if (!S) return;
  window.weft.events.dispatchEvent(new Event("layers"));
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------
// The inspector's fields are rendered by ui/src/components/inspector/*.svelte (same data-* attributes as before);
// the listeners below still apply what is typed or clicked.
const hex6 = (v) => {
  const s = String(v || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7);
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join("")}`;
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) return "#" + [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, Number(x))).toString(16).padStart(2, "0")).join("");
  return "#ffffff";
};
// The header above the inspector is ui/src/components/RightHead.svelte; this is the data it shows. Its buttons
// (data-action) are handled by the #right click listener below.
function rightHeadModel() {
  if (!S) return null;
  const n = sel && S.nodes[sel];
  if (n) return { kind: n.parentId === S.rootId ? "artboard" : "layer", name: n.name, agent: agentNodes.some((a) => a.id === n.id) };
  const root = S.nodes[S.rootId];
  let layers = 0;
  const count = (id) => { layers += 1; (S.nodes[id]?.children || []).forEach(count); };
  root.children.forEach(count);
  return { kind: "page", name: root.name, artboards: root.children.length, layers };
}
function renderRightHead() {
  window.weft.events.dispatchEvent(new Event("right-head"));
}

// Placement stays on the layer; everything else can become a shared class.
const PLACEMENT = new Set(["position", "left", "top", "right", "bottom", "zIndex"]);
const classableStyles = (n) => Object.fromEntries(Object.entries(n.styles || {}).filter(([k]) => !PLACEMENT.has(k)));

async function applyRootCssText(css) {
  // Classes missing from the new text are removed from their layers too; say so before doing it.
  let kept;
  try { kept = new Set(WeftRootCss.definedClasses(WeftRootCss.parse(css))); } catch (err) { return toast(err.message, { ms: 6000 }); }
  const dropped = definedClassList().filter((c) => !kept.has(c) && classUsage(c));
  if (dropped.length && !confirm(`${dropped.map((c) => `.${c} (${classUsage(c)} layer${classUsage(c) === 1 ? "" : "s"})`).join(", ")} will be removed from the layers using ${dropped.length === 1 ? "it" : "them"}. Continue?`)) return;
  const res = await api("PATCH", "/api/root-css", { css, replace: true });
  if (!res) return;
  renderInspector(true);
  toast(res.changed.length ? `Root CSS updated · ${res.changed.length} change${res.changed.length === 1 ? "" : "s"}` : "Root CSS unchanged");
}

async function makeClassFrom(id) {
  const n = S.nodes[id];
  const styles = classableStyles(n);
  if (!Object.keys(styles).length) return toast("This layer has no styles of its own to share");
  const suggested = n.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^(?=\d)/, "layer-") || n.tag;
  const raw = window.prompt("Class name (layers can share it from Shared classes)", suggested);
  if (raw === null) return;
  const name = raw.trim().replace(/^\./, "");
  if (!/^[a-zA-Z][\w-]{0,63}$/.test(name)) return toast("Class names start with a letter and use letters, digits, - or _");
  if (definedClassList().includes(name)) return toast(`.${name} already exists; add it from Shared classes`);
  if (!(await api("PATCH", "/api/root-css", { classes: { [name]: styles } }))) return;
  // The class now carries the styles, so the layer drops its own copies of them.
  const cleared = Object.fromEntries(Object.keys(styles).map((k) => [k, null]));
  if (await patch(id, { classes: [...(n.classes || []), name], styles: cleared })) toast(`Created .${name}; add it to other layers to share these styles`);
}

function renderInspector(force = false) {
  if (!S) return;
  const a = document.activeElement;
  if (!force && inspector.contains(a) && a.matches("input:not([type=checkbox]):not([type=color]), textarea, select")) { inspectorDirty = true; return; }
  inspectorDirty = false;
  renderRightHead();
  // Copy actions live in the context bar and the Export menu; the footer stays empty.
  inspectorFoot.hidden = true;
  inspectorFoot.innerHTML = "";
  window.weft.events.dispatchEvent(new CustomEvent("inspector", { detail: { force } }));
}

// What the inspector components show (see ui/src/components/inspector/Inspector.svelte).
function inspectorModel() {
  if (!S) return null;
  const n = sel && S.nodes[sel];
  return {
    node: n || null,
    artboard: Boolean(n && n.parentId === S.rootId),
    page: S.nodes[S.rootId],
    cssJsonOpen,
    fontLib,
    rootCss: rootOf(),
    definedClasses: definedClassList(),
    mcpUrl: `${location.origin}/mcp`,
  };
}

function parseVal(raw, kind) {
  const t = raw.trim();
  if (t === "") return null;
  if (kind === "percent") return Math.max(0, Math.min(100, num(t, 100))) / 100;
  if (kind === "font") return fontStack(t);
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
}

inspector.addEventListener("input", (e) => {
  if (e.target.matches('.swatch input[type="color"]')) {
    const sw = e.target.closest(".swatch");
    const txt = e.target.closest(".fld")?.querySelector('input:not([type="color"])');
    if (sw) { sw.classList.remove("empty"); sw.style.background = e.target.value; }
    if (txt) txt.value = e.target.value;
  }
});
// Escape leaves a field without saving: blurring it would fire "change", so that one change is ignored.
let cancellingField = null;
inspector.addEventListener("change", (e) => {
  const t = e.target;
  if (t === cancellingField) return;
  if (t.id === "font-file") return uploadFonts([...t.files]);
  if (t.id === "google-family") return;
  if (t.id === "css-json") return;
  if (t.dataset.page) return patchStyles(S.rootId, { backgroundColor: t.value || null });
  if (t.id === "root-css") return;
  if (!sel) return;
  if (t.dataset.classAdd !== undefined) {
    if (t.value) patch(sel, { classes: [...(S.nodes[sel].classes || []), t.value] });
    return;
  }
  if (t.dataset.style) {
    const key = t.dataset.style;
    let value = t.type === "checkbox" ? (t.checked ? t.value : null) : parseVal(t.value, t.dataset.kind);
    if (key === "lineHeight" && typeof value === "number" && value >= 4) value = `${value}px`;
    const styles = { [key]: value };
    if (key === "position" && value === "absolute") {
      const el = elOf(sel);
      if (el) Object.assign(styles, { left: Math.round(el.offsetLeft), top: Math.round(el.offsetTop) });
    }
    if (key === "position" && value !== "absolute") Object.assign(styles, { left: null, top: null });
    patchStyles(sel, styles);
  } else if (t.dataset.field) {
    patch(sel, { [t.dataset.field]: t.value });
  } else if (t.dataset.attr) {
    patch(sel, { attrs: { [t.dataset.attr]: t.value || null } });
  }
});
const STEP_KEYS = new Set(["left", "top", "width", "height", "fontSize", "borderRadius", "gap", "padding", "opacity"]);
inspector.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "css-json" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    inspector.querySelector('[data-action="apply-css"]')?.click();
    return;
  }
  if (e.key === "Enter" && e.target.id === "root-css" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    inspector.querySelector('[data-action="apply-root-css"]')?.click();
    return;
  }
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.target.matches("input[data-style]") && STEP_KEYS.has(e.target.dataset.style)) {
    const raw = e.target.value.trim();
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      e.preventDefault();
      const step = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
      const next = Math.round((Number(raw) + step) * 100) / 100;
      e.target.value = String(e.target.dataset.kind === "percent" ? Math.max(0, Math.min(100, next)) : next);
      e.target.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }
  if (e.key === "Enter" && e.target.id === "google-family") { e.preventDefault(); $("#right").querySelector('[data-action="add-google"]')?.click(); return; }
  if (e.key === "Enter" && e.target.matches("input")) e.target.blur();
  if (e.key === "Escape" && e.target.matches("input, textarea")) {
    cancellingField = e.target;
    e.target.blur();
    cancellingField = null;
    renderInspector(true); // fresh fields show the saved values again
  }
});
inspector.addEventListener("focusout", () => setTimeout(() => {
  if (inspectorDirty && !inspector.contains(document.activeElement)) renderInspector(true);
}));

$("#right").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const act = b.dataset.action;
  if (act === "copy") return copyExport(b.dataset.format, sel);
  if (act === "export-zip") return downloadZip(S?.id, b.dataset.format || "html");
  if (act === "copy-mcp") return copyText($("#mcp-cmd").textContent, "Copied MCP command");
  if (act === "page-bg") return patchStyles(S.rootId, { backgroundColor: b.dataset.bg });
  if (act === "toggle-css-json") { cssJsonOpen = !cssJsonOpen; return renderInspector(true); }
  if (act === "remove-font") {
    const f = fontLib.find((x) => x.id === b.dataset.id);
    if (f && confirm(`Remove ${f.family} from the font library? Layers using it fall back to their fallback fonts.`)) await api("DELETE", `/api/fonts/${encodeURIComponent(f.id)}`);
    return;
  }
  if (act === "apply-root-css") return applyRootCssText($("#root-css").value);
  if (act === "add-google") {
    const family = $("#google-family").value.trim();
    if (!family) return toast("Type a Google Fonts family name");
    if (await api("POST", "/api/fonts/google", { family })) toast(`Added ${family}`);
    return;
  }
  if (!sel) return;
  if (act === "zoom-sel") return zoomCmd("selection");
  if (act === "preview") return openPreview(sel);
  if (act === "preset-size") {
    const styles = { height: b.dataset.h === "fit-content" ? "fit-content" : Number(b.dataset.h) };
    if (b.dataset.w) styles.width = Number(b.dataset.w);
    return patchStyles(sel, styles);
  }
  if (act === "remove-class") return patch(sel, { classes: (S.nodes[sel].classes || []).filter((c) => c !== b.dataset.class) });
  if (act === "make-class") return makeClassFrom(sel);
  if (act === "delete") return removeSelected();
  if (act === "duplicate") return duplicateSelected();
  if (act === "flex" || act === "unflex") return toggleFlex(sel);
  if (act === "dir") return patchStyles(sel, { flexDirection: b.dataset.dir });
  if (act === "align") return patchStyles(sel, { justifyContent: b.dataset.j, alignItems: b.dataset.a });
  if (act === "textAlign") return patchStyles(sel, { textAlign: b.dataset.v === "left" ? null : b.dataset.v });
  if (act === "clear") return patchStyles(sel, { [b.dataset.key]: null });
  if (act === "apply-css") {
    let styles;
    try { styles = JSON.parse($("#css-json").value); } catch (err) { return toast(`Invalid JSON: ${err.message}`); }
    if (!styles || typeof styles !== "object" || Array.isArray(styles)) return toast("CSS must be a JSON object");
    if (await patch(sel, { styles, replaceStyles: true })) toast("CSS applied");
  }
});

// Contextual Bar actions
$("#ctx-bar").addEventListener("pointerdown", (e) => e.stopPropagation());
$("#ctx-bar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ctx]");
  if (!b || !sel) return;
  const act = b.dataset.ctx;
  if (act === "copy") return copyExport("html", sel);
  if (act === "preview") return openPreview(sel);
  if (act === "duplicate") return duplicateSelected();
  if (act === "flex") return toggleFlex(sel);
  if (act === "comment") return openNewComment(sel);
});

// Preview: the screen (artboard) a layer belongs to, opened as a live page in its own browser tab.
function screenOf(id) {
  let n = S?.nodes[id];
  while (n && n.parentId && !S.pages.includes(n.parentId)) n = S.nodes[n.parentId];
  return n && S.pages.includes(n.parentId) ? n.id : null;
}
function openPreview(id) {
  const ab = screenOf(id);
  if (!ab) return toast("Select a screen to preview");
  const w = window.open(`/preview/${encodeURIComponent(ab)}`, "_blank");
  if (!w) return toast("The browser blocked the preview tab; allow pop-ups for weft and try again", { ms: 5000 });
  w.opener = null; // the preview never needs to reach back into the editor
  toast(`Previewing ${S.nodes[ab].name} in a new tab`);
}

// One flex toggle for the context bar, inspector and Shift+A: removing flex clears every flex-only property.
const UNFLEX = { display: null, flexDirection: null, justifyContent: null, alignItems: null, gap: null, flexWrap: null };
function toggleFlex(id) {
  const st = S.nodes[id].styles;
  const isFlex = st.display === "flex" || st.display === "inline-flex";
  return patchStyles(id, isFlex ? UNFLEX : { display: "flex", flexDirection: st.flexDirection || "column", gap: st.gap || 8 });
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  toast(msg);
}

async function copyExport(format, nodeId) {
  const q = new URLSearchParams({ format });
  if (nodeId) q.set("nodeId", nodeId);
  const code = await api("GET", `/api/export?${q}`);
  if (typeof code === "string") copyText(code, format === "jsx" ? "Copied JSX" : "Copied HTML + CSS");
}

async function downloadZip(projectId = S?.id, format = "html") {
  if (!projectId) return;
  const q = new URLSearchParams({ projectId, format });
  try {
    const res = await fetch(`/api/export/zip?${q}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText);
    }
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const m = cd.match(/filename="([^"]+)"/);
    const fileName = m ? m[1] : "project.zip";
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${fileName}`);
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Selection, editing, commands
// ---------------------------------------------------------------------------
function select(id) {
  pendingSel = null; // an explicit choice wins over a selection still waiting on the server (e.g. a fresh duplicate)
  selEpoch += 1;
  if (id === sel) return;
  if (editingId) finishEdit(true);
  elOf(sel)?.classList.remove("is-selected");
  sel = id;
  if (sel) { for (let p = S.nodes[sel]?.parentId; p && p !== S.rootId; p = S.nodes[p]?.parentId) expanded.add(p); saveExpanded(); }
  elOf(sel)?.classList.add("is-selected");
  renderLayers();
  renderInspector(true);
  updateOverlay();
  shareSelection();
}

function shareSelection() {
  clearTimeout(shareSelection.t);
  shareSelection.t = setTimeout(() => api("POST", "/api/selection", { ids: sel ? [sel] : [] }), 120);
}

function pathTo(id) {
  const path = [];
  for (let n = S.nodes[id]; n && n.id !== S.rootId; n = S.nodes[n.parentId]) path.unshift(n.id);
  return path;
}

function pickTarget(deepest) {
  const path = pathTo(deepest);
  if (sel) {
    const i = path.indexOf(sel);
    if (i > 0) return sel;
    const pi = path.indexOf(S.nodes[sel]?.parentId);
    if (pi >= 0 && path[pi + 1]) return path[pi + 1];
  }
  return path[1] || path[0];
}

function startEdit(id) {
  const el = elOf(id);
  if (!el) { pendingEdit = id; return; }
  if (!isTextNode(id)) return;
  select(id);
  editingId = id;
  editOriginal = S.nodes[id].text;
  el.contentEditable = "plaintext-only";
  if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
  el.classList.add("editing");
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  el.addEventListener("keydown", (k) => {
    k.stopPropagation();
    if (k.key === "Escape") { k.preventDefault(); finishEdit(false); }
    else if (k.key === "Enter" && !k.shiftKey) { k.preventDefault(); finishEdit(true); }
  });
  el.addEventListener("input", updateOverlay);
  el.addEventListener("blur", () => finishEdit(true), { once: true });
}

function finishEdit(commit) {
  if (!editingId) return;
  const id = editingId;
  const el = elOf(id);
  editingId = null;
  const text = el ? el.innerText.replace(/\n$/, "") : editOriginal;
  if (el) { el.contentEditable = "false"; el.classList.remove("editing"); markStale(el); }
  getSelection().removeAllRanges();
  if (commit && text !== editOriginal) patch(id, { text });
  else render();
}

async function removeSelected() {
  if (!sel || !S?.nodes[sel]) return;
  const epoch = selEpoch, parent = S.nodes[sel].parentId;
  const ok = await api("DELETE", `/api/nodes/${encodeURIComponent(sel)}`);
  if (ok && selEpoch === epoch) select(parent === S.rootId || !S.nodes[parent] ? null : parent);
}

// Only jump to the new layer if the user hasn't selected something else (or switched tools) while the request ran.
async function duplicateSelected() {
  if (!sel || !S?.nodes[sel]) return;
  const epoch = selEpoch;
  const dup = await api("POST", `/api/nodes/${encodeURIComponent(sel)}/duplicate`);
  if (dup && selEpoch === epoch) { pendingSel = dup.id; render(); }
}

async function createNode(body, { edit = false } = {}) {
  const epoch = selEpoch, fromToolEpoch = toolEpoch;
  const node = await api("POST", "/api/nodes", body);
  if (!node || selEpoch !== epoch) return;
  pendingSel = node.id;
  if (edit) pendingEdit = node.id;
  render();
  // Only fall back to Select if nobody picked a tool since this layer was drawn (e.g. pressing R again to draw
  // another rectangle while this request was in flight must not be undone mid-gesture).
  if (toolEpoch === fromToolEpoch) setTool("select");
}

function setTool(t) {
  tool = t;
  toolEpoch += 1;
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  stage.className = `tool-${t}`;
  updateOverlay();
}

// ---------------------------------------------------------------------------
// View: pan / zoom
// ---------------------------------------------------------------------------
const clampZ = (z) => Math.min(8, Math.max(0.03, z));
function zoomAt(factor, sx, sy) {
  const nz = clampZ(view.z * factor);
  view.x = sx - (sx - view.x) * (nz / view.z);
  view.y = sy - (sy - view.y) * (nz / view.z);
  view.z = nz;
  applyView();
}
function stageCenter() { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; }

function worldBounds(els) {
  if (!els.length) return null;
  const s = stage.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    x0 = Math.min(x0, (r.left - s.left - view.x) / view.z);
    y0 = Math.min(y0, (r.top - s.top - view.y) / view.z);
    x1 = Math.max(x1, (r.right - s.left - view.x) / view.z);
    y1 = Math.max(y1, (r.bottom - s.top - view.y) / view.z);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function fitTo(b, maxZ = 2) {
  if (!b) return;
  const r = stage.getBoundingClientRect();
  const pad = 72;
  view.z = clampZ(Math.min((r.width - pad * 2) / Math.max(1, b.w), (r.height - pad * 2) / Math.max(1, b.h), maxZ));
  view.x = (r.width - b.w * view.z) / 2 - b.x * view.z;
  view.y = (r.height - b.h * view.z) / 2 - b.y * view.z;
  applyView();
}

function zoomCmd(mode) {
  const [cx, cy] = stageCenter();
  if (mode === "in") zoomAt(1.25, cx, cy);
  else if (mode === "out") zoomAt(0.8, cx, cy);
  else if (mode === "100") zoomAt(1 / view.z, cx, cy);
  else if (mode === "fit") fitTo(worldBounds([...world.children]), 1);
  else if (mode === "selection") fitTo(sel && elOf(sel) ? worldBounds([elOf(sel)]) : worldBounds([...world.children]), 4);
  toast({ in: "Zoom in", out: "Zoom out", 100: "Zoom to 100%", fit: "Zoom to fit", selection: "Zoom to selection" }[mode]);
}

stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  if (followAgent) setFollowAgent(false, true);
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
  else { view.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX; view.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY; applyView(); }
}, { passive: false });

function startPan(e) {
  if (followAgent) setFollowAgent(false, true);
  stage.setPointerCapture(e.pointerId);
  stage.classList.add("panning");
  let lx = e.clientX, ly = e.clientY;
  const move = (m) => { view.x += m.clientX - lx; view.y += m.clientY - ly; lx = m.clientX; ly = m.clientY; applyView(); };
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

// ---------------------------------------------------------------------------
// Drawing new layers (Frame / Rectangle / Text tools)
// ---------------------------------------------------------------------------
function startCreate(e) {
  const s = stage.getBoundingClientRect();
  const a = { x: e.clientX - s.left, y: e.clientY - s.top, cx: e.clientX, cy: e.clientY };
  // Remember the artboard by id: a live update (e.g. an agent editing over MCP) can re-render the canvas before
  // pointerup, and a detached element measures as 0,0, which would drop the new layer at raw screen coordinates.
  const boardId = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.parentElement === world && el.dataset.nodeId)?.dataset.nodeId;
  const marquee = $("#marquee");
  const gestureTool = tool; // fixed for the whole gesture, even if the tool changes before pointerup
  stage.setPointerCapture(e.pointerId);
  const move = (m) => {
    if (gestureTool === "text") return;
    const bx = m.clientX - s.left, by = m.clientY - s.top;
    placeBox(marquee, { x: Math.min(a.x, bx), y: Math.min(a.y, by), w: Math.abs(bx - a.x), h: Math.abs(by - a.y) });
  };
  const up = (u) => {
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", up);
    placeBox(marquee, null);
    const bx = u.clientX - s.left, by = u.clientY - s.top;
    const dragged = Math.abs(bx - a.x) > 4 || Math.abs(by - a.y) > 4;
    let x = (Math.min(a.x, bx) - view.x) / view.z, y = (Math.min(a.y, by) - view.y) / view.z;
    let w = Math.abs(bx - a.x) / view.z, h = Math.abs(by - a.y) / view.z;
    let parentId = S.rootId;
    const board = boardId && isArtboard(boardId) ? elOf(boardId) : null; // the artboard's current element, if it still exists
    if (board) {
      const br = board.getBoundingClientRect();
      parentId = boardId;
      x = (Math.min(a.cx, u.clientX) - br.left) / view.z;
      y = (Math.min(a.cy, u.clientY) - br.top) / view.z;
    }
    const snap = (v) => (snapInput.checked ? Math.round(v / GRID) * GRID : Math.round(v));
    const pos = { position: "absolute", left: snap(x), top: snap(y) };
    const top = parentId === S.rootId;
    const count = S.nodes[S.rootId].children.length + 1;
    if (gestureTool === "text") {
      const darkPage = isDarkColor(S.nodes[S.rootId].styles.backgroundColor);
      const styles = { ...pos, margin: 0, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, color: top && darkPage ? "#e6e6e6" : "#0a0b0d", whiteSpace: "pre-wrap" };
      if (top) Object.assign(styles, { width: null, height: null, backgroundColor: null, overflow: null });
      return createNode({ parentId, tag: "p", name: "Text", text: "Text", styles }, { edit: true });
    }
    const size = dragged ? { width: snap(w), height: snap(h) } : top && gestureTool === "frame" ? { width: 390, height: 844 } : { width: 100, height: 100 };
    const fill = gestureTool === "rect" ? "#dde3e9" : "#ffffff";
    const name = gestureTool === "rect" ? "Rectangle" : top ? `Frame ${count}` : "Frame";
    createNode({ parentId, tag: "div", name, styles: { ...pos, ...size, backgroundColor: fill } });
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
}

// ---------------------------------------------------------------------------
// Canvas pointer handling
// ---------------------------------------------------------------------------
stage.addEventListener("pointerdown", (e) => { if (e.button === 0) pointerHeld = true; }, true);
function releasePointer() {
  if (!pointerHeld) return;
  pointerHeld = false;
  if (pendingRender && !busy && !editingId) render();
}
window.addEventListener("pointerup", releasePointer, true);
window.addEventListener("pointercancel", releasePointer, true);
window.addEventListener("blur", releasePointer);
// Safety net if the release happened outside the window: any move with no button down ends the hold.
window.addEventListener("pointermove", (e) => { if (pointerHeld && e.buttons === 0) releasePointer(); }, true);

stage.addEventListener("pointerdown", (e) => {
  // The zoom menu lives inside the stage: let clicks on it land (the document handler closes it on outside clicks).
  if (e.target.closest("#stage-hud, #ctx-bar, #stage-pill, #show-ui, .ab-label, #comment-thread, #comment-pins")) return;
  if (e.button === 1 || spaceDown || tool === "hand") { e.preventDefault(); return startPan(e); }
  if (e.button !== 0) return;
  if (editingId && e.target.closest(".editing")) return;
  if (editingId) finishEdit(true);
  if (tool === "comment") {
    e.preventDefault();
    const hitC = e.target.closest("#world [data-node-id]");
    if (hitC) { const tid = pickTarget(hitC.dataset.nodeId); setTool("select"); openNewComment(tid); }
    return;
  }
  if ((activeThreadId || draftCommentNodeId) && !commentThreadEl.contains(e.target)) closeCommentThread();
  if (tool !== "select") { e.preventDefault(); return startCreate(e); }
  const hit = e.target.closest("#world [data-node-id]");
  select(hit ? pickTarget(hit.dataset.nodeId) : null);
});

stage.addEventListener("dblclick", (e) => {
  if (e.target.closest("#stage-hud, #ctx-bar, #stage-pill")) return;
  if (tool !== "select" || editingId) return;
  const hit = e.target.closest("#world [data-node-id]");
  if (!hit) return;
  const path = pathTo(hit.dataset.nodeId);
  const deepest = path[path.length - 1];
  const i = path.indexOf(sel);
  if (isTextNode(deepest) && (sel === deepest || i === path.length - 2)) return startEdit(deepest);
  if (i >= 0 && i < path.length - 1) select(path[i + 1]);
  else if (sel === deepest && isTextNode(deepest)) startEdit(deepest);
});

stage.addEventListener("click", (e) => { if (e.target.closest("#world a, #world button")) e.preventDefault(); }, true);

stage.addEventListener("pointermove", (e) => {
  const placingEl = $("#comment-placing");
  if (tool === "comment" && !busy) {
    const hit = e.target.closest("#world [data-node-id]");
    const id = hit ? pickTarget(hit.dataset.nodeId) : null;
    if (id !== hoverId) { hoverId = id; updateOverlay(); }
    if (id && S?.nodes[id]) {
      const sr = stage.getBoundingClientRect();
      placingEl.style.display = "flex";
      placingEl.style.left = `${Math.round(e.clientX - sr.left + 10)}px`;
      placingEl.style.top = `${Math.round(e.clientY - sr.top + 10)}px`;
      $("#placing-hint").textContent = `Comment on ${S.nodes[id].name}`;
    } else { placingEl.style.display = "none"; }
    return;
  }
  if (placingEl) placingEl.style.display = "none";
  if (busy || tool !== "select") return;
  const hit = e.target.closest("#world [data-node-id]");
  const id = hit ? pickHover(hit.dataset.nodeId) : null;
  if (id !== hoverId) { hoverId = id; updateOverlay(); }
});
stage.addEventListener("pointerleave", () => { hoverId = null; const p = $("#comment-placing"); if (p) p.style.display = "none"; updateOverlay(); });
function pickHover(deepest) { const p = pathTo(deepest); const i = p.indexOf(sel); return i >= 0 ? p[Math.min(i + 1, p.length - 1)] : pickTarget(deepest); }

$("#labels").addEventListener("pointerdown", (e) => {
  const l = e.target.closest(".ab-label");
  if (!l) return;
  if (spaceDown || tool === "hand" || e.button === 1) return startPan(e);
  select(l.dataset.id);
});
$("#labels").addEventListener("dblclick", (e) => { const l = e.target.closest(".ab-label"); if (l) renameRow(l.dataset.id); });

// ---------------------------------------------------------------------------
// Drag & resize (interact.js)
// ---------------------------------------------------------------------------
let op = null;
const snapV = (v) => (snapInput.checked ? Math.round(v / GRID) * GRID : Math.round(v));

function dragStart(e, id, fromLabel = false) {
  const n = S.nodes[id];
  if (!n || tool !== "select" || spaceDown || editingId || n.styles.position !== "absolute" || (!fromLabel && id !== sel)) {
    e.interaction.stop();
    return;
  }
  const el = elOf(id);
  op = { id, el, x0: num(n.styles.left, el.offsetLeft), y0: num(n.styles.top, el.offsetTop), dx: 0, dy: 0 };
  markStale(el); // the drag preview sets inline left/top
  busy = true;
  if (sel !== id) select(id);
}
function dragMove(e) {
  if (!op) return;
  op.dx += e.dx / view.z; op.dy += e.dy / view.z;
  op.x = snapV(op.x0 + op.dx); op.y = snapV(op.y0 + op.dy);
  op.el.style.left = `${op.x}px`; op.el.style.top = `${op.y}px`;
  updateOverlay();
}
function dragEnd() {
  if (!op) return;
  const { id, x, y, x0, y0 } = op;
  op = null; busy = false;
  if (x !== undefined && (x !== x0 || y !== y0)) patchStyles(id, { left: x, top: y });
  else if (pendingRender) render();
  else updateOverlay();
}

function resizeStart(e) {
  const id = e.target.dataset.nodeId;
  const n = S.nodes[id];
  if (!n || id !== sel || tool !== "select" || spaceDown || editingId) { e.interaction.stop(); return; }
  const el = e.target;
  markStale(el); // the resize preview sets inline width/height
  op = { id, el, abs: n.styles.position === "absolute", w: el.offsetWidth, h: el.offsetHeight,
    x: num(n.styles.left, el.offsetLeft), y: num(n.styles.top, el.offsetTop), moved: false };
  busy = true;
}
function resizeMove(e) {
  if (!op) return;
  const d = e.deltaRect, z = view.z;
  const canLeft = op.abs || !e.edges.left, canTop = op.abs || !e.edges.top;
  if (canLeft) { op.w = Math.max(1, op.w + d.width / z); if (op.abs) op.x += d.left / z; }
  if (canTop) { op.h = Math.max(1, op.h + d.height / z); if (op.abs) op.y += d.top / z; }
  op.moved = true;
  Object.assign(op.el.style, { width: `${snapV(op.w)}px`, height: `${snapV(op.h)}px` });
  if (op.abs) Object.assign(op.el.style, { left: `${snapV(op.x)}px`, top: `${snapV(op.y)}px` });
  updateOverlay();
}
function resizeEnd() {
  if (!op) return;
  const o = op;
  op = null; busy = false;
  if (!o.moved) { if (pendingRender) render(); else updateOverlay(); return; }
  const styles = { width: snapV(o.w), height: snapV(o.h) };
  if (o.abs) Object.assign(styles, { left: snapV(o.x), top: snapV(o.y) });
  patchStyles(o.id, styles);
}

function setupInteract() {
  if (!window.interact) { toast("interact.js did not load — drag & resize disabled"); return; }
  interact("#world .is-selected")
    .draggable({ listeners: { start: (e) => dragStart(e, e.target.dataset.nodeId), move: dragMove, end: dragEnd } })
    .resizable({ edges: { left: true, right: true, top: true, bottom: true }, margin: 6,
      listeners: { start: resizeStart, move: resizeMove, end: resizeEnd } });
  interact("#labels .ab-label").draggable({ listeners: { start: (e) => dragStart(e, e.target.dataset.id, true), move: dragMove, end: dragEnd } });
}

// ---------------------------------------------------------------------------
// Layers panel: select, collapse, rename, drag to reorder / reparent
// ---------------------------------------------------------------------------
// Clicks, hover, rename and drag & drop on rows are handled in LayersPanel.svelte, which calls back into the
// functions below through window.weft.
function toggleExpanded(id) {
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  saveExpanded();
  renderLayers();
}
function hoverLayer(id) {
  if (id !== hoverId) { hoverId = id; updateOverlay(); }
}
// Start renaming a layer in the tree (also used by double-clicking an artboard's label on the canvas).
function renameRow(id) {
  select(id);
  window.weft.events.dispatchEvent(new CustomEvent("layer-rename", { detail: id }));
}
async function renameLayer(id, name) {
  const ok = await patch(id, { name });
  if (!ok) renderLayers();
  return ok;
}

// Can the dragged layer become a child of target? Artboards stay top-level, and HTML and SVG don't mix.
function canNestIn(dragId, targetId) {
  const target = S.nodes[targetId], drag = S.nodes[dragId];
  if (!target || !drag || drag.parentId === S.rootId) return false;
  if (VOID_TAGS.has(target.tag) || isTextNode(targetId)) return false;
  const targetSvg = SVG_TAGS.has(target.tag), dragSvg = SVG_TAGS.has(drag.tag);
  if (targetSvg) return dragSvg && (target.tag === "svg" || target.tag === "g") && drag.tag !== "svg";
  return !dragSvg || drag.tag === "svg";
}
// Move layer `id` before / after / inside `targetId`, enforcing the tree's rules. zone: "before" | "after" | "inside".
function dropLayer(id, targetId, zone) {
  if (!S.nodes[id] || !S.nodes[targetId] || id === targetId) return;
  const target = S.nodes[targetId];
  const dragIsArtboard = S.nodes[id].parentId === S.rootId;
  if (dragIsArtboard && target.parentId !== S.rootId) return toast("Artboards stay at the top level");
  // A layer dropped on an artboard row goes into that artboard (there's no "between artboards" for layers).
  if (!dragIsArtboard && target.parentId === S.rootId) zone = "inside";
  if (zone === "inside" && !canNestIn(id, target.id)) return toast(`Can't put ${S.nodes[id].tag} inside ${target.tag}`);
  if (zone === "inside") return patch(id, { parentId: target.id });
  const parent = S.nodes[target.parentId];
  let index = parent.children.indexOf(target.id) + (zone === "after" ? 1 : 0);
  const cur = parent.children.indexOf(id);
  if (cur >= 0 && cur < index) index -= 1;
  return patch(id, { parentId: parent.id, index });
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------
function fontStack(value) {
  const t = String(value || "").trim();
  if (!t || t.includes(",")) return t;
  const name = t.replace(/^['"]|['"]$/g, "");
  if (GENERIC_FONTS.includes(name.toLowerCase())) return name.toLowerCase();
  const lib = fontLib.find((f) => f.family.toLowerCase() === name.toLowerCase());
  const fam = lib ? lib.family : name;
  return `'${fam}', ${/mono|code/i.test(fam) ? "ui-monospace, monospace" : "system-ui, sans-serif"}`;
}

// The <datalist> is ui/src/components/FontList.svelte.
function renderFontList() {
  window.weft.events.dispatchEvent(new Event("fonts"));
}

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

async function uploadFonts(files) {
  let ok = 0;
  for (const file of files) {
    const res = await api("POST", "/api/fonts", { fileName: file.name, data: await readAsBase64(file) });
    if (res) ok += 1;
  }
  if (ok) toast(`Added ${ok} font file${ok > 1 ? "s" : ""}`);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
// The page list is ui/src/components/PagesList.svelte (switch, rename, delete); this keeps the title in sync and
// hands it the pages.
function renderPages() {
  $("#project-name").textContent = S.name;
  document.title = `${S.name} · weft`;
  window.weft.events.dispatchEvent(new Event("pages"));
}
function pagesModel() {
  if (!S) return [];
  return S.pages.map((id) => ({ id, name: S.nodes[id].name, artboards: S.nodes[id].children?.length || 0, current: id === S.rootId }));
}
$("#add-page").addEventListener("click", () => api("POST", "/api/pages", {}));

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
const projectMenu = $("#project-menu");
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// The menu's contents (project list, actions, the new / rename / delete forms) are
// ui/src/components/ProjectMenu.svelte. This opens and closes it; "project-menu" tells it to start from the list.
function openProjectMenu(open = projectMenu.hidden) {
  projectMenu.hidden = !open;
  $("#project-btn").setAttribute("aria-expanded", String(open));
  if (open) window.weft.events.dispatchEvent(new Event("project-menu"));
}
function projectMenuModel() {
  return { projects, current: S ? { id: S.id, name: S.name } : null };
}

$("#project-btn").addEventListener("click", () => openProjectMenu());
document.addEventListener("pointerdown", (e) => { if (!projectMenu.hidden && !e.target.closest("#project-menu, #project-btn")) openProjectMenu(false); });

// ---------------------------------------------------------------------------
// UX #04: Command Palette (⌘K)
// ---------------------------------------------------------------------------
// The palette's UI (search, highlighting, keyboard, list) is ui/src/components/CommandPalette.svelte. This script
// builds the entries (buildCmdkEntries, called through window.weft) because they depend on the editor's state.
const cmdkEl = $("#cmdk");

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

function openCmdk(open = cmdkEl.hidden) {
  // Release focus on close so canvas shortcuts (V, F, Delete…) work right away.
  if (!open && cmdkEl.contains(document.activeElement)) document.activeElement.blur();
  cmdkEl.hidden = !open;
  if (open) {
    openExportMenu(false);
    openProjectMenu(false);
    window.weft.events.dispatchEvent(new Event("cmdk-open"));
  }
}

function buildCmdkEntries() {
  if (!S) return [];
  const entries = [];
  if (sel && S.nodes[sel]) {
    const selName = S.nodes[sel].name;
    entries.push({ group: "Quick actions", icon: CMDK_ICONS.code, label: "Copy HTML + CSS", dim: `· ${selName}`, kbd: "Ctrl C", isKbd: true, search: `copy html css ${selName}`.toLowerCase(), run: () => copyExport("html", sel) });
    entries.push({ group: "Quick actions", icon: CMDK_ICONS.code, label: "Copy JSX", dim: `· ${selName}`, kbd: "", search: `copy jsx ${selName}`.toLowerCase(), run: () => copyExport("jsx", sel) });
    entries.push({ group: "Quick actions", icon: CMDK_ICONS.comment, label: "Comment on", dim: selName, kbd: "C", isKbd: true, search: `comment on ${selName}`.toLowerCase(), run: () => openNewComment(sel) });
  }
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.grid, label: `${snapInput.checked ? "Disable" : "Enable"} 8px snap grid`, kbd: "Shift G", isKbd: true, run: () => { setSnap(!snapInput.checked); toast(snapInput.checked ? "Snap 8px on" : "Snap 8px off"); } });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.zoom, label: "Zoom to fit all artboards", kbd: "Shift 1", isKbd: true, run: () => zoomCmd("fit") });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.zoom, label: "Zoom to 100%", kbd: "Shift 0", isKbd: true, run: () => zoomCmd("100") });
  if (sel && S.nodes[sel]) entries.push({ group: "Quick actions", icon: CMDK_ICONS.zoom, label: "Zoom to selection", kbd: "Shift 2", isKbd: true, run: () => zoomCmd("selection") });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.panel, label: app.classList.contains("ui-hidden") ? "Show studio UI" : "Hide studio UI", kbd: "Ctrl \\", isKbd: true, run: () => setUiHidden() });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.dash, label: "All projects dashboard", kbd: "Ctrl Shift P", isKbd: true, run: () => openDashboard(true) });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.plus, label: "New artboard", kbd: "", run: () => $("#add-artboard").click() });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.plus, label: "New page", kbd: "", run: () => api("POST", "/api/pages", {}) });
  const previewId = sel && S.nodes[sel] && !S.pages.includes(sel) ? screenOf(sel) : S.nodes[S.rootId].children[0];
  if (previewId) entries.push({ group: "Quick actions", icon: CMDK_ICONS.export, label: `Preview “${S.nodes[previewId].name}” in a new tab`, kbd: sel ? "P" : "", isKbd: Boolean(sel), run: () => openPreview(previewId) });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.export, label: "Export project (.zip)", kbd: "", run: () => downloadZip(S.id, "html") });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.undo, label: "Undo", kbd: "Ctrl Z", isKbd: true, run: () => api("POST", "/api/undo") });
  entries.push({ group: "Quick actions", icon: CMDK_ICONS.redo, label: "Redo", kbd: "Ctrl Shift Z", isKbd: true, run: () => api("POST", "/api/redo") });

  const pinMap = commentPinMap();
  const openComments = pageCommentsList().filter((x) => x.status !== "resolved" && !x.deletedInStep && S.nodes[x.nodeId]);
  openComments.forEach((c) => {
    const nm = S.nodes[c.nodeId]?.name || c.layerName || "Deleted layer";
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
    entries.push({ group: "Tools", icon: toolIcons[t], label, kbd: tool === t ? `Active · ${kbd}` : kbd, isKbd: tool !== t, run: () => setTool(t) });
  }

  for (const pid of S.pages) {
    const p = S.nodes[pid];
    if (!p) continue;
    entries.push({
      group: "Pages", icon: CMDK_ICONS.page, label: p.name, kbd: pid === S.rootId ? "Current page" : "Switch page",
      run: () => { if (pid !== S.rootId) api("POST", `/api/pages/${encodeURIComponent(pid)}/open`); },
    });
  }

  // Collect all layers & artboards on current page, then filter & slice for results
  const agentIds = new Set(agentNodes.map((a) => a.id));
  const curPageNum = String(Math.max(0, S.pages.indexOf(S.rootId)) + 1).padStart(2, "0");
  const visit = (id, abName) => {
    const n = S.nodes[id];
    if (!n) return;
    const isAb = n.parentId === S.rootId;
    const trail = isAb ? `${curPageNum} · Artboard` : `${curPageNum} · ${abName} · ${n.tag}`;
    entries.push({
      group: "Layers & artboards",
      icon: iconFor(n),
      label: n.name,
      kbd: trail,
      mcp: agentIds.has(id),
      search: `${n.name} ${n.tag} ${abName} ${n.text || ""}`.toLowerCase(),
      run: () => { if (S?.nodes[id]) { select(id); requestAnimationFrame(() => zoomCmd("selection")); } },
    });
    for (const c of n.children || []) visit(c, isAb ? n.name : abName);
  };
  for (const ab of S.nodes[S.rootId].children) visit(ab, S.nodes[ab]?.name || "");

  for (const pr of projects) {
    entries.push({
      group: "Projects", icon: CMDK_ICONS.dash, label: pr.name, kbd: pr.id === S.id ? "Open" : "Open project",
      run: () => { if (pr.id !== S.id) api("POST", `/api/projects/${encodeURIComponent(pr.id)}/open`); },
    });
  }
  return entries;
}

cmdkEl.addEventListener("pointerdown", (e) => { if (e.target === cmdkEl) openCmdk(false); });
$("#hud-cmdk").addEventListener("click", () => openCmdk(true));
$("#stage-pill").addEventListener("click", () => openCmdk(true));

// ---------------------------------------------------------------------------
// Dashboard (Paper-style Projects view)
// ---------------------------------------------------------------------------
const dashEl = $("#dashboard"), dashContent = $("#dash-content"), dashMenu = $("#dash-menu"), dashModal = $("#dash-modal");
let dashQuery = "", dashSort = "updated", dashView = localStorage.getItem("paper-lite:dash-view") || "grid";
const dashPreviews = new Map();

const applyDashViewSeg = () => document.querySelectorAll("[data-dash-view]").forEach((b) => b.classList.toggle("on", b.dataset.dashView === dashView));
applyDashViewSeg();

function closeDashMenu() {
  dashMenu.hidden = true;
  dashContent.querySelectorAll('[data-dash-menu][aria-expanded="true"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function openDashboard(open = dashEl.hidden) {
  dashEl.hidden = !open;
  closeDashMenu();
  if (open) {
    if (location.hash !== "#dashboard") history.replaceState(null, "", "#dashboard");
    renderDashboard();
    api("GET", "/api/activity").then((d) => {
      if (d?.sessions) { activitySessions = d.sessions; if (!dashEl.hidden) renderDashActivity(); }
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

async function loadThumb(thumbEl, p) {
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
  const list = projects.filter((p) => !q || p.name.toLowerCase().includes(q));
  if (dashSort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  else if (dashSort === "layers") list.sort((a, b) => (b.layers || 0) - (a.layers || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  else list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return list;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The dashboard's project grid / list, recent projects and activity feed are ui/src/components/dashboard/*.svelte.
// This keeps the header (counts, search, sort, view), the card menu, the dialog and thumbnail drawing (loadThumb),
// and its delegated click listeners still handle the cards (data-open-project, data-dash-menu, data-act-revert).
function dashModel() {
  return {
    list: sortedProjects(),
    view: dashView,
    query: dashQuery.trim(),
    recent: [...projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 4),
    sessions: activitySessions,
  };
}
function renderDashActivity() {
  window.weft.events.dispatchEvent(new Event("dashboard"));
}
function clearDashSearch() {
  dashQuery = ""; $("#dash-search").value = "";
  $("#dash-search-clear").hidden = true; $("#dash-search-kbd").hidden = false;
  renderDashboard();
}

function renderDashboard() {
  if (dashEl.hidden) return;
  $("#dash-count").textContent = String(projects.length);
  $("#dash-back-label").textContent = "Back to canvas";
  const totalLayers = projects.reduce((a, p) => a + (p.layers || 0), 0);
  const list = sortedProjects();
  $("#dash-heading").textContent = "All projects";
  $("#dash-summary").textContent = dashQuery.trim()
    ? `${plural(list.length, "matching project")} · ${projects.length} total`
    : `${plural(projects.length, "project")} · ${totalLayers.toLocaleString()} layers`;
  const mcpUrlEl = $("#dash-mcp-url");
  if (mcpUrlEl) mcpUrlEl.textContent = `${location.origin}/mcp`;
  window.weft.events.dispatchEvent(new Event("dashboard"));
}

// The dialog is ui/src/components/dashboard/DashDialog.svelte; this shows and hides it and holds its options.
let dashModalOpts = null;
function closeDashModal() {
  dashModal.hidden = true;
  dashModalOpts = null;
  window.weft.events.dispatchEvent(new Event("dash-modal"));
}

function openDashModal({ title, message = "", value = "", okText, danger = false, input = true, onOk }) {
  dashModalOpts = { title, message, value, okText, danger, input, onOk };
  dashModal.hidden = false;
  window.weft.events.dispatchEvent(new Event("dash-modal"));
}

async function openProjectFromDash(id) {
  if (id !== S?.id) await api("POST", `/api/projects/${encodeURIComponent(id)}/open`);
  openDashboard(false);
}

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

dashContent.addEventListener("click", (e) => {
  const menuBtn = e.target.closest("[data-dash-menu]");
  if (menuBtn) {
    e.stopPropagation();
    const pid = menuBtn.dataset.dashMenu;
    const p = projects.find((x) => x.id === pid);
    if (!p) return;
    closeDashMenu();
    menuBtn.setAttribute("aria-expanded", "true");
    dashMenu.dataset.pid = pid;
    window.weft.events.dispatchEvent(new Event("dash-menu")); // DashMenu.svelte
    const r = menuBtn.getBoundingClientRect();
    dashMenu.hidden = false;
    dashMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - 208, r.right - 200))}px`;
    dashMenu.style.top = `${Math.min(window.innerHeight - 200, r.bottom + 4)}px`;
    return;
  }
  const openEl = e.target.closest("[data-open-project]");
  if (openEl) openProjectFromDash(openEl.dataset.openProject);
});

dashMenu.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-dact]")?.dataset.dact;
  const pid = dashMenu.dataset.pid;
  const p = projects.find((x) => x.id === pid);
  closeDashMenu();
  if (!act || !p) return;
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
});

$("#dash-recent-list")?.addEventListener("click", (e) => {
  const row = e.target.closest("[data-open-project]");
  if (row) openProjectFromDash(row.dataset.openProject);
});
$("#dash-copy-mcp")?.addEventListener("click", () => {
  copyText(`claude mcp add --transport http weft ${location.origin}/mcp`, "Copied MCP command");
});
$("#dash-activity")?.addEventListener("click", async (e) => {
  const rb = e.target.closest("[data-act-revert]");
  if (rb) {
    const res = await api("POST", `/api/activity/${encodeURIComponent(rb.dataset.actRevert)}/revert`);
    if (res?.ok) toast("Reverted session to checkpoint");
  }
});

dashModal.addEventListener("pointerdown", (e) => { if (e.target === dashModal) closeDashModal(); });
document.addEventListener("pointerdown", (e) => { if (!dashMenu.hidden && !e.target.closest("#dash-menu, [data-dash-menu]")) closeDashMenu(); });
window.addEventListener("hashchange", () => openDashboard(location.hash === "#dashboard"));

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
const typing = (e) => e.target.matches?.("input, textarea, select") || e.target.isContentEditable;

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
  if (e.code === "Space" || e.key === " ") { e.preventDefault(); if (!spaceDown) { spaceDown = true; stage.classList.add("pan-ready"); } return; }
  if (mod && k === "z") { e.preventDefault(); return api("POST", e.shiftKey ? "/api/redo" : "/api/undo"); }
  if (mod && k === "y") { e.preventDefault(); return api("POST", "/api/redo"); }
  if (mod && k === "d") { e.preventDefault(); return duplicateSelected(); }
  if (mod && k === "c") { if (getSelection().toString()) return; e.preventDefault(); return copyExport("html", sel); }
  if (mod && (k === "=" || k === "+")) { e.preventDefault(); return zoomCmd("in"); }
  if (mod && k === "-") { e.preventDefault(); return zoomCmd("out"); }
  if (mod && k === "0") { e.preventDefault(); return zoomCmd("100"); }
  if (mod && e.key === "\\") { e.preventDefault(); return setUiHidden(); }
  if (mod || e.altKey) return;
  if (e.shiftKey && (e.code === "Digit1" || e.key === "!")) return zoomCmd("fit");
  if (e.shiftKey && (e.code === "Digit2" || e.key === "@" || e.key === '"')) return zoomCmd("selection");
  if (e.shiftKey && (e.code === "Digit0" || e.key === ")" || e.key === "=")) return zoomCmd("100");
  if (e.shiftKey && k === "g") { setSnap(!snapInput.checked); toast(snapInput.checked ? "Snap 8px on" : "Snap 8px off"); return; }
  if (e.shiftKey && k === "a" && sel) return toggleFlex(sel);
  if (!commentThreadEl.hidden && k === "escape") { e.preventDefault(); return closeCommentThread(); }
  const tools = { v: "select", h: "hand", f: "frame", r: "rect", t: "text", c: "comment" };
  if (!e.shiftKey && tools[k]) return setTool(tools[k]);
  if (!sel) return;
  if (!e.shiftKey && k === "p") return openPreview(sel);
  const n = S.nodes[sel];
  if (k === "delete" || k === "backspace") { e.preventDefault(); return removeSelected(); }
  if (k === "escape" || (k === "enter" && e.shiftKey)) return select(n.parentId === S.rootId ? null : n.parentId);
  if (k === "enter") { e.preventDefault(); if (isTextNode(sel)) return startEdit(sel); if (n.children[0]) select(n.children[0]); return; }
  const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
  if (arrows[k] && n.styles.position === "absolute") {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    patchStyles(sel, { left: num(n.styles.left) + arrows[k][0] * step, top: num(n.styles.top) + arrows[k][1] * step });
  }
});
document.addEventListener("keyup", (e) => { if (e.code === "Space" || e.key === " ") { spaceDown = false; stage.classList.remove("pan-ready"); } });
window.addEventListener("blur", () => { spaceDown = false; stage.classList.remove("pan-ready"); });

// ---------------------------------------------------------------------------
// Chrome: tools, zoom menu, misc buttons
// ---------------------------------------------------------------------------
$("#rail").addEventListener("click", (e) => {
  const b = e.target.closest(".tool");
  if (!b) return;
  if (b.dataset.cmd === "undo") return api("POST", "/api/undo");
  if (b.dataset.cmd === "redo") return api("POST", "/api/redo");
  if (b.dataset.cmd === "fit") return zoomCmd("fit");
  if (b.dataset.cmd === "cmdk") return openCmdk(true);
  if (b.dataset.tool) setTool(b.dataset.tool);
});
const exportMenu = $("#export-menu");
function countProjectLayers() {
  if (!S) return 0;
  const seen = new Set();
  for (const pid of S.pages || []) {
    const stack = [...(S.nodes[pid]?.children || [])];
    while (stack.length) {
      const nid = stack.pop();
      if (seen.has(nid) || !S.nodes[nid]) continue;
      seen.add(nid);
      for (const c of S.nodes[nid].children || []) stack.push(c);
    }
  }
  return seen.size;
}
// The menu's contents are ui/src/components/ExportMenu.svelte; it reads this when the menu opens.
function exportMenuModel() {
  if (!S) return null;
  const selNode = sel && S.nodes[sel];
  const root = S.nodes[S.rootId];
  return {
    sel: selNode ? { name: selNode.name, node: { tag: selNode.tag, styles: selNode.styles } } : null,
    page: `${root.name} · ${plural(root.children.length, "artboard")}`,
    project: `.zip · ${plural(S.pages.length, "page")} · ${plural(countProjectLayers(), "layer")}`,
    slug: S.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project",
  };
}
function exportAction(act, zipFmt) {
  if (act === "copy-sel-html") return copyExport("html", sel);
  if (act === "copy-sel-jsx") return copyExport("jsx", sel);
  if (act === "copy-page-html") return copyExport("html", null);
  if (act === "copy-page-jsx") return copyExport("jsx", null);
  if (act === "download-zip") return downloadZip(S?.id, zipFmt);
}
function openExportMenu(open = exportMenu.hidden) {
  if (open) openProjectMenu(false);
  exportMenu.hidden = !open;
  $("#export-btn").setAttribute("aria-expanded", String(open));
  if (open) window.weft.events.dispatchEvent(new Event("export-menu"));
}
$("#export-btn").addEventListener("click", () => openExportMenu());
document.addEventListener("pointerdown", (e) => { if (!exportMenu.hidden && !e.target.closest("#export-menu, #export-btn")) openExportMenu(false); });
$("#layer-filter").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation(); e.preventDefault();
    if (layerFilter) {
      layerFilter = ""; $("#layer-filter").value = "";
      $("#layer-filter-clear").hidden = true; $("#layer-filter-kbd").hidden = false;
      renderLayers();
    }
    $("#layer-filter").blur();
  }
});
$("#layer-filter").addEventListener("input", (e) => {
  layerFilter = e.target.value;
  $("#layer-filter-clear").hidden = !layerFilter;
  $("#layer-filter-kbd").hidden = Boolean(layerFilter);
  renderLayers();
});
$("#layer-filter-clear").addEventListener("click", () => {
  layerFilter = ""; $("#layer-filter").value = "";
  $("#layer-filter-clear").hidden = true; $("#layer-filter-kbd").hidden = false;
  renderLayers(); $("#layer-filter").focus();
});
// Hide UI keeps the canvas controls: the HUD button flips to "Show UI".
function setUiHidden(on = !app.classList.contains("ui-hidden")) {
  app.classList.toggle("ui-hidden", on);
  const b = $("#hud-hide-ui");
  b.textContent = on ? "Show UI" : "Hide UI";
  b.classList.toggle("show-ui-btn", on);
  b.title = on ? "Show UI (Ctrl+\\)" : "Hide UI (Ctrl+\\)";
  setTimeout(updateOverlay);
}
$("#show-ui").addEventListener("click", () => setUiHidden(false));
function setZoomMenuOpen(open) {
  $("#zoom-menu").hidden = !open;
  $("#zoom-btn").setAttribute("aria-expanded", String(open));
}
$("#zoom-btn").addEventListener("click", () => setZoomMenuOpen($("#zoom-menu").hidden));
$("#zoom-menu").addEventListener("click", (e) => { const b = e.target.closest("[data-zoom]"); if (!b) return; setZoomMenuOpen(false); zoomCmd(b.dataset.zoom); });
document.addEventListener("pointerdown", (e) => { if (!$("#zoom-menu").hidden && !e.target.closest("#zoom-menu, #zoom-btn")) setZoomMenuOpen(false); });
$("#hud-fit").addEventListener("click", () => zoomCmd("fit"));
$("#hud-hide-ui").addEventListener("click", () => setUiHidden());
$("#hide-ui").addEventListener("click", () => setUiHidden(true));
$("#add-artboard").addEventListener("click", () => {
  const b = worldBounds([...world.children]);
  createNode({ parentId: S.rootId, tag: "section", name: `Frame ${S.nodes[S.rootId].children.length + 1}`,
    styles: { left: b ? Math.round(b.x + b.w + 80) : 0, top: b ? Math.round(b.y) : 0 } });
});
window.addEventListener("resize", updateOverlay);
if (typeof ResizeObserver !== "undefined") new ResizeObserver(updateOverlay).observe(stage);

// ---------------------------------------------------------------------------
// Live sync (SSE)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Right panel tabs + History (labelled undo history and checkpoints)
// ---------------------------------------------------------------------------
let rightTab = localStorage.getItem("weft:right-tab") || "design";
let hist = { entries: [], cursor: -1, limit: 60, checkpoints: [] };
const historyEl = $("#history-panel");

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
  get showResolvedPins() { return showResolvedPins; },
  set showResolvedPins(on) { showResolvedPins = Boolean(on); renderCommentPins(); },
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
  fontFamilies: () => [...new Set([...fontLib.map((f) => f.family), ...GENERIC_FONTS])],
  // Toast (Toast.svelte), CSS variable suggestions (RootVars.svelte)
  toastModel: () => toastNow,
  toastAction: () => { $("#toast").classList.remove("show"); toastNow?.onAction?.(); },
  rootVarNames: () => (S ? Object.keys(rootOf().vars) : []),
  // Dashboard dialog and card menu (dashboard/DashDialog.svelte, DashMenu.svelte)
  dashModal: () => dashModalOpts,
  closeDashModal: () => closeDashModal(),
  dashMenuModel: () => ({ onlyProject: projects.length < 2 }),
  overlay: { labels: [], ctx: null, agents: { boxes: [], cursors: [] }, crumbs: { page: "Page 1", artboard: "" } },
};
function renderHistory() {
  window.weft.history = hist;
  window.weft.events.dispatchEvent(new Event("history"));
}

function setRightTab(tab) {
  if (!$(`#right-tabs [data-tab="${tab}"]`)) tab = "design";
  rightTab = tab;
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
  renderRightPanels?.();
}
let renderRightPanels = null; // extended by later tabs (comments)
$("#right-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setRightTab(b.dataset.tab); });

function connect() {
  const es = new EventSource("/events");
  const live = $("#live");
  es.addEventListener("open", () => { live.classList.add("live"); $("#live-text").textContent = "Live · synced"; if (S) shareSelection(); });
  es.addEventListener("error", () => { live.classList.remove("live"); $("#live-text").textContent = "Reconnecting…"; });
  // Events that change S are applied one at a time, so a resync (below) can't interleave with a patch.
  let syncChain = Promise.resolve();
  const serially = (fn) => { syncChain = syncChain.then(fn).catch((err) => console.error("[weft] sync", err)); };
  es.addEventListener("state", (ev) => serially(() => { const { source, state } = JSON.parse(ev.data); applyState(source, state); }));
  // Edits arrive as patches of changed nodes on top of a known version. If this tab missed one (or is on another
  // project), it reloads the whole document instead.
  es.addEventListener("patch", (ev) => serially(async () => {
    const p = JSON.parse(ev.data);
    if (!S || S.id !== p.id || S.version !== p.baseVersion) {
      if (S && S.id === p.id && p.version <= S.version) return; // already have this (e.g. after a resync)
      const full = await api("GET", "/api/state");
      if (full) applyState(p.source, full);
      return;
    }
    for (const [id, n] of Object.entries(p.nodes)) {
      if (n) S.nodes[id] = n;
      else delete S.nodes[id];
    }
    applyState(p.source, { ...S, version: p.version, name: p.name, pages: p.pages, rootId: p.rootId, rootCss: p.rootCss || S.rootCss });
  }));
  function applyState(source, state) {
    const prevProject = S?.id, prevKey = viewKey();
    S = state;
    if (!dashEl.hidden) $("#dash-back-label").textContent = "Back to canvas";
    if (source === "mcp") toast("Updated by agent (MCP)");
    if (viewKey() === prevKey) return render();
    if (prevProject && prevProject !== S.id) expanded.clear();
    sel = null; hoverId = null; pendingSel = pendingSel && S.nodes[pendingSel] ? pendingSel : null;
    const saved = localStorage.getItem(viewKey());
    if (saved) view = JSON.parse(saved);
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
    projects = JSON.parse(ev.data).projects || [];
    window.weft.events.dispatchEvent(new Event("projects"));
    if (!dashEl.hidden) renderDashboard();
  });
  es.addEventListener("activity", (ev) => {
    activitySessions = JSON.parse(ev.data).sessions || [];
    if (!dashEl.hidden) renderDashActivity();
  });
  es.addEventListener("fonts", (ev) => {
    const { fonts, v } = JSON.parse(ev.data);
    fontLib = fonts || [];
    renderFontList();
    if (v) { $("#fonts-css").href = `/fonts.css?v=${v}`; document.fonts?.ready.then(updateOverlay); }
    if (S && !sel) renderInspector();
  });
  es.addEventListener("presence", (ev) => {
    const data = JSON.parse(ev.data);
    agentNodes = data.nodes || [];
    agentCursors = data.agents || [];
    const st = $("#agent-status");
    st.textContent = agentNodes.length ? `MCP · ${agentNodes.length}` : "MCP · ready";
    st.classList.toggle("on", agentNodes.length > 0);
    const chip = $("#top-agent-chip");
    if (chip) {
      chip.hidden = agentNodes.length === 0;
      if (agentNodes.length) chip.textContent = `Agent editing ${plural(agentNodes.length, "layer")}`;
    }
    renderLayers();
    if (S) renderRightHead();
    if (!commentsPanelEl.hidden) renderCommentsPanel();
    updateOverlay();
    if (followAgent && agentNodes.length && S) {
      const now = Date.now();
      if (now - followTimer > 600) {
        followTimer = now;
        const els = agentNodes.map((a) => elOf(a.id)).filter(Boolean);
        if (els.length) requestAnimationFrame(() => fitTo(worldBounds(els), 2));
      }
    }
  });
  es.addEventListener("comments", (ev) => {
    const data = JSON.parse(ev.data);
    comments = data.comments || [];
    updateCommentsBadge();
    renderLayers();
    renderCommentPins();
    if (!commentsPanelEl.hidden) renderCommentsPanel();
    if (activeThreadId) renderCommentThread();
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
    if (!S) return;
    if (!ids || !ids.length) { pendingSel = null; sel = null; render(); return; }
    const id = ids[0];
    if (!id || !S.nodes[id]) return;
    pendingSel = id;
    render();
    if (zoom) requestAnimationFrame(() => fitTo(worldBounds(ids.map(elOf).filter(Boolean)), 2));
    toast("Agent selected a layer");
  });
}

$("#empty-onboarding")?.addEventListener("click", (e) => {
  const preset = e.target.closest("[data-onb-preset]")?.dataset.onbPreset;
  if (preset === "desktop") {
    return createNode({ parentId: S.rootId, tag: "section", name: "Desktop · 1440×900", styles: { left: 0, top: 0, width: 1440, height: 900, backgroundColor: "#ffffff" } });
  }
  if (preset === "mobile") {
    return createNode({ parentId: S.rootId, tag: "section", name: "Mobile · 390×844", styles: { left: 0, top: 0, width: 390, height: 844, backgroundColor: "#ffffff" } });
  }
  if (e.target.closest("#onb-copy-mcp")) {
    return copyText(`claude mcp add --transport http weft ${location.origin}/mcp`, "Copied MCP command");
  }
});

// ---------------------------------------------------------------------------
// Follow Agent + Agent Cursor click + Comments UI
// ---------------------------------------------------------------------------
const followBtn = $("#follow-agent-btn");
function setFollowAgent(on, notify = false) {
  followAgent = Boolean(on);
  localStorage.setItem("weft:follow-agent", followAgent ? "1" : "0");
  followBtn.classList.toggle("follow-on", followAgent);
  followBtn.setAttribute("aria-pressed", String(followAgent));
  if (notify && !followAgent) toast("Follow agent paused");
}
setFollowAgent(followAgent);
followBtn.addEventListener("click", () => {
  setFollowAgent(!followAgent);
  toast(followAgent ? "Following agent" : "Follow agent off");
});
$("#agents").addEventListener("click", (e) => {
  const cur = e.target.closest("[data-agent-node]");
  if (!cur) return;
  const nid = cur.dataset.agentNode;
  if (S?.nodes[nid]) { select(nid); zoomCmd("selection"); }
});

function updateCommentsBadge() {
  const openCount = pageCommentsList().filter((c) => c.status !== "resolved").length;
  const b = $("#comments-tab-count");
  if (b) { b.textContent = String(openCount); b.hidden = openCount === 0; }
}

// The pins and the thread popover are ui/src/components/comments/*.svelte. This script decides which thread is open
// and where things sit on the stage (it owns the canvas DOM and view), and tells them when to re-read that.
function commentPins() {
  if (!S) return [];
  const pinMap = commentPinMap();
  return pageCommentsList().filter((c) => S.nodes[c.nodeId] && (showResolvedPins || c.status !== "resolved")).flatMap((c) => {
    const el = elOf(c.nodeId);
    if (!el) return [];
    const r = rectOnStage(el);
    return [{ id: c.id, status: c.status, sel: activeThreadId === c.id, x: Math.round(r.x), y: Math.round(r.y), title: S.nodes[c.nodeId].name, pin: String(pinMap.get(c.id) || "") }];
  });
}
function renderCommentPins() {
  if (!S) return;
  window.weft.events.dispatchEvent(new Event("comment-pins"));
  if (activeThreadId || draftCommentNodeId) positionCommentThread();
}

function positionCommentThread() {
  const nid = draftCommentNodeId || comments.find((c) => c.id === activeThreadId)?.nodeId;
  const el = nid && elOf(nid);
  if (!el) {
    commentThreadEl.style.left = "24px";
    commentThreadEl.style.top = "24px";
    return;
  }
  const r = rectOnStage(el);
  const left = Math.max(16, Math.min(stage.clientWidth - 376, r.x + 18));
  const top = Math.max(16, Math.min(stage.clientHeight - 360, r.y + 18));
  commentThreadEl.style.left = `${Math.round(left)}px`;
  commentThreadEl.style.top = `${Math.round(top)}px`;
}

function closeCommentThread() {
  activeThreadId = null;
  draftCommentNodeId = null;
  commentThreadEl.hidden = true;
  renderCommentThread();
  renderCommentPins();
}

function openNewComment(nodeId) {
  if (!S?.nodes[nodeId]) return;
  activeThreadId = null;
  draftCommentNodeId = nodeId;
  renderCommentThread();
  commentThreadEl.hidden = false;
  positionCommentThread();
  commentThreadEl.querySelector("textarea")?.focus();
}

async function openCommentThread(id) {
  const c = comments.find((x) => x.id === id);
  if (!c) return closeCommentThread();
  const cPage = commentPageId(c);
  if (S && cPage && cPage !== S.rootId) {
    const ok = await api("POST", `/api/pages/${encodeURIComponent(cPage)}/open`);
    if (ok && S) { S.rootId = cPage; render(); }
  }
  draftCommentNodeId = null;
  activeThreadId = id;
  if (S?.nodes[c.nodeId]) {
    select(c.nodeId);
    requestAnimationFrame(() => fitTo(worldBounds([elOf(c.nodeId)].filter(Boolean)), 2));
  }
  renderCommentThread();
  commentThreadEl.hidden = false;
  positionCommentThread();
  renderCommentPins();
}

function commentThread() {
  if (!activeThreadId && !draftCommentNodeId) return null;
  const isNew = Boolean(draftCommentNodeId);
  const c = isNew ? { nodeId: draftCommentNodeId, status: "open", agentsCanSee: true, messages: [] } : comments.find((x) => x.id === activeThreadId);
  if (!c) return null;
  const node = S?.nodes?.[c.nodeId];
  return {
    key: isNew ? `new:${draftCommentNodeId}` : `t:${activeThreadId}`,
    id: c.id,
    isNew,
    resolved: c.status === "resolved",
    agentsCanSee: c.agentsCanSee !== false,
    layerName: node?.name || c.layerName || "Deleted layer",
    icon: node ? iconFor(node) : "",
    messages: (c.messages || []).map((m) => {
      const isAi = m.author !== "you";
      return {
        isAi,
        initial: isAi ? (m.author || "C")[0].toUpperCase() : "Y",
        author: isAi ? m.author : "You",
        clock: clock(m.at),
        text: m.text,
        link: m.linkedStep ? { label: `${m.linkedStep.label}${m.linkedStep.step ? ` · step ${m.linkedStep.step}` : ""}`, historyId: m.linkedStep.historyId } : null,
      };
    }),
  };
}
function renderCommentThread() {
  if ((activeThreadId || draftCommentNodeId) && !commentThread()) return closeCommentThread();
  window.weft.events.dispatchEvent(new Event("comment-thread"));
}

// Called by the composer with what was typed; true when it was saved (so the composer clears).
async function submitComment(text, agentsCanSee) {
  if (draftCommentNodeId) {
    const created = await api("POST", "/api/comments", { nodeId: draftCommentNodeId, text, agentsCanSee });
    if (!created) return false;
    if (!comments.some((x) => x.id === created.id)) comments = [...comments, created];
    draftCommentNodeId = null;
    activeThreadId = created.id;
  } else if (activeThreadId) {
    const res = await api("POST", `/api/comments/${encodeURIComponent(activeThreadId)}/reply`, { text, agentsCanSee });
    if (!res) return false;
    comments = comments.map((x) => (x.id === res.id ? res : x));
  } else return false;
  updateCommentsBadge();
  renderLayers();
  renderCommentPins();
  renderCommentsPanel();
  renderCommentThread();
  return true;
}

commentThreadEl.addEventListener("pointerdown", (e) => e.stopPropagation());
// The Comments tab is ui/src/components/CommentsPanel.svelte; it asks for these rows (via window.weft) whenever
// renderCommentsPanel() says they changed.
function commentRows() {
  if (!S) return [];
  const pinMap = commentPinMap();
  const agentIds = new Set(agentNodes.map((a) => a.id));
  return pageCommentsList().map((c) => {
    const node = S.nodes[c.nodeId];
    const orphan = !node;
    const lastMsg = c.messages?.[c.messages.length - 1];
    const linkedCount = (c.messages || []).filter((m) => m.linkedStep).length;
    const resolvedClock = c.resolvedAt || lastMsg?.at || c.createdAt;
    const statusText = c.status === "replied"
      ? `${lastMsg?.author || "Claude"} replied`
      : c.status === "read"
        ? `Read ${clock(c.readAt)}`
        : c.status === "resolved"
          ? `Resolved${resolvedClock ? ` ${clock(resolvedClock)}` : ""}`
          : `Waiting · ${ago(c.createdAt).replace(" ago", "")}`;
    return {
      id: c.id,
      status: c.status,
      orphan,
      layerTitle: node?.name || c.layerName || "Deleted layer",
      statusText,
      pin: orphan ? "?" : c.status === "resolved" ? null : String(pinMap.get(c.id) || ""),
      preview: lastMsg?.text || "",
      meta: orphan
        ? (c.deletedInStep ? `Removed in step ${c.deletedInStep}` : "Layer removed")
        : `${plural(c.messages?.length || 0, "message")}${linkedCount ? ` · ${plural(linkedCount, "linked change")}` : ""}${c.status !== "resolved" && agentIds.has(c.nodeId) ? " · agent working" : ""}`,
    };
  });
}
function renderCommentsPanel() {
  if (!S || commentsPanelEl.hidden) return;
  window.weft.events.dispatchEvent(new Event("comments"));
}

renderRightPanels = () => {
  commentsPanelEl.hidden = rightTab !== "comments";
  if (rightTab === "comments") renderCommentsPanel();
};

setTool("select");
applyView();
setRightTab(rightTab);
connect();
// Opened at /#dashboard: show it once everything above (including window.weft) is set up.
if (location.hash === "#dashboard") openDashboard(true);
document.fonts?.ready.then(updateOverlay);
window.addEventListener("load", setupInteract);

// Read-only handles on the editor state for the browser tests and the devtools console (this module's top-level
// names are not globals).
for (const [name, get] of Object.entries({
  S: () => S, sel: () => sel, tool: () => tool, view: () => view, hoverId: () => hoverId, editingId: () => editingId,
  busy: () => busy, pendingRender: () => pendingRender, activeThreadId: () => activeThreadId, projects: () => projects,
  comments: () => comments,
})) Object.defineProperty(window, name, { get, configurable: true });
Object.assign(window, { app, stage, api, toast, render, select, setTool, openDashboard, openNewComment, renderCommentPins });
