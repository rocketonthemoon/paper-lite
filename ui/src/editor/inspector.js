// Inspector (right panel, Design tab): the models its Svelte components render (../components/inspector)
// and what their fields and buttons do: Inspector.svelte and RightHead.svelte pass their events to the functions
// below (inspectorChange, inspectorKeydown, inspectorAction, …).
import { ed } from "./state.js";
import { $, api, elOf, inspector, inspectorFoot, num, patch, patchStyles, toast } from "./core.js";
import { classUsage, definedClassList, rootOf } from "./render.js";
import { duplicateSelected, removeSelected } from "./selection.js";
import { zoomCmd } from "./view.js";
import { fontStack, uploadFonts } from "./fonts.js";
import { openNewComment } from "./comments.js";

// The inspector's fields are rendered by ui/src/components/inspector/*.svelte (same data-* attributes as before);
// the listeners below still apply what is typed or clicked.
export const hex6 = (v) => {
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
export function rightHeadModel() {
  if (!ed.S) return null;
  const n = ed.sel && ed.S.nodes[ed.sel];
  if (n) return { kind: n.parentId === ed.S.rootId ? "artboard" : "layer", name: n.name, agent: ed.agentNodes.some((a) => a.id === n.id) };
  const root = ed.S.nodes[ed.S.rootId];
  let layers = 0;
  const count = (id) => { layers += 1; (ed.S.nodes[id]?.children || []).forEach(count); };
  root.children.forEach(count);
  return { kind: "page", name: root.name, artboards: root.children.length, layers };
}
export function renderRightHead() {
  window.weft.events.dispatchEvent(new Event("right-head"));
}

// Placement stays on the layer; everything else can become a shared class.
const PLACEMENT = new Set(["position", "left", "top", "right", "bottom", "zIndex"]);
export const classableStyles = (n) => Object.fromEntries(Object.entries(n.styles || {}).filter(([k]) => !PLACEMENT.has(k)));

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
  const n = ed.S.nodes[id];
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

export function renderInspector(force = false) {
  if (!ed.S) return;
  const a = document.activeElement;
  if (!force && inspector.contains(a) && a.matches("input:not([type=checkbox]):not([type=color]), textarea, select")) { ed.inspectorDirty = true; return; }
  ed.inspectorDirty = false;
  renderRightHead();
  // Copy actions live in the context bar and the Export menu; the footer stays empty.
  inspectorFoot.hidden = true;
  inspectorFoot.innerHTML = "";
  window.weft.events.dispatchEvent(new CustomEvent("inspector", { detail: { force } }));
}

// What the inspector components show (see ui/src/components/inspector/Inspector.svelte).
export function inspectorModel() {
  if (!ed.S) return null;
  const n = ed.sel && ed.S.nodes[ed.sel];
  return {
    node: n || null,
    artboard: Boolean(n && n.parentId === ed.S.rootId),
    page: ed.S.nodes[ed.S.rootId],
    cssJsonOpen: ed.cssJsonOpen,
    fontLib: ed.fontLib,
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
// Escape leaves a field without saving: blurring it would fire "change", so that one change is ignored.
let cancellingField = null;
const STEP_KEYS = new Set(["left", "top", "width", "height", "fontSize", "borderRadius", "gap", "padding", "opacity"]);

// Preview: the screen (artboard) a layer belongs to, opened as a live page in its own browser tab.
export function screenOf(id) {
  let n = ed.S?.nodes[id];
  while (n && n.parentId && !ed.S.pages.includes(n.parentId)) n = ed.S.nodes[n.parentId];
  return n && ed.S.pages.includes(n.parentId) ? n.id : null;
}
export function openPreview(id) {
  const ab = screenOf(id);
  if (!ab) return toast("Select a screen to preview");
  const w = window.open(`/preview/${encodeURIComponent(ab)}`, "_blank");
  if (!w) return toast("The browser blocked the preview tab; allow pop-ups for weft and try again", { ms: 5000 });
  w.opener = null; // the preview never needs to reach back into the editor
  toast(`Previewing ${ed.S.nodes[ab].name} in a new tab`);
}

// One flex toggle for the context bar, inspector and Shift+A: removing flex clears every flex-only property.
const UNFLEX = { display: null, flexDirection: null, justifyContent: null, alignItems: null, gap: null, flexWrap: null };
export function toggleFlex(id) {
  const st = ed.S.nodes[id].styles;
  const isFlex = st.display === "flex" || st.display === "inline-flex";
  return patchStyles(id, isFlex ? UNFLEX : { display: "flex", flexDirection: st.flexDirection || "column", gap: st.gap || 8 });
}

export async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  toast(msg);
}

export async function copyExport(format, nodeId) {
  const q = new URLSearchParams({ format });
  if (nodeId) q.set("nodeId", nodeId);
  const code = await api("GET", `/api/export?${q}`);
  if (typeof code === "string") copyText(code, format === "jsx" ? "Copied JSX" : "Copied HTML + CSS");
}

export async function downloadZip(projectId = ed.S?.id, format = "html") {
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

// Typing in a color picker previews the color on its swatch and in the text field next to it.
export function inspectorInput(e) {
  if (e.target.matches('.swatch input[type="color"]')) {
    const sw = e.target.closest(".swatch");
    const txt = e.target.closest(".fld")?.querySelector('input:not([type="color"])');
    if (sw) { sw.classList.remove("empty"); sw.style.background = e.target.value; }
    if (txt) txt.value = e.target.value;
  }
}

// A field was committed (Enter, blur, a select or checkbox change): save it to the selected layer or the page.
export function inspectorChange(e) {
  const t = e.target;
  if (t === cancellingField) return;
  if (t.id === "font-file") return uploadFonts([...t.files]);
  if (t.id === "google-family") return;
  if (t.id === "css-json") return;
  if (t.dataset.page) return patchStyles(ed.S.rootId, { backgroundColor: t.value || null });
  if (t.id === "root-css") return;
  if (!ed.sel) return;
  if (t.dataset.classAdd !== undefined) {
    if (t.value) patch(ed.sel, { classes: [...(ed.S.nodes[ed.sel].classes || []), t.value] });
    return;
  }
  if (t.dataset.style) {
    const key = t.dataset.style;
    let value = t.type === "checkbox" ? (t.checked ? t.value : null) : parseVal(t.value, t.dataset.kind);
    if (key === "lineHeight" && typeof value === "number" && value >= 4) value = `${value}px`;
    const styles = { [key]: value };
    if (key === "position" && value === "absolute") {
      const el = elOf(ed.sel);
      if (el) Object.assign(styles, { left: Math.round(el.offsetLeft), top: Math.round(el.offsetTop) });
    }
    if (key === "position" && value !== "absolute") Object.assign(styles, { left: null, top: null });
    patchStyles(ed.sel, styles);
  } else if (t.dataset.field) {
    patch(ed.sel, { [t.dataset.field]: t.value });
  } else if (t.dataset.attr) {
    patch(ed.sel, { attrs: { [t.dataset.attr]: t.value || null } });
  }
}

// Field keys: Ctrl/Cmd+Enter applies CSS, arrows step numbers (Shift = 10), Enter commits, Escape cancels.
export function inspectorKeydown(e) {
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
}

// Updates held back while a field had focus are shown once focus leaves the inspector.
export function inspectorFocusout() {
  setTimeout(() => {
    if (ed.inspectorDirty && !inspector.contains(document.activeElement)) renderInspector(true);
  });
}

// Buttons in the inspector and its header (data-action, plus their other data-* values).
export async function inspectorAction(b) {
  const act = b.dataset.action;
  if (act === "copy") return copyExport(b.dataset.format, ed.sel);
  if (act === "export-zip") return downloadZip(ed.S?.id, b.dataset.format || "html");
  if (act === "copy-mcp") return copyText($("#mcp-cmd").textContent, "Copied MCP command");
  if (act === "page-bg") return patchStyles(ed.S.rootId, { backgroundColor: b.dataset.bg });
  if (act === "toggle-css-json") { ed.cssJsonOpen = !ed.cssJsonOpen; return renderInspector(true); }
  if (act === "remove-font") {
    const f = ed.fontLib.find((x) => x.id === b.dataset.id);
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
  if (!ed.sel) return;
  if (act === "zoom-sel") return zoomCmd("selection");
  if (act === "preview") return openPreview(ed.sel);
  if (act === "preset-size") {
    const styles = { height: b.dataset.h === "fit-content" ? "fit-content" : Number(b.dataset.h) };
    if (b.dataset.w) styles.width = Number(b.dataset.w);
    return patchStyles(ed.sel, styles);
  }
  if (act === "remove-class") return patch(ed.sel, { classes: (ed.S.nodes[ed.sel].classes || []).filter((c) => c !== b.dataset.class) });
  if (act === "make-class") return makeClassFrom(ed.sel);
  if (act === "delete") return removeSelected();
  if (act === "duplicate") return duplicateSelected();
  if (act === "flex" || act === "unflex") return toggleFlex(ed.sel);
  if (act === "dir") return patchStyles(ed.sel, { flexDirection: b.dataset.dir });
  if (act === "align") return patchStyles(ed.sel, { justifyContent: b.dataset.j, alignItems: b.dataset.a });
  if (act === "textAlign") return patchStyles(ed.sel, { textAlign: b.dataset.v === "left" ? null : b.dataset.v });
  if (act === "clear") return patchStyles(ed.sel, { [b.dataset.key]: null });
  if (act === "apply-css") {
    let styles;
    try { styles = JSON.parse($("#css-json").value); } catch (err) { return toast(`Invalid JSON: ${err.message}`); }
    if (!styles || typeof styles !== "object" || Array.isArray(styles)) return toast("CSS must be a JSON object");
    if (await patch(ed.sel, { styles, replaceStyles: true })) toast("CSS applied");
  }
}

// The context bar's buttons (../components/canvas/ContextBar.svelte), on the selected layer.
export function ctxAction(act) {
  if (!ed.sel) return;
  if (act === "copy") return copyExport("html", ed.sel);
  if (act === "preview") return openPreview(ed.sel);
  if (act === "duplicate") return duplicateSelected();
  if (act === "flex") return toggleFlex(ed.sel);
  if (act === "comment") return openNewComment(ed.sel);
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  // The context bar is placed over the canvas; a press on it must not reach the canvas or close menus.
  $("#ctx-bar").addEventListener("pointerdown", (e) => e.stopPropagation());
}
