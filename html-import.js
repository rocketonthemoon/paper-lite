// Parse agent-written HTML (inline styles) into Paper-Lite node specs for write_html.
import { parseFragment } from "parse5";

// Common tags that aren't in the canvas whitelist, mapped to the closest allowed one.
const TAG_ALIASES = { b: "strong", i: "em", u: "span", code: "span", mark: "span", time: "span", sub: "small", sup: "small",
  blockquote: "div", form: "div", fieldset: "div", table: "div", thead: "div", tbody: "div", tr: "div", td: "div", th: "div",
  input: "div", textarea: "div", select: "div", option: "span", picture: "figure", body: "div", html: "div", defs: "g", text: "g" };
// Same-meaning swaps (b→strong, i→em, …) stay silent; these lose structure or behaviour, so the agent is told once per tag.
const LOSSY = new Set(["form", "fieldset", "table", "thead", "tbody", "tr", "td", "th", "input", "textarea", "select", "option", "text"]);
const SKIP = new Set(["#comment", "script", "style", "template", "noscript", "head", "meta", "link", "title"]);

const camel = (prop) => {
  const p = prop.trim().toLowerCase();
  if (p.startsWith("--")) return null; // custom properties are not supported by the camelCase style model
  return p.replace(/^-(webkit|moz|ms)-/, (_, v) => `${v[0].toUpperCase()}${v.slice(1)}-`).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
};

// Split "a: b; c: url(x;y)" on semicolons that are not inside parentheses or quotes.
export function parseInlineStyle(text) {
  const out = {};
  let depth = 0, quote = null, buf = "";
  const flush = () => {
    const i = buf.indexOf(":");
    if (i > 0) {
      const key = camel(buf.slice(0, i));
      const value = buf.slice(i + 1).replace(/!important/i, "").trim();
      if (key && value) out[key] = value;
    }
    buf = "";
  };
  for (const ch of String(text || "")) {
    if (quote) { if (ch === quote) quote = null; buf += ch; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) { flush(); continue; }
    buf += ch;
  }
  flush();
  return out;
}

const squash = (t) => t.replace(/\s+/g, " ");

/**
 * @returns {{ specs: Array<{tag,name,text,styles,attrs,classes?,children}>, warnings: string[] }}
 */
export function htmlToSpecs(html) {
  const warnings = [];
  const normalizedHtml = String(html || "").replace(/<icon\b((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/>/gi, "<icon$1></icon>");
  const frag = parseFragment(normalizedHtml);
  const mapped = new Set();

  const convert = (el) => {
    const raw = el.tagName || el.nodeName;
    const svgNs = el.namespaceURI === "http://www.w3.org/2000/svg";
    let tag = svgNs ? raw : raw.toLowerCase();
    if (tag === "icon") {
      const spec = { tag: "icon", iconName: "", name: "", text: "", styles: {}, attrs: {}, children: [] };
      for (const { name, value } of el.attrs || []) {
        if (name === "name") spec.iconName = value;
        else if (name === "style") Object.assign(spec.styles, parseInlineStyle(value));
        else if (name === "data-name" || name === "data-label" || (name === "aria-label" && !spec.name)) spec.name = value;
        else if (name === "class") spec.classes = value.split(/\s+/).filter(Boolean);
        else if (name === "id" || name.startsWith("data-") || name.startsWith("on")) continue;
        else spec.attrs[name] = value;
      }
      if ((el.childNodes || []).some((c) => c.nodeName !== "#text" || c.value.trim()) && warnings.length < 50) {
        warnings.push(`<icon${spec.iconName ? ` name="${spec.iconName}"` : ""}> cannot hold child content; ignored`);
      }
      return spec;
    }
    if (TAG_ALIASES[tag]) {
      if (LOSSY.has(tag) && !mapped.has(tag) && warnings.length < 50) {
        mapped.add(tag);
        warnings.push(`<${tag}> isn't supported on the canvas; built as <${TAG_ALIASES[tag]}> (layout and behaviour may differ)`);
      }
      tag = TAG_ALIASES[tag];
    }
    const spec = { tag, name: "", text: "", styles: {}, attrs: {}, children: [] };
    for (const { name, value } of el.attrs || []) {
      if (name === "style") Object.assign(spec.styles, parseInlineStyle(value));
      else if (name === "data-name" || name === "data-label" || name === "aria-label" && !spec.name) spec.name = value;
      else if (name === "class") spec.classes = value.split(/\s+/).filter(Boolean); // shared classes from the root CSS
      else if (name === "id" || name.startsWith("data-") || name.startsWith("on")) continue;
      else spec.attrs[name] = value;
    }

    const kids = (el.childNodes || []).filter((c) => !SKIP.has(c.nodeName));
    const texts = kids.filter((c) => c.nodeName === "#text");
    const elems = kids.filter((c) => c.nodeName !== "#text");
    if (!elems.length) {
      spec.text = squash(texts.map((t) => t.value).join("")).trim();
    } else {
      // Mixed content: keep element order by turning meaningful text runs into span layers.
      // Inner spaces matter for inline flow ("links, <b>forensic</b> watermarks"), so only the outer edges are trimmed.
      kids.forEach((c, i) => {
        if (c.nodeName === "#text") {
          let t = squash(c.value);
          if (i === 0) t = t.trimStart();
          if (i === kids.length - 1) t = t.trimEnd();
          if (t.trim()) spec.children.push({ tag: "span", name: "Text", text: t, styles: {}, attrs: {}, children: [] });
          else if (t && i > 0 && i < kids.length - 1 && !/flex|grid/.test(spec.styles.display || "")) {
            // A lone space between two inline elements: attach it to the previous layer's text.
            const prev = spec.children[spec.children.length - 1];
            if (prev && !prev.children.length) prev.text += " ";
          }
        } else {
          spec.children.push(convert(c));
        }
      });
    }
    if (!spec.name) spec.name = defaultName(spec);
    return spec;
  };

  const specs = [];
  for (const c of frag.childNodes) {
    if (SKIP.has(c.nodeName)) continue;
    if (c.nodeName === "#text") {
      const t = squash(c.value).trim();
      if (t) specs.push({ tag: "span", name: "Text", text: t, styles: {}, attrs: {}, children: [] });
      continue;
    }
    specs.push(convert(c));
  }
  return { specs, warnings };
}

function defaultName(spec) {
  if (spec.text) return spec.text.length > 32 ? `${spec.text.slice(0, 29)}…` : spec.text;
  const names = { svg: "SVG", path: "Path", circle: "Circle", rect: "Rect", img: "Image", button: "Button", a: "Link",
    p: "Paragraph", h1: "Heading", h2: "Heading", h3: "Heading", h4: "Heading", h5: "Heading", h6: "Heading", li: "Item", ul: "List", ol: "List" };
  if (names[spec.tag]) return names[spec.tag];
  if (spec.styles.display === "flex") return spec.styles.flexDirection === "column" ? "Column" : "Row";
  return "Frame";
}
