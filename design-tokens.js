// W3C Design Tokens (DTCG) export/import and expanded Design System Linter helpers.
import { HttpError, VAR_NAME_RE, varsIn } from "./model.js";

const COLOR_VAR_RE = /^--(color|bg|fg|surface|text|border|brand|accent|muted|danger|success|warning|info|ink|fill|stroke)(-|$)/i;
const SPACE_VAR_RE = /^--(space|spacing|gap|pad|padding|margin|inset)(-|$)/i;
const RADIUS_VAR_RE = /^--(radius|radii|rounded|corner)(-|$)/i;
const FONT_SIZE_VAR_RE = /^--(font-size|fs|text-size|type-size)(-|$)|^--text-(xs|sm|base|md|lg|xl|\d+xl)(-|$)/i;
const FONT_FAMILY_VAR_RE = /^--(font-family|font-sans|font-mono|font-serif|font-display|font-ui|ff)(-|$)/i;
const DURATION_RE = /^-?\d+(?:\.\d+)?(ms|s)$/i;
const DIMENSION_RE = /^-?\d+(?:\.\d+)?(px|rem|em|%|vw|vh|vmin|vmax|ch|ex|pt)$/i;
const COLOR_VAL_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lch|lab|color)\([^)]+\))$/i;
const ZERO_OR_KEYWORD_RE = /^(0(?:px|rem|em|%)?|auto|none|inherit|initial|unset|revert|normal|transparent|currentcolor|100%|fit-content|max-content|min-content)$/i;

const SPACE_PROPS = new Set([
  "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "gap", "rowGap", "columnGap",
]);
const RADIUS_PROPS = new Set([
  "borderRadius", "borderTopLeftRadius", "borderTopRightRadius",
  "borderBottomLeftRadius", "borderBottomRightRadius",
]);
const FONT_SIZE_PROPS = new Set(["fontSize"]);
const FONT_FAMILY_PROPS = new Set(["fontFamily"]);
const COLOR_PROPS = new Set([
  "color", "backgroundColor", "background", "borderColor",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "outlineColor", "fill", "stroke",
]);

function cleanValueStr(v) {
  return String(v ?? "").trim();
}

export function normalizeCssColor(val) {
  const s = cleanValueStr(val).toLowerCase();
  if (!s) return null;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (/^#[0-9a-f]{4}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}${s[4]}${s[4]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{8}$/.test(s)) return s.endsWith("ff") ? s.slice(0, 7) : s;
  const rgb = /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/.exec(s);
  if (rgb) {
    const r = Math.max(0, Math.min(255, Number(rgb[1])));
    const g = Math.max(0, Math.min(255, Number(rgb[2])));
    const b = Math.max(0, Math.min(255, Number(rgb[3])));
    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    if (rgb[4] === undefined) return hex;
    const alpha = rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    if (alpha >= 0.999) return hex;
    const aHex = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
    return `${hex}${aHex}`;
  }
  return null;
}

export function normalizeDimensionPx(val) {
  const s = cleanValueStr(val).toLowerCase();
  const px = /^(-?\d+(?:\.\d+)?)px$/.exec(s);
  if (px) return `${Number(px[1])}px`;
  const rem = /^(-?\d+(?:\.\d+)?)rem$/.exec(s);
  if (rem) return `${Number((Number(rem[1]) * 16).toFixed(4))}px`;
  return null;
}

function inferTokenType(name, value) {
  const v = cleanValueStr(value);
  if (COLOR_VAL_RE.test(v) || COLOR_VAR_RE.test(name)) return "color";
  if (FONT_FAMILY_VAR_RE.test(name)) return "fontFamily";
  if (/^--(font-weight|fw)(-|$)/i.test(name) && /^\d{3}$/.test(v)) return "fontWeight";
  if (DURATION_RE.test(v)) return "duration";
  if (DIMENSION_RE.test(v) || SPACE_VAR_RE.test(name) || RADIUS_VAR_RE.test(name) || FONT_SIZE_VAR_RE.test(name)) {
    return "dimension";
  }
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return "number";
  return "string";
}

function tokenPathForVar(varName) {
  return varName.replace(/^--/, "").split("-").filter(Boolean);
}

/**
 * Convert `doc.rootCss.vars` into a W3C Design Tokens (DTCG) JSON object.
 * Handles group/leaf name collisions deterministically via `$root`, and converts `var(--a-b)` aliases into `{a.b}`.
 */
export function exportDesignTokens(doc) {
  const vars = doc?.rootCss?.vars || {};
  const entries = Object.entries(vars);
  if (!entries.length) return {};

  const paths = new Map();
  for (const [k] of entries) {
    const segs = tokenPathForVar(k);
    if (segs.length) paths.set(k, segs);
  }

  // Detect any var whose path is a strict prefix of another var's path (needs `$root` leaf slot).
  const allJoined = [...paths.values()].map((s) => s.join("."));
  const rootSlotVars = new Set();
  for (const [k, segs] of paths) {
    const joined = segs.join(".");
    if (allJoined.some((other) => other.startsWith(`${joined}.`))) rootSlotVars.add(k);
  }

  const formatAlias = (raw) => {
    const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(cleanValueStr(raw));
    if (!m || !paths.has(m[1])) return raw;
    const refSegs = paths.get(m[1]);
    return `{${rootSlotVars.has(m[1]) ? `${refSegs.join(".")}.$root` : refSegs.join(".")}}`;
  };

  const tree = {};
  for (const [varName, rawVal] of entries) {
    const segs = paths.get(varName);
    if (!segs || !segs.length) continue;
    let cur = tree;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (!cur[seg] || typeof cur[seg] !== "object" || "$value" in cur[seg]) cur[seg] = {};
      cur = cur[seg];
    }
    const last = segs[segs.length - 1];
    const tokenObj = { $value: formatAlias(rawVal), $type: inferTokenType(varName, rawVal) };
    if (rootSlotVars.has(varName)) {
      if (!cur[last] || typeof cur[last] !== "object") cur[last] = {};
      cur[last].$root = tokenObj;
    } else {
      cur[last] = tokenObj;
    }
  }
  return tree;
}

function formatW3cValue(raw, type, warnings, pathStr) {
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const alias = /^\{([^{}]+)\}$/.exec(trimmed);
    if (alias) {
      const parts = alias[1].split(".").filter((p) => p && p !== "$root");
      if (parts.length) return `var(--${parts.join("-")})`;
    }
    // Replace inline {foo.bar} aliases inside strings too
    return trimmed.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_, ref) => {
      const parts = ref.split(".").filter((p) => p && p !== "$root");
      return parts.length ? `var(--${parts.join("-")})` : `{${ref}}`;
    });
  }
  if (Array.isArray(raw)) {
    if (type === "fontFamily") {
      return raw.map((f) => (/\s/.test(String(f)) ? `'${String(f).replace(/'/g, "")}'` : String(f))).join(", ");
    }
    if (type === "shadow" || (raw[0] && typeof raw[0] === "object" && "offsetX" in raw[0])) {
      return raw.map((s) => formatW3cValue(s, "shadow", warnings, pathStr)).filter(Boolean).join(", ");
    }
    if (type === "cubicBezier" && raw.length === 4) {
      return `cubic-bezier(${raw.join(", ")})`;
    }
    return raw.map(String).join(", ");
  }
  if (raw && typeof raw === "object") {
    if ("value" in raw && "unit" in raw) return `${raw.value}${raw.unit}`;
    if (typeof raw.hex === "string") return raw.hex;
    if (Array.isArray(raw.components)) {
      const [r, g, b] = raw.components.map((c) => Math.round(Math.max(0, Math.min(1, Number(c))) * 255));
      if (raw.alpha !== undefined && Number(raw.alpha) < 1) return `rgba(${r}, ${g}, ${b}, ${raw.alpha})`;
      return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    }
    if ("offsetX" in raw || "offsetY" in raw || "blur" in raw) {
      const ox = formatW3cValue(raw.offsetX ?? "0px", "dimension", warnings, pathStr);
      const oy = formatW3cValue(raw.offsetY ?? "0px", "dimension", warnings, pathStr);
      const bl = formatW3cValue(raw.blur ?? "0px", "dimension", warnings, pathStr);
      const sp = raw.spread !== undefined ? ` ${formatW3cValue(raw.spread, "dimension", warnings, pathStr)}` : "";
      const col = raw.color !== undefined ? ` ${formatW3cValue(raw.color, "color", warnings, pathStr)}` : "";
      return `${raw.inset ? "inset " : ""}${ox} ${oy} ${bl}${sp}${col}`.trim();
    }
  }
  warnings.push(`${pathStr}: unsupported token value shape`);
  return null;
}

/**
 * Parse a W3C Design Tokens (DTCG) object or JSON string into flat `--var: value` pairs.
 */
export function importDesignTokens(input) {
  let root;
  if (typeof input === "string") {
    try { root = JSON.parse(input); } catch { throw new HttpError(400, "Invalid JSON in tokens"); }
  } else {
    root = input;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new HttpError(400, "Design tokens must be a JSON object");
  }

  const vars = {};
  const warnings = [];
  let tokenCount = 0;

  const setVar = (segs, val) => {
    const clean = segs.map((s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "")).filter(Boolean);
    if (!clean.length) return;
    let name = `--${clean.join("-")}`;
    if (!VAR_NAME_RE.test(name)) name = `--t-${clean.join("-")}`.slice(0, 64);
    if (!VAR_NAME_RE.test(name)) { warnings.push(`Skipped invalid token name "--${clean.join("-")}"`); return; }
    vars[name] = val;
    tokenCount += 1;
  };

  const walk = (node, prefix, inheritedType) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const type = typeof node.$type === "string" ? node.$type : (typeof node.type === "string" ? node.type : inheritedType);
    const hasVal = "$value" in node || "value" in node;
    if (hasVal) {
      const rawVal = "$value" in node ? node.$value : node.value;
      const pathStr = prefix.join(".") || "$root";
      if (type === "typography" && rawVal && typeof rawVal === "object" && !Array.isArray(rawVal)) {
        for (const [subK, subV] of Object.entries(rawVal)) {
          const kebab = subK.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
          const formatted = formatW3cValue(subV, kebab === "font-family" ? "fontFamily" : "dimension", warnings, `${pathStr}.${subK}`);
          if (formatted != null) setVar([...prefix, kebab], formatted);
        }
        return;
      }
      const formatted = formatW3cValue(rawVal, type, warnings, pathStr);
      if (formatted != null) setVar(prefix, formatted);
      return;
    }

    for (const [k, child] of Object.entries(node)) {
      if (k === "$root" && child && typeof child === "object") {
        walk(child, prefix, type);
        continue;
      }
      if (k.startsWith("$")) continue;
      walk(child, [...prefix, k], type);
    }
  };

  walk(root, [], undefined);
  return { vars, tokenCount, warnings };
}

function classifyVar(varName, rawValue) {
  if (COLOR_VAR_RE.test(varName) || COLOR_VAL_RE.test(cleanValueStr(rawValue))) return "color";
  if (SPACE_VAR_RE.test(varName)) return "spacing";
  if (RADIUS_VAR_RE.test(varName)) return "radius";
  if (FONT_SIZE_VAR_RE.test(varName)) return "fontSize";
  if (FONT_FAMILY_VAR_RE.test(varName)) return "fontFamily";
  return null;
}

function propCategory(prop) {
  if (COLOR_PROPS.has(prop)) return "color";
  if (SPACE_PROPS.has(prop)) return "spacing";
  if (RADIUS_PROPS.has(prop)) return "radius";
  if (FONT_SIZE_PROPS.has(prop)) return "fontSize";
  if (FONT_FAMILY_PROPS.has(prop)) return "fontFamily";
  return null;
}

const CATEGORY_LABEL = {
  color: "color",
  spacing: "spacing",
  radius: "radius",
  fontSize: "font-size",
  fontFamily: "font-family",
};

/**
 * Design system hints & linter for `write_html` and `update_styles`.
 * - Preserves exact-value matches (`k: v is the root variable --x; use var(--x) so it stays shared`).
 * - Flags undefined `var(--missing)`.
 * - When `lint` is enabled (default), detects color/px/rem equivalence, shorthand multi-value token matches,
 *   and raw values for properties whose category has defined tokens (color, spacing, radius, fontSize, fontFamily).
 */
export function analyzeDesignLint(nodeIds, doc, { lint = true, limit = 20 } = {}) {
  const root = doc?.rootCss || { vars: {}, rules: [] };
  const vars = root.vars || {};
  const byValue = new Map();
  const byNormColor = new Map();
  const byNormPx = new Map();
  const byCategory = { color: [], spacing: [], radius: [], fontSize: [], fontFamily: [] };

  for (const [k, rawV] of Object.entries(vars)) {
    const lower = String(rawV).toLowerCase();
    byValue.set(lower, [...(byValue.get(lower) || []), k]);
    const nc = normalizeCssColor(rawV);
    if (nc) byNormColor.set(nc, [...(byNormColor.get(nc) || []), k]);
    const np = normalizeDimensionPx(rawV);
    if (np) byNormPx.set(np, [...(byNormPx.get(np) || []), k]);
    const cat = classifyVar(k, rawV);
    if (cat) byCategory[cat].push(k);
  }

  const hints = new Set();
  for (const id of nodeIds) {
    const n = doc.nodes[id];
    if (!n) continue;
    for (const [k, rawVal] of Object.entries(n.styles || {})) {
      if (doc.pages.includes(n.parentId) && (k === "left" || k === "top" || k === "position")) continue;
      const v = String(rawVal);

      // 1. Unknown var(--...) references
      for (const ref of varsIn(v)) {
        if (!(ref in vars)) hints.add(`${n.name}: var(${ref}) isn't defined in the root CSS (add it with update_root_css)`);
      }

      // 2. Exact match to a root variable
      const known = byValue.get(v.toLowerCase());
      if (known) {
        hints.add(`${k}: ${v} is the root variable ${known.join(" / ")}; use ${known.map((x) => `var(${x})`).join(" or ")} so it stays shared`);
        continue;
      }

      if (!lint) continue;
      if (v.includes("var(") || ZERO_OR_KEYWORD_RE.test(v.trim())) continue;

      // 3. Normalized single-value equivalence (hex3/rgb <-> hex6, rem <-> px)
      const nc = normalizeCssColor(v);
      const colorMatches = nc ? byNormColor.get(nc) : null;
      if (colorMatches) {
        hints.add(`${k}: ${v} matches the root variable ${colorMatches.join(" / ")}; use ${colorMatches.map((x) => `var(${x})`).join(" or ")} so it stays shared`);
        continue;
      }
      const np = normalizeDimensionPx(v);
      const pxMatches = np ? byNormPx.get(np) : null;
      if (pxMatches && propCategory(k) !== "color") {
        hints.add(`${k}: ${v} matches the root variable ${pxMatches.join(" / ")}; use ${pxMatches.map((x) => `var(${x})`).join(" or ")} so it stays shared`);
        continue;
      }

      // 4. Shorthand multi-part value token matches (e.g. "12px 16px" or "1px solid #0000ff")
      const parts = v.trim().split(/\s+/);
      if (parts.length > 1) {
        const hits = [];
        for (const p of parts) {
          if (ZERO_OR_KEYWORD_RE.test(p)) continue;
          const m = byValue.get(p.toLowerCase())
            || (normalizeCssColor(p) && byNormColor.get(normalizeCssColor(p)))
            || (normalizeDimensionPx(p) && byNormPx.get(normalizeDimensionPx(p)));
          if (m) hits.push(`${p} → var(${m[0]})`);
        }
        if (hits.length) {
          hints.add(`${n.name}: ${k}: ${v} repeats root variable values (${hits.join(", ")})`);
          continue;
        }
      }

      // 5. Category-aware un-tokenized value lint (when tokens exist in that category)
      const cat = propCategory(k);
      if (cat && byCategory[cat].length) {
        if (cat === "spacing" || cat === "radius" || cat === "fontSize" || cat === "fontFamily" || (cat === "color" && COLOR_VAL_RE.test(v.trim()))) {
          const sample = byCategory[cat].slice(0, 4).join(", ");
          const more = byCategory[cat].length > 4 ? ", …" : "";
          hints.add(`${n.name}: ${k}: ${v} doesn't use a ${CATEGORY_LABEL[cat]} token (defined: ${sample}${more})`);
        }
      }
    }
    if (hints.size >= limit) break;
  }
  return [...hints].slice(0, limit);
}
