// Canvas document model: validation of tags / styles / attributes, comments and normalisation of project documents.
import { randomBytes } from "node:crypto";

export const ALLOWED_TAGS = new Set([
  "div", "section", "header", "footer", "nav", "main", "article", "aside",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "strong", "em", "small", "label",
  "a", "button", "img", "ul", "ol", "li", "figure", "figcaption", "hr", "br",
  "svg", "g", "path", "circle", "rect", "ellipse", "line", "polyline", "polygon",
]);
export const SVG_TAGS = new Set(["svg", "g", "path", "circle", "rect", "ellipse", "line", "polyline", "polygon"]);
export const VOID_TAGS = new Set(["img", "hr", "br"]);
// Presentation attributes only (no href/style/on* handlers), values limited to path/number/colour characters.
const SVG_ATTRS = new Set([
  "viewBox", "aria-hidden", "width", "height", "d", "fill", "fill-opacity", "fill-rule", "clip-rule", "stroke", "stroke-width",
  "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-miterlimit", "opacity", "transform",
  "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "points", "preserveAspectRatio",
]);
const SAFE_SVG_VALUE = /^[\w\s.,#%()+-]*$/;
const UNITLESS = new Set(["opacity", "zIndex", "flexGrow", "flexShrink", "fontWeight", "lineHeight", "order", "aspectRatio"]);
const SAFE_URL = /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);|\/|#|\.\/)/i;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COMMENT_STATUSES = new Set(["open", "read", "replied", "resolved"]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const newId = () => randomBytes(4).toString("hex");

export function cleanTag(tag) {
  const t = String(tag || "div").toLowerCase();
  if (!ALLOWED_TAGS.has(t)) throw new HttpError(400, `Tag "${t}" is not allowed`);
  return t;
}

function cleanStyleValue(key, value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(400, `Invalid number for ${key}`);
    return UNITLESS.has(key) ? String(value) : `${value}px`;
  }
  const v = String(value).trim();
  if (/[;{}<>]|javascript:|expression\s*\(/i.test(v)) throw new HttpError(400, `Unsafe value for style "${key}"`);
  return v;
}

// Merge a style patch: null/"" removes a key, everything else is validated.
export function mergeStyles(base, patch) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) throw new HttpError(400, `Style keys must be camelCase: "${key}"`);
    if (value === null || value === "") delete out[key];
    else out[key] = cleanStyleValue(key, value);
  }
  return out;
}

export function mergeAttrs(base, patch, tag) {
  const out = { ...(base || {}) };
  const svg = SVG_TAGS.has(tag);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === "") { delete out[key]; continue; }
    const v = String(value);
    if (svg) {
      if (!SVG_ATTRS.has(key)) throw new HttpError(400, `SVG attribute "${key}" is not supported`);
      if (!SAFE_SVG_VALUE.test(v) || /javascript|url\s*\(/i.test(v)) throw new HttpError(400, `Unsafe value for ${key}`);
      out[key] = v;
      continue;
    }
    if (!["src", "href", "alt"].includes(key)) throw new HttpError(400, `Attribute "${key}" is not supported`);
    if (key !== "alt" && !SAFE_URL.test(v)) throw new HttpError(400, `Unsafe URL for ${key}`);
    out[key] = v;
  }
  return out;
}

// Validate one property at a time so a single bad value is dropped (with a warning) instead of failing a whole import.
export function lenientMerge(merge, obj, warnings, where) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    try {
      Object.assign(out, merge({}, { [k]: v }));
    } catch (err) {
      if (warnings.length < 50) warnings.push(`${where}: ${err.message}`);
    }
  }
  return out;
}

export const cleanName = (name, fallback = "Untitled") => String(name ?? "").trim().slice(0, 120) || fallback;

export function emptyPage(name = "Page 1", id = newId()) {
  return { id, name: cleanName(name, "Page 1"), tag: "div", parentId: null, children: [], text: "", styles: {}, attrs: {} };
}

/** A new, empty project document: one empty page and an empty comments list. */
export function emptyProject(id, name) {
  const page = emptyPage("Page 1");
  return { version: 1, id, name: cleanName(name, "Untitled"), pages: [page.id], rootId: page.id, nodes: { [page.id]: page }, comments: [] };
}

function normalizeComments(rawComments) {
  if (!Array.isArray(rawComments)) return [];
  const out = [];
  for (const c of rawComments) {
    if (!c || typeof c !== "object") continue;
    const cid = ID_RE.test(String(c.id || "")) ? String(c.id) : newId();
    const nid = String(c.nodeId || "");
    if (!ID_RE.test(nid)) continue;
    const messages = Array.isArray(c.messages)
      ? c.messages
          .filter((m) => m && typeof m === "object" && typeof m.text === "string" && m.text.trim())
          .map((m) => ({
            id: ID_RE.test(String(m.id || "")) ? String(m.id) : newId(),
            author: cleanName(m.author, "you"),
            text: String(m.text).slice(0, 4000),
            at: typeof m.at === "string" ? m.at : new Date().toISOString(),
            ...(m.linkedStep && typeof m.linkedStep === "object"
              ? {
                  linkedStep: {
                    historyId: String(m.linkedStep.historyId || ""),
                    label: cleanName(m.linkedStep.label, "Edit"),
                    nodeIds: Array.isArray(m.linkedStep.nodeIds) ? m.linkedStep.nodeIds.filter((x) => typeof x === "string").slice(0, 40) : [],
                  },
                }
              : {}),
          }))
      : [];
    out.push({
      id: cid,
      nodeId: nid,
      // pageId and layerName let the UI place and label a thread whose layer was later deleted.
      ...(ID_RE.test(String(c.pageId || "")) ? { pageId: String(c.pageId) } : {}),
      ...(typeof c.layerName === "string" && c.layerName.trim() ? { layerName: cleanName(c.layerName, "Layer") } : {}),
      status: COMMENT_STATUSES.has(c.status) ? c.status : "open",
      agentsCanSee: c.agentsCanSee !== false,
      messages,
      ...(typeof c.readAt === "string" ? { readAt: c.readAt } : {}),
      ...(typeof c.resolvedAt === "string" ? { resolvedAt: c.resolvedAt } : {}),
      createdAt: typeof c.createdAt === "string" ? c.createdAt : (messages[0]?.at || new Date().toISOString()),
    });
  }
  return out;
}

/**
 * Normalise a project document (from disk or an import) into a consistent multi-page tree.
 * Accepts the older single-page shape ({ rootId, nodes }). With `warnings` it is lenient:
 * bad tags become div, bad styles/attrs are dropped and reported.
 */
export function normalizeProject(raw, { id, name, warnings = null } = {}) {
  if (!raw || typeof raw !== "object" || !raw.nodes || typeof raw.nodes !== "object") {
    throw new HttpError(400, "Project must have a nodes object");
  }
  const pageIds = (Array.isArray(raw.pages) && raw.pages.length ? raw.pages : [raw.rootId || "root"]).filter((p) => raw.nodes[p]);
  if (!pageIds.length) throw new HttpError(400, "Project has no pages");
  const nodes = {};
  const seen = new Set();
  const walk = (nid, parentId) => {
    const n = raw.nodes[nid];
    if (!n || seen.has(nid) || !ID_RE.test(nid)) return null;
    seen.add(nid);
    const label = cleanName(n.name, nid);
    let tag;
    try {
      tag = cleanTag(n.tag);
    } catch (err) {
      if (!warnings) throw err;
      warnings.push(`${label}: ${err.message}; using div`);
      tag = "div";
    }
    nodes[nid] = {
      id: nid,
      name: label,
      tag,
      parentId,
      children: [],
      text: String(n.text ?? ""),
      styles: warnings ? lenientMerge(mergeStyles, n.styles, warnings, label) : mergeStyles({}, n.styles),
      attrs: warnings ? lenientMerge((b, p) => mergeAttrs(b, p, tag), n.attrs, warnings, label) : mergeAttrs({}, n.attrs, tag),
    };
    for (const cid of Array.isArray(n.children) ? n.children : []) if (walk(cid, nid)) nodes[nid].children.push(cid);
    return nodes[nid];
  };
  const pages = pageIds.filter((p) => walk(p, null));
  const rootId = pages.includes(raw.rootId) ? raw.rootId : pages[0];
  return {
    version: Number(raw.version) || 1,
    id: id || raw.id,
    name: cleanName(name ?? raw.name, "Untitled"),
    pages,
    rootId,
    nodes,
    comments: normalizeComments(raw.comments),
  };
}
