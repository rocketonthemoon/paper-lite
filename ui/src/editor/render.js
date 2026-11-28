// Canvas rendering: the root CSS and per-artboard stylesheets, the keyed DOM sync of the design tree (only
// changed nodes are rebuilt), the view transform and grid, and the measurements the overlay components draw
// (labels, context bar, agents; ../components/canvas) plus the layer rows for the Layers panel.
import { ed } from "./state.js";
import { $, GRID, SVG_NS, SVG_TAGS, VOID_TAGS, app, commentsPanelEl, elOf, expanded, isArtboard, isDarkColor, isTextNode, markSelected, px, selectedIds, stage, viewKey, world } from "./core.js";
import { renderInspector } from "./inspector.js";
import { shareSelection, startEdit } from "./selection.js";
import { renderPages } from "./pages.js";
import { renderCommentPins, renderCommentsPanel, updateCommentsBadge } from "./comments.js";

// Root CSS: one project-wide stylesheet (variables, classes, states, @media, nesting), parsed and serialised by
// /root-css.js exactly like on the server. The canvas renders it as a real stylesheet scoped to the world, with each
// layer's own styles as a rule between the base classes and the state / media / nested rules, the same cascade as
// the exported components.css. Layer classes are prefixed (wc-card) so they can't pick up the editor's own CSS.
export const rootOf = () => ed.S?.rootCss || { vars: {}, rules: [] };
export const definedClassList = () => WeftRootCss.definedClasses(rootOf());
export const baseStylesOf = (name) => Object.assign({}, ...rootOf().rules.filter((r) => !r.media && r.selector === `.${name}`).map((r) => r.styles));
export const rulesUsing = (name) => rootOf().rules.filter((r) => WeftRootCss.classesIn(r.selector).includes(name) && !(WeftRootCss.isBase(r) && r.selector === `.${name}`));
// The inspector sits outside the canvas, so swatches resolve var(--x) themselves.
export const resolveVars = (v, depth = 0) => (depth > 8 ? String(v ?? "") : String(v ?? "").replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g,
  (m, name, fb) => (name in rootOf().vars ? resolveVars(rootOf().vars[name], depth + 1) : fb?.trim() || m)));
export const kebabCss = (k) => WeftRootCss.kebab(k);
export const classUsage = (name) => Object.values(ed.S?.nodes || {}).filter((n) => n.classes?.includes(name)).length;

function scopedSheet(key) {
  let el = document.getElementById(key);
  if (!el) { el = document.createElement("style"); el.id = key; document.head.append(el); }
  return el;
}
// Layers under the given roots, as [id, own styles] for the canvas stylesheet.
export function layerStyleList(nodes, rootIds) {
  const out = [];
  const walk = (id) => { const n = nodes[id]; if (!n) return; out.push([id, n.styles]); (n.children || []).forEach(walk); };
  rootIds.forEach(walk);
  return out;
}

// Styles come from the canvas stylesheet (see renderCanvasCss); elements only carry their id and classes.
export function buildNodeEl(nodes, id) {
  const n = nodes[id];
  if (!n) return document.createElement("div");
  const svg = SVG_TAGS.has(n.tag);
  const el = svg ? document.createElementNS(SVG_NS, n.tag) : document.createElement(n.tag);
  el.dataset.nodeId = id;
  for (const c of n.classes || []) el.classList.add(`${WeftRootCss.CANVAS_PREFIX}${c}`);
  if (svg) { for (const [k, v] of Object.entries(n.attrs || {})) el.setAttribute(k, v); (n.children || []).forEach((c) => el.append(buildNodeEl(nodes, c))); return el; }
  for (const [k, v] of Object.entries(n.attrs || {})) el.setAttribute(k, v);
  if (n.tag === "button") el.type = "button";
  if (n.tag === "a" || n.tag === "button" || n.attrs?.tabindex !== undefined) el.tabIndex = -1; // canvas layers never take focus; exports keep tabindex
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
export const markStale = (el) => { if (el) builtFrom.delete(el); };

export function setViewportOverride(id, width) {
  if (!id) return;
  if (width && Number.isFinite(Number(width)) && Number(width) > 0) ed.viewportOverrides[id] = Math.round(Number(width));
  else delete ed.viewportOverrides[id];
  render();
}

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
  if (n.tag === "a" || n.tag === "button" || n.attrs?.tabindex !== undefined) el.tabIndex = -1; // canvas layers never take focus; exports keep tabindex
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
  for (const ab of ed.S.nodes[ed.S.rootId].children) {
    const key = `canvas-css-ab-${ab}`;
    let el = document.getElementById(key);
    if (!el) { el = document.createElement("style"); el.id = key; el.dataset.artboardCss = "1"; tailEl.before(el); }
    const css = WeftRootCss.layerCss(layerStyleList(ed.S.nodes, [ab]), "#world", (id) => `.${NODE_CLASS}${id}`);
    if (el.textContent !== css) el.textContent = css;
    keep.add(el);
  }
  for (const el of document.querySelectorAll("style[data-artboard-css]")) if (!keep.has(el)) el.remove();
  if (tailEl.textContent !== tail) tailEl.textContent = tail;
}

export function render() {
  if (!ed.S) return;
  if (ed.editingId || ed.busy || ed.pointerHeld) { ed.pendingRender = true; return; }
  ed.pendingRender = false;
  if (ed.pendingSel && ed.S.nodes[ed.pendingSel]) { ed.sel = ed.pendingSel; ed.pendingSel = null; ed.multi = []; shareSelection(); }
  if (ed.pendingMulti && ed.pendingMulti.every((id) => ed.S.nodes[id])) {
    ed.multi = ed.pendingMulti.length > 1 ? ed.pendingMulti : [];
    ed.sel = ed.pendingMulti[ed.pendingMulti.length - 1] ?? null;
    ed.pendingMulti = null;
    shareSelection();
  }
  // Layers deleted (here or by an agent) leave the selection.
  if (ed.multi.length) {
    ed.multi = ed.multi.filter((id) => ed.S.nodes[id]);
    if (ed.multi.length < 2) { ed.sel = ed.multi[0] ?? null; ed.multi = []; }
    else if (!ed.multi.includes(ed.sel)) ed.sel = ed.multi[ed.multi.length - 1];
  }
  if (ed.sel && !ed.S.nodes[ed.sel]) ed.sel = null;
  if (ed.hoverId && !ed.S.nodes[ed.hoverId]) ed.hoverId = null;
  stage.style.background = ed.S.nodes[ed.S.rootId].styles.backgroundColor || "";
  updateGrid();
  $("#stage-page-name").textContent = ed.S.nodes[ed.S.rootId].name || "Page 1";
  renderPages();
  renderCanvasCss();
  window.weft.events.dispatchEvent(new Event("root-vars")); // RootVars.svelte
  syncChildEls(ed.S.nodes, ed.S.nodes[ed.S.rootId].children, world, world);
  for (const abId of ed.S.nodes[ed.S.rootId].children) {
    const el = elOf(abId);
    if (!el) continue;
    const vw = ed.viewportOverrides[abId];
    if (vw) el.style.width = `${vw}px`;
    else el.style.removeProperty("width");
  }
  const onb = $("#empty-onboarding");
  if (onb) {
    const isEmpty = ed.S.nodes[ed.S.rootId].children.length === 0;
    onb.hidden = !isEmpty;
    if (isEmpty) {
      const pgName = ed.S.nodes[ed.S.rootId].name || "Page 1";
      $("#onb-desc").textContent = `Create a screen preset below, press F to draw a frame, or let Claude Code write HTML directly to ${pgName}.`;
      $("#onb-mcp-cmd").textContent = `claude mcp add --transport http weft ${location.origin}/mcp`;
    }
  }
  markSelected();
  updateCommentsBadge();
  renderLayers();
  renderInspector();
  if (!commentsPanelEl.hidden) renderCommentsPanel();
  updateOverlay();
  if (ed.pendingEdit && elOf(ed.pendingEdit)) { const id = ed.pendingEdit; ed.pendingEdit = null; startEdit(id); }
}

export function applyView() {
  world.style.transform = `translate(${ed.view.x}px, ${ed.view.y}px) scale(${ed.view.z})`;
  updateGrid();
  $("#zoom-btn").textContent = `${Math.round(ed.view.z * 100)}%`;
  if (viewKey()) localStorage.setItem(viewKey(), JSON.stringify(ed.view));
  updateOverlay();
}

// Keep the snap grid aligned with world coordinates as you pan and zoom.
function updateGrid() {
  const st = app.style, z = ed.view.z;
  st.setProperty("--grid-size", `${GRID * z}px`);
  st.setProperty("--grid-major-size", `${GRID * 8 * z}px`);
  st.setProperty("--grid-x", `${ed.view.x}px`);
  st.setProperty("--grid-y", `${ed.view.y}px`);
  st.setProperty("--grid-line", `${1 / z}px`); // artboard grids live in zoomed world space
  const dark = ed.S && isDarkColor(ed.S.nodes[ed.S.rootId]?.styles.backgroundColor);
  const showMinor = GRID * z >= 6; // 8px cells closer than 6 screen px turn into noise
  st.setProperty("--grid-major", dark ? "rgba(255, 255, 255, 0.14)" : "rgba(10, 11, 13, 0.12)");
  st.setProperty("--grid-minor", showMinor ? (dark ? "rgba(255, 255, 255, 0.06)" : "rgba(10, 11, 13, 0.05)") : "transparent");
  st.setProperty("--grid-ab-minor", showMinor ? "rgba(0, 0, 255, 0.07)" : "transparent");
}

export function rectOnStage(el) {
  const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
}

// Layout size in canvas px. SVG shapes (svg, circle, path, …) have no offsetWidth/offsetHeight, so fall back to
// their rendered box divided by the zoom.
export function layoutSize(el) {
  if (el.offsetWidth !== undefined) return { w: el.offsetWidth, h: el.offsetHeight };
  const r = el.getBoundingClientRect(), z = ed.view.z || 1;
  return { w: r.width / z, h: r.height / z };
}

export function placeBox(box, r) {
  if (!r) { box.style.display = "none"; return; }
  Object.assign(box.style, { display: "block", left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
}

function nodePageId(nid) {
  let n = ed.S?.nodes?.[nid];
  while (n?.parentId && ed.S.nodes[n.parentId]) n = ed.S.nodes[n.parentId];
  return n && ed.S.pages?.includes(n.id) ? n.id : null;
}
export function commentPageId(c) {
  return nodePageId(c.nodeId) || c.pageId || ed.S?.rootId || null;
}
export function pageCommentsList() {
  if (!ed.S) return [];
  return ed.comments.filter((c) => commentPageId(c) === ed.S.rootId);
}
export function commentPinMap() {
  const map = new Map();
  let numIdx = 0;
  for (const c of pageCommentsList()) {
    if (c.status !== "resolved" && ed.S.nodes[c.nodeId]) {
      numIdx += 1;
      map.set(c.id, numIdx);
    }
  }
  return map;
}

// The overlay's labels, context-bar contents, agent boxes and cursors, and the breadcrumb are
// ui/src/components/canvas/*.svelte. This measures where everything sits (it owns the canvas DOM and view), hands that
// over as window.weft.overlay, and still places the selection and hover boxes and the context bar itself.
export function updateOverlay() {
  if (!ed.S || !window.weft) return;
  const selected = new Set(selectedIds());
  const hug = (v) => (!v || v === "auto" || v === "fit-content" ? "Hug" : px(v));
  const labels = ed.S.nodes[ed.S.rootId].children.flatMap((id) => {
    const el = elOf(id);
    if (!el) return [];
    const r = rectOnStage(el), st = ed.S.nodes[id].styles;
    const vp = ed.viewportOverrides[id] || null;
    const wLabel = vp ? `${vp}px` : hug(st.width);
    const dim = r.w > 180 || vp ? `${wLabel} × ${hug(st.height)} · ${Math.round(ed.view.z * 100)}%` : "";
    return [{ id, name: ed.S.nodes[id].name, dim, vp, sel: selected.has(id), x: r.x, y: r.y - 20, maxW: Math.max(40, r.w) }];
  });
  const selEl = ed.sel && elOf(ed.sel);
  // Several layers: the selection box goes around all of them (no resize handles), and each gets its own outline.
  const multiRects = ed.multi.length ? ed.multi.map((id) => elOf(id)).filter(Boolean).map(rectOnStage) : [];
  const unionOf = (rs) => {
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    return { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) - x0, h: Math.max(...rs.map((r) => r.y + r.h)) - y0 };
  };
  const selRect = multiRects.length ? unionOf(multiRects) : selEl ? rectOnStage(selEl) : null;
  const selNode = ed.sel && ed.S.nodes[ed.sel];
  const onStage = selRect && selRect.x + selRect.w > 0 && selRect.x < stage.clientWidth && selRect.y + selRect.h > 44 && selRect.y < stage.clientHeight;
  const showCtx = Boolean(onStage && selNode && !ed.multi.length && !ed.busy && !ed.editingId && ed.tool === "select");
  const ctx = showCtx ? {
    name: selNode.name,
    preview: isArtboard(ed.sel), // screens only; layers preview from the inspector header or P
    canFlex: !VOID_TAGS.has(selNode.tag) && !SVG_TAGS.has(selNode.tag),
    isFlex: selNode.styles.display === "flex" || selNode.styles.display === "inline-flex",
  } : null;
  const boxes = ed.agentNodes.flatMap(({ id }) => {
    const el = elOf(id);
    if (!el) return [];
    const r = rectOnStage(el);
    return [{ x: r.x - 9, y: r.y - 9, w: r.w + 18, h: r.h + 18 }];
  });
  const cursors = ed.agentCursors.flatMap((c) => {
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
  const root = ed.S.nodes[ed.S.rootId];
  let ab = ed.sel && ed.S.nodes[ed.sel];
  while (ab && ab.parentId !== ed.S.rootId) ab = ed.S.nodes[ab.parentId];
  const abNode = ab || ed.S.nodes[root.children[0]];
  const crumbs = { page: root.name || "Page 1", artboard: abNode ? abNode.name : (root.children.length ? "" : "Empty canvas") };
  window.weft.overlay = { labels, ctx, agents: { boxes, cursors }, crumbs };
  window.weft.events.dispatchEvent(new Event("overlay"));

  placeBox($("#sel-box"), selRect);
  $("#sel-box").classList.toggle("multi", multiRects.length > 0);
  if (multiRects.length) $("#sel-size").textContent = `${ed.multi.length} layers`;
  else if (selEl) { const { w, h } = layoutSize(selEl); $("#sel-size").textContent = `${Math.round(w)} × ${Math.round(h)}`; }
  const outlines = $("#multi-boxes");
  while (outlines.children.length > multiRects.length) outlines.lastChild.remove();
  while (outlines.children.length < multiRects.length) outlines.append(Object.assign(document.createElement("span"), { className: "multi-box" }));
  multiRects.forEach((r, i) => placeBox(outlines.children[i], r));
  // Contextual quick-action bar above the selection (kept clear of the artboard label, pill and HUD), placed after
  // its contents are rendered so its size is known.
  const ctxBar = $("#ctx-bar");
  if (showCtx) {
    ctxBar.style.display = "flex";
    const abOffset = isArtboard(ed.sel) ? 24 : 8;
    const bw = ctxBar.offsetWidth || 260, bh = ctxBar.offsetHeight || 30;
    ctxBar.style.left = `${Math.max(12, Math.min(Math.max(12, stage.clientWidth - bw - 12), selRect.x))}px`;
    ctxBar.style.top = `${Math.max(48, Math.min(Math.max(48, stage.clientHeight - bh - 68), selRect.y - bh - abOffset))}px`;
  } else {
    ctxBar.style.display = "none";
  }
  renderCommentPins();
  const hovEl = ed.hoverId && ed.hoverId !== ed.sel && elOf(ed.hoverId);
  placeBox($("#hover-box"), hovEl ? rectOnStage(hovEl) : null);
}

export const ICONS = {
  frame: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4.5 1v14M11.5 1v14M1 4.5h14M1 11.5h14"/></svg>`,
  text: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4h9M8 4v8.5M6 12.5h4"/></svg>`,
  row: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3 3v8M7 3v8M11 3v8"/></svg>`,
  col: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3 3h8M3 7h8M3 11h8"/></svg>`,
  box: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3" width="10" height="8" rx="1.5"/></svg>`,
  vec: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5 14 4v4.5c0 3.3-2.6 5.4-6 6.5-3.4-1.1-6-3.2-6-6.5V4z"/></svg>`,
  img: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M2 12l4-4 3 3 2-2 3 3"/></svg>`,
};
export function iconFor(n) {
  if (n.parentId === ed.S.rootId) return ICONS.frame;
  if (n.tag === "img") return ICONS.img;
  if (SVG_TAGS.has(n.tag)) return ICONS.vec;
  if (isTextNode(n.id)) return ICONS.text;
  if (n.styles.display === "flex") return n.styles.flexDirection === "column" ? ICONS.col : ICONS.row;
  return ICONS.box;
}
// The tree is ui/src/components/LayersPanel.svelte. This builds its rows (it needs the editor's state: selection,
// expanded artboards, agents, comments) and hands them over through window.weft.
export function layerRows() {
  const selected = new Set(selectedIds());
  if (!ed.S) return { rows: [], filtered: false };
  for (let p = ed.sel && ed.S.nodes[ed.sel]?.parentId; p && p !== ed.S.rootId; p = ed.S.nodes[p]?.parentId) expanded.add(p);
  const agentIds = new Set(ed.agentNodes.map((a) => a.id));
  const q = ed.layerFilter.trim().toLowerCase();
  const rows = [];
  const row = (id, n, depth, twist) => {
    const open = ed.comments.filter((c) => c.nodeId === id && c.status !== "resolved");
    rows.push({
      id,
      name: n.name,
      depth,
      twist, // "open" | "closed" | "none"
      draggable: !q,
      artboard: n.parentId === ed.S.rootId,
      sel: selected.has(id),
      agent: agentIds.has(id),
      icon: iconFor(n),
      dim: n.parentId === ed.S.rootId ? `${px(n.styles.width || "auto")}×${px(n.styles.height || "auto")}` : null,
      comments: open.length ? { count: open.length, replied: open.some((c) => c.status === "replied") } : null,
    });
  };
  if (q) {
    const match = (n) => n.name.toLowerCase().includes(q) || n.tag.toLowerCase().includes(q) || (n.text && n.text.toLowerCase().includes(q));
    const visit = (id) => {
      const n = ed.S.nodes[id];
      if (!n) return;
      if (match(n)) row(id, n, 0, "none");
      n.children.forEach(visit);
    };
    ed.S.nodes[ed.S.rootId].children.forEach(visit);
  } else {
    const walk = (id, depth) => {
      const n = ed.S.nodes[id];
      const has = n.children.length > 0;
      const open = expanded.has(id);
      row(id, n, depth, has ? (open ? "open" : "closed") : "none");
      if (has && open) n.children.forEach((c) => walk(c, depth + 1));
    };
    ed.S.nodes[ed.S.rootId].children.forEach((c) => walk(c, 0));
  }
  return { rows, filtered: Boolean(q) };
}
export function renderLayers() {
  if (!ed.S) return;
  window.weft.events.dispatchEvent(new Event("layers"));
}
