// Canvas document model: validation of tags / styles / attributes, comments and normalisation of project documents.
import { randomBytes } from "node:crypto";
import "../shared/root-css.js";

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
// Plain HTML attributes layers may carry (beyond styles/classes). Event handlers, style, id and class are never allowed.
const TOKEN_LIST_RE = /^[a-z]+(?: [a-z]+)*$/;
const HTML_ATTRS = {
  src: { url: true },
  href: { url: true },
  alt: {},
  title: { text: true },
  role: { re: TOKEN_LIST_RE },
  type: { tags: ["button"], values: ["button", "submit", "reset"] },
  target: { tags: ["a"], values: ["_blank", "_self"] },
  rel: { tags: ["a"], re: TOKEN_LIST_RE },
  tabindex: { re: /^-?\d{1,3}$/ },
};
// Text attribute values (title, aria-*): plain text only, no markup or control characters.
const UNSAFE_TEXT_RE = /[<>\u0000-\u001f\u007f]/;
const MAX_TEXT_ATTR = 200;
const ARIA_ATTR_RE = /^aria-[a-z]+$/;
const ARIA_RULE = { text: true };
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ICON_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const COMPONENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export const SLOT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
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
    const rule = ARIA_ATTR_RE.test(key) ? ARIA_RULE : Object.hasOwn(HTML_ATTRS, key) ? HTML_ATTRS[key] : null;
    if (!rule) throw new HttpError(400, `Attribute "${key}" is not supported`);
    if (rule.tags && tag && !rule.tags.includes(tag)) throw new HttpError(400, `Attribute "${key}" is only supported on <${rule.tags.join(">, <")}>`);
    if (rule.url && !SAFE_URL.test(v)) throw new HttpError(400, `Unsafe URL for ${key}`);
    if (rule.values && !rule.values.includes(v)) throw new HttpError(400, `Unsupported value for ${key} (use ${rule.values.join(", ")})`);
    if (rule.re && !rule.re.test(v)) throw new HttpError(400, `Unsafe value for ${key}`);
    if (rule.text && UNSAFE_TEXT_RE.test(v)) throw new HttpError(400, `Unsafe value for ${key} (plain text only, no < > or control characters)`);
    if (rule.text && v.length > MAX_TEXT_ATTR) throw new HttpError(400, `${key} is too long (max ${MAX_TEXT_ATTR} characters)`);
    out[key] = v;
  }
  // Links that open a new tab never get access to the opener.
  if (out.target === "_blank" && !/\bnoopener\b/.test(out.rel || "")) out.rel = `${out.rel ? `${out.rel} ` : ""}noopener noreferrer`;
  return out;
}

// ---------------------------------------------------------------------------
// Root CSS: one project-wide stylesheet every layer shares: variables in :root, classes, states (:hover…),
// @media and nesting. Parsing/serialising lives in shared/root-css.js (served to the editor at /root-css.js) so the editor uses the exact same rules.
// Stored as { vars: { "--name": value }, rules: [{ selector, media?, styles }] } in author order.
// ---------------------------------------------------------------------------
const RC = globalThis.WeftRootCss;
export const { VAR_NAME_RE, CLASS_NAME_RE } = RC;
export const parseRootCss = RC.parse;
export const rootCssText = RC.toText;
export const rootCssFlat = RC.flatCss;
export const isBaseRule = RC.isBase;
export const rootClassesIn = RC.classesIn;
/** Every class the root CSS defines anywhere (base, state, nested or media rules). */
export const definedRootClasses = (root) => RC.definedClasses(root);
const MAX_VARS = 400, MAX_RULES = 800, MAX_LAYER_CLASSES = 12;

export const emptyRootCss = () => ({ vars: {}, rules: [] });

// Validate raw property keys directly (trimming outer whitespace and accidental matching quotes, never JSON-stringifying).
function cleanCssMapKey(raw) {
  let k = String(raw ?? "").trim();
  if (k.length >= 2 && ((k.startsWith("\"") && k.endsWith("\"")) || (k.startsWith("'") && k.endsWith("'")))) {
    k = k.slice(1, -1).trim();
  }
  return k;
}

function cleanVarValue(name, value) {
  if (!VAR_NAME_RE.test(name)) throw new HttpError(400, `CSS variable names look like --color-primary: "${name}"`);
  return cleanStyleValue(name, typeof value === "number" ? String(value) : value);
}

// Rule styles: camelCase properties (like layer styles) plus scoped --variables; null/"" removes.
function mergeRuleStyles(base, patch, where) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === "") { delete out[key]; continue; }
    if (key.startsWith("--")) out[key] = cleanVarValue(key, value);
    else if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) throw new HttpError(400, `${where}: style keys must be camelCase: "${key}"`);
    else out[key] = cleanStyleValue(key, value);
  }
  return out;
}

const asHttp = (fn) => {
  try { return fn(); } catch (err) { throw err instanceof HttpError ? err : new HttpError(err.status || 400, err.message); }
};

// A rule as stored: canonical selector, validated media and styles.
function cleanRule(rule) {
  return asHttp(() => {
    const media = rule.media == null || rule.media === "" ? undefined : RC.checkMedia(rule.media);
    const selector = rule.selector === ":root" ? ":root" : RC.checkSelector(String(rule.selector ?? ""));
    if (selector === ":root" && !media) throw new HttpError(400, "Top-level :root variables go in vars");
    const styles = mergeRuleStyles({}, rule.styles, selector);
    if (selector === ":root" && Object.keys(styles).some((k) => !k.startsWith("--"))) throw new HttpError(400, ":root only holds variables");
    return { selector, ...(media ? { media } : {}), styles };
  });
}

const sameRule = (a, b) => a.selector === b.selector && (a.media || "") === (b.media || "");

function coalesceMatchingRule(rules, rule) {
  let first = null;
  const kept = [];
  for (const r of rules) {
    if (sameRule(r, rule)) {
      if (!first) {
        first = r;
        kept.push(r);
      } else {
        first.styles = mergeRuleStyles(first.styles, r.styles, r.selector);
      }
    } else {
      kept.push(r);
    }
  }
  if (first) {
    first.styles = mergeRuleStyles(first.styles, rule.styles, rule.selector);
    return kept;
  }
  kept.push(rule);
  return kept;
}

/**
 * Apply a root-CSS patch.
 * - css: root CSS text. With replace it becomes the whole root CSS, in order (coalescing duplicate @media rules);
 *   otherwise each rule merges into the existing rule with the same selector and @media (or is appended) and :root variables merge.
 * - vars: { "--name": value | null }.
 * - classes: { name: { camelCase: value | null } | null }: the plain `.name { }` rule; null removes it.
 */
export function mergeRootCss(base, { css, vars, classes, rules } = {}, { replace = false } = {}) {
  const out = replace ? emptyRootCss() : structuredClone(base || emptyRootCss());
  out.vars ||= {};
  out.rules ||= [];
  if (css !== undefined && css !== null) {
    const parsed = asHttp(() => RC.parse(css));
    for (const [rawK, v] of Object.entries(parsed.vars)) {
      const k = cleanCssMapKey(rawK);
      out.vars[k] = cleanVarValue(k, v);
    }
    for (const raw of parsed.rules) {
      const rule = cleanRule(raw);
      if (!replace || rule.media) {
        out.rules = coalesceMatchingRule(out.rules, rule);
      } else {
        out.rules.push(rule);
      }
    }
  }
  if (Array.isArray(rules)) {
    for (const raw of rules) {
      const rule = cleanRule(raw);
      if (!replace || rule.media) {
        out.rules = coalesceMatchingRule(out.rules, rule);
      } else {
        out.rules.push(rule);
      }
    }
  }
  for (const [rawName, value] of Object.entries(vars || {})) {
    const name = cleanCssMapKey(rawName);
    if (!VAR_NAME_RE.test(name)) throw new HttpError(400, `CSS variable names look like --color-primary: "${name}"`);
    if (value === null || value === "") {
      delete out.vars[name];
    } else {
      out.vars[name] = cleanVarValue(name, value);
    }
  }
  for (const [rawName, styles] of Object.entries(classes || {})) {
    const name = cleanCssMapKey(rawName);
    if (!CLASS_NAME_RE.test(name)) throw new HttpError(400, `Class names start with a letter and use letters, digits, - or _: "${name}"`);
    const selector = `.${name}`;
    if (styles === null || styles === "") {
      out.rules = out.rules.filter((r) => !(r.selector === selector && !r.media));
      continue;
    }
    if (typeof styles !== "object" || Array.isArray(styles)) throw new HttpError(400, `Class "${name}" must be an object of camelCase styles`);
    const hit = out.rules.find((r) => r.selector === selector && !r.media);
    if (hit) hit.styles = mergeRuleStyles(hit.styles, styles, selector);
    else out.rules.push({ selector, styles: mergeRuleStyles({}, styles, selector) });
  }
  out.rules = out.rules.filter((r) => Object.keys(r.styles).length);
  if (Object.keys(out.vars).length > MAX_VARS) throw new HttpError(400, `At most ${MAX_VARS} CSS variables`);
  if (out.rules.length > MAX_RULES) throw new HttpError(400, `At most ${MAX_RULES} root CSS rules`);
  return out;
}

/** The plain `.class { }` rules as { name: styles } (merged when a class has several). */
export function rootBaseClasses(root) {
  const out = {};
  for (const r of root?.rules || []) if (RC.isBase(r)) Object.assign((out[r.selector.slice(1)] ||= {}), r.styles);
  return out;
}

/** A layer's class list from an array or a space-separated string: valid, unique, in order. */
export function cleanClassList(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/\s+/);
  const out = [];
  for (const raw of list) {
    const c = String(raw ?? "").trim();
    if (!c) continue;
    if (!CLASS_NAME_RE.test(c)) throw new HttpError(400, `Class names start with a letter and use letters, digits, - or _: "${c}"`);
    if (!out.includes(c)) out.push(c);
  }
  if (out.length > MAX_LAYER_CLASSES) throw new HttpError(400, `A layer can use at most ${MAX_LAYER_CLASSES} classes`);
  return out;
}

/** Variables referenced by a style value, e.g. "1px solid var(--line)" → ["--line"]. */
export const varsIn = (value) => [...String(value ?? "").matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);

// Whether a root CSS rule can match at least one node given the active class usage map.
function ruleUsedByNodes(rule, usage) {
  if (rule.selector === ":root") return true;
  return RC.splitTop(rule.selector, ",").some((part) => {
    const cls = rootClassesIn(part);
    return cls.length === 0 || cls.every((c) => usage[c] > 0);
  });
}

/** Compute class usage counts, unused classes, and unused :root variables (including transitive var() chains). */
export function analyzeRootCssUsage(root, nodes = {}) {
  const r = root || emptyRootCss();
  const usage = {};
  for (const n of Object.values(nodes || {})) {
    for (const c of n?.classes || []) usage[c] = (usage[c] || 0) + 1;
  }
  const defined = definedRootClasses(r);
  const unusedClasses = defined.filter((c) => !usage[c]);

  const usedVars = new Set();
  const addVars = (val) => {
    for (const ref of varsIn(val)) {
      if (usedVars.has(ref)) continue;
      usedVars.add(ref);
      if (ref in (r.vars || {})) addVars(r.vars[ref]);
      for (const rule of r.rules || []) {
        if (rule.selector === ":root" && ref in (rule.styles || {})) addVars(rule.styles[ref]);
      }
    }
  };
  for (const n of Object.values(nodes || {})) {
    for (const val of Object.values(n?.styles || {})) addVars(val);
  }
  for (const rule of r.rules || []) {
    if (rule.selector === ":root" || !ruleUsedByNodes(rule, usage)) continue;
    for (const val of Object.values(rule.styles || {})) addVars(val);
  }
  const unusedVars = Object.keys(r.vars || {}).filter((k) => !usedVars.has(k));
  return { usage, unusedClasses, unusedVars, usedVars };
}

/** Return a pruned copy of `root` with unreferenced class rules and unreferenced :root variables removed. */
export function pruneUnusedRootCss(root, nodes = {}) {
  const base = structuredClone(root || emptyRootCss());
  const { usage } = analyzeRootCssUsage(base, nodes);
  base.rules = (base.rules || []).filter((rule) => rule.selector === ":root" || ruleUsedByNodes(rule, usage));
  const { usedVars } = analyzeRootCssUsage(base, nodes);
  for (const k of Object.keys(base.vars || {})) {
    if (!usedVars.has(k)) delete base.vars[k];
  }
  base.rules = base.rules.filter((rule) => {
    if (rule.selector !== ":root") return true;
    for (const k of Object.keys(rule.styles || {})) {
      if (!usedVars.has(k)) delete rule.styles[k];
    }
    return Object.keys(rule.styles || {}).length > 0;
  });
  return base;
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
  return { version: 1, id, name: cleanName(name, "Untitled"), pages: [page.id], rootId: page.id, nodes: { [page.id]: page }, rootCss: emptyRootCss(), icons: {}, components: {}, comments: [] };
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
    if (n.classes !== undefined) {
      let classes = [];
      if (!warnings) classes = cleanClassList(n.classes);
      else {
        // Lenient: keep the valid names, report the rest.
        for (const c of Array.isArray(n.classes) ? n.classes : String(n.classes ?? "").split(/\s+/)) {
          try { classes = cleanClassList([...classes, c]); } catch (err) { warnings.push(`${label}: ${err.message}`); }
        }
      }
      if (classes.length) nodes[nid].classes = classes;
    }
    if (typeof n.componentId === "string" && COMPONENT_NAME_RE.test(n.componentId)) nodes[nid].componentId = n.componentId;
    if (typeof n.componentRootId === "string" && ID_RE.test(n.componentRootId)) nodes[nid].componentRootId = n.componentRootId;
    if (typeof n.componentKey === "string" && SLOT_NAME_RE.test(n.componentKey)) nodes[nid].componentKey = n.componentKey;
    const ov = normalizeOverrides(n.componentOverrides);
    if (ov) nodes[nid].componentOverrides = ov;
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
    rootCss: normalizeRootCss(raw.rootCss, warnings),
    icons: normalizeIcons(raw.icons, warnings),
    components: normalizeComponents(raw.components, warnings),
    comments: normalizeComments(raw.comments),
  };
}

export function sanitizeSvgSpecNode(spec, label) {
  const tag = String(spec?.tag || "").toLowerCase();
  if (!SVG_TAGS.has(tag)) throw new HttpError(400, `${label}: icon markup can only contain SVG elements (got <${tag}>)`);
  const attrs = mergeAttrs({}, spec.attrs || {}, tag);
  const styles = mergeStyles({}, spec.styles || {});
  return {
    tag,
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(Object.keys(styles).length ? { styles } : {}),
    children: (spec.children || []).map((c) => sanitizeSvgSpecNode(c, label)),
  };
}

export function normalizeIcons(rawIcons, warnings = null) {
  if (!rawIcons || typeof rawIcons !== "object" || Array.isArray(rawIcons)) return {};
  const out = {};
  for (const [k, asset] of Object.entries(rawIcons)) {
    if (!asset || typeof asset !== "object") continue;
    try {
      const name = String(asset.name || k).trim();
      if (!ICON_NAME_RE.test(name)) throw new HttpError(400, `Invalid icon name "${name}"`);
      const cleanRoot = sanitizeSvgSpecNode({ tag: "svg", attrs: asset.attrs, styles: asset.styles, children: asset.children }, `Icon "${name}"`);
      out[name] = {
        name,
        ...(cleanRoot.attrs?.viewBox ? { viewBox: cleanRoot.attrs.viewBox } : {}),
        attrs: cleanRoot.attrs || {},
        ...(cleanRoot.styles && Object.keys(cleanRoot.styles).length ? { styles: cleanRoot.styles } : {}),
        children: cleanRoot.children,
      };
    } catch (err) {
      if (!warnings) throw err;
      warnings.push(`Icon "${k}": ${err.message}`);
    }
  }
  return out;
}

function normalizeRootCss(raw, warnings) {
  if (!raw || typeof raw !== "object") return emptyRootCss();
  // Older saves kept plain classes as { classes: { name: styles } }.
  const rules = [...(Array.isArray(raw.rules) ? raw.rules : []),
    ...Object.entries(raw.classes && typeof raw.classes === "object" ? raw.classes : {}).map(([name, styles]) => ({ selector: `.${name}`, styles }))];
  const out = emptyRootCss();
  const report = (where, err) => { if (!warnings) throw err; warnings.push(`Root CSS ${where}: ${err.message}`); };
  for (const [k, v] of Object.entries(raw.vars && typeof raw.vars === "object" ? raw.vars : {})) {
    try { out.vars[k] = cleanVarValue(k, v); } catch (err) { report(k, err); }
  }
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    try {
      const rule = cleanRule(r);
      if (Object.keys(rule.styles).length) out.rules.push(rule);
    } catch (err) { report(String(r.selector ?? "rule").slice(0, 60), err); }
  }
  return out;
}

function normalizeOverrides(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  if (raw.text) out.text = true;
  if (raw.tag) out.tag = true;
  if (raw.name) out.name = true;
  if (raw.classes) out.classes = true;
  if (Array.isArray(raw.styles)) {
    const s = [...new Set(raw.styles.filter((k) => typeof k === "string" && /^[a-zA-Z][a-zA-Z0-9]*$/.test(k)))];
    if (s.length) out.styles = s;
  }
  if (Array.isArray(raw.attrs)) {
    const a = [...new Set(raw.attrs.filter((k) => typeof k === "string" && /^[a-zA-Z][a-zA-Z0-9-]*$/.test(k)))];
    if (a.length) out.attrs = a;
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeComponentTree(raw, { warnings = null, depth = 0, usedKeys = new Set(), counter = { n: 0 } } = {}) {
  if (!raw || typeof raw !== "object" || depth > 50) throw new HttpError(400, "Invalid component tree node");
  const label = cleanName(raw.name, String(raw.tag || "Frame"));
  let tag;
  try {
    tag = cleanTag(raw.tag);
  } catch (err) {
    if (!warnings) throw err;
    warnings.push(`${label}: ${err.message}; using div`);
    tag = "div";
  }
  let key = typeof raw.key === "string" && SLOT_NAME_RE.test(raw.key) ? raw.key : "";
  if (!key || usedKeys.has(key)) {
    do { counter.n += 1; key = `k${counter.n}`; } while (usedKeys.has(key));
  }
  usedKeys.add(key);
  const slot = typeof raw.slot === "string" && SLOT_NAME_RE.test(raw.slot) ? raw.slot : undefined;
  const noText = SVG_TAGS.has(tag) || VOID_TAGS.has(tag);
  const styles = warnings ? lenientMerge(mergeStyles, raw.styles, warnings, label) : mergeStyles({}, raw.styles);
  const attrs = warnings ? lenientMerge((b, p) => mergeAttrs(b, p, tag), raw.attrs, warnings, label) : mergeAttrs({}, raw.attrs, tag);
  let classes = [];
  if (raw.classes !== undefined) {
    if (!warnings) classes = cleanClassList(raw.classes);
    else {
      for (const c of Array.isArray(raw.classes) ? raw.classes : String(raw.classes ?? "").split(/\s+/)) {
        try { classes = cleanClassList([...classes, c]); } catch (err) { warnings.push(`${label}: ${err.message}`); }
      }
    }
  }
  const children = [];
  if (!VOID_TAGS.has(tag) && Array.isArray(raw.children)) {
    for (const child of raw.children) {
      if (!child || typeof child !== "object") continue;
      children.push(normalizeComponentTree(child, { warnings, depth: depth + 1, usedKeys, counter }));
    }
  }
  return {
    key,
    ...(slot ? { slot } : {}),
    tag,
    name: label,
    text: noText ? "" : String(raw.text ?? ""),
    styles,
    attrs,
    ...(classes.length ? { classes } : {}),
    children,
  };
}

function normalizeComponents(raw, warnings) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [compId, def] of Object.entries(raw)) {
    if (!COMPONENT_NAME_RE.test(compId) || !def || typeof def !== "object" || !def.tree) continue;
    try {
      out[compId] = {
        id: compId,
        name: cleanName(def.name, compId),
        tree: normalizeComponentTree(def.tree, { warnings }),
      };
    } catch (err) {
      if (!warnings) throw err;
      warnings.push(`Component "${compId}": ${err.message}`);
    }
  }
  return out;
}
