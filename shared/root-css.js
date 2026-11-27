// Root CSS: one project-wide stylesheet that every layer shares. Variables, classes, states (:hover, :focus…),
// @media queries and nesting (&:hover, & .title, &__title, nested @media) are parsed into a flat, ordered rule list:
//   { vars: { "--name": value }, rules: [{ selector, media?, styles: { camelCase | --var: value } }] }
// Shared by the server (validation, exports) and the editor (canvas rendering, the Root CSS text editor):
// loaded as a classic script in the browser (window.WeftRootCss) and imported for its side effect in Node.
(function (global) {
  const VAR_NAME_RE = /^--[a-zA-Z][\w-]{0,127}$/;
  const CLASS_NAME_RE = /^[a-zA-Z][\w-]{0,127}$/;
  const TAGS = new Set([
    "div", "section", "header", "footer", "nav", "main", "article", "aside",
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "strong", "em", "small", "label",
    "a", "button", "img", "ul", "ol", "li", "figure", "figcaption", "hr", "br",
    "svg", "g", "path", "circle", "rect", "ellipse", "line", "polyline", "polygon",
  ]);
  const PSEUDO_CLASSES = new Set([
    "hover", "focus", "focus-visible", "focus-within", "active", "visited", "link", "target", "disabled", "enabled",
    "checked", "empty", "first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type",
  ]);
  const PSEUDO_FUNCS = { "nth-child": "nth", "nth-last-child": "nth", "nth-of-type": "nth", "nth-last-of-type": "nth", not: "list", is: "list", where: "list", has: "relative" };
  const PSEUDO_ELEMENTS = new Set(["before", "after", "placeholder", "selection", "marker", "first-letter", "first-line"]);
  const MAX_DEPTH = 8;

  const fail = (message) => {
    const err = new Error(message);
    err.status = 400;
    throw err;
  };
  const camel = (k) => (k.startsWith("--") ? k : k.trim().toLowerCase()
    .replace(/^-(webkit|moz|ms)-/, (_, p) => `${p === "ms" ? "ms" : p[0].toUpperCase() + p.slice(1)}-`)
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
  const kebab = (k) => (k.startsWith("--") ? k : k.replace(/^(Webkit|Moz|ms)(?=[A-Z])/, (m) => `-${m.toLowerCase()}`).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));

  /** Split on a separator that isn't inside parentheses. */
  function splitTop(s, sep) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      else if (s[i] === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    out.push(s.slice(start));
    return out;
  }

  function closeParen(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) return i;
    }
    return fail(`Unclosed "(" in selector "${s.slice(0, 60)}"`);
  }

  /**
   * Validate one complex selector and return it in canonical form (single spaces, " > " combinators).
   * Allowed: tags, *, .classes, the pseudo-classes / pseudo-elements above, and the space > + ~ combinators.
   * No ids, attribute selectors or :root (variables go in :root blocks).
   */
  function checkComplex(raw, { relative = false } = {}) {
    const s = raw.trim();
    if (!s) fail("Empty selector");
    let i = 0, out = "", empty = true, pseudoElement = false;
    const at = (re) => { re.lastIndex = i; const m = re.exec(s); if (m) i = re.lastIndex; return m; };
    if (relative) {
      const m = at(/\s*([>+~])\s*/y);
      if (m) out += `${m[1]} `;
    }
    while (i < s.length) {
      let m;
      if ((m = at(/\s*([>+~])\s*|\s+/y))) {
        if (empty || i >= s.length) fail(`Selector "${s}" has a dangling combinator`);
        if (pseudoElement) fail(`Nothing can follow a pseudo-element in "${s}"`);
        out += m[1] ? ` ${m[1]} ` : " ";
        empty = true;
        pseudoElement = false;
        continue;
      }
      if (pseudoElement) fail(`Nothing can follow a pseudo-element in "${s}"`);
      if (empty && (m = at(/\*|[a-zA-Z][a-zA-Z0-9]*/y))) {
        const tag = m[0] === "*" ? "*" : m[0].toLowerCase();
        if (tag !== "*" && !TAGS.has(tag)) fail(`<${tag}> isn't a canvas tag, so "${s}" can never match`);
        out += tag;
      } else if ((m = at(/\.(-?[a-zA-Z_][\w-]*)/y))) {
        if (!CLASS_NAME_RE.test(m[1])) fail(`Class names start with a letter and use letters, digits, - or _: ".${m[1]}"`);
        out += `.${m[1]}`;
      } else if ((m = at(/::([a-zA-Z-]+)/y))) {
        const name = m[1].toLowerCase();
        if (!PSEUDO_ELEMENTS.has(name)) fail(`::${name} isn't supported (use ${[...PSEUDO_ELEMENTS].map((p) => `::${p}`).join(", ")})`);
        out += `::${name}`;
        pseudoElement = true;
      } else if ((m = at(/:([a-zA-Z-]+)/y))) {
        const name = m[1].toLowerCase();
        if (s[i] === "(") {
          const end = closeParen(s, i);
          const inner = s.slice(i + 1, end);
          i = end + 1;
          const kind = PSEUDO_FUNCS[name];
          if (!kind) fail(`:${name}() isn't supported`);
          let norm;
          if (kind === "nth") {
            norm = inner.trim().toLowerCase().replace(/\s+/g, " ");
            if (!/^(odd|even|[+-]?\d*n( ?[+-] ?\d+)?|[+-]?\d+)$/.test(norm)) fail(`Bad :${name}() argument "${inner.trim()}"`);
          } else {
            norm = splitTop(inner, ",").map((p) => checkComplex(p, { relative: kind === "relative" })).join(", ");
          }
          out += `:${name}(${norm})`;
        } else {
          if (name === "root") fail(":root only holds variables: write :root { --name: value; } on its own");
          if (!PSEUDO_CLASSES.has(name)) fail(`:${name} isn't supported (states: ${[...PSEUDO_CLASSES].slice(0, 6).map((p) => `:${p}`).join(", ")}…)`);
          out += `:${name}`;
        }
      } else if (s[i] === "&") {
        fail("& only works inside a rule");
      } else {
        fail(`Unsupported selector syntax near "${s.slice(i, i + 24)}" (ids and attribute selectors aren't supported; use classes)`);
      }
      empty = false;
    }
    if (empty) fail(`Selector "${s}" ends with a combinator`);
    return out;
  }

  const checkSelector = (sel) => splitTop(sel, ",").map((p) => checkComplex(p)).join(", ");

  function checkMedia(raw) {
    const q = String(raw ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .replace(/\s*:\s*/g, ": ");
    if (!q) fail("@media needs a query, e.g. @media (max-width: 640px)");
    if (!/^[\w\s:().,<>=/-]+$/.test(q) || q.includes("</")) fail(`Unsupported characters in @media ${q.slice(0, 40)}`);
    let depth = 0;
    for (const ch of q) { if (ch === "(") depth++; else if (ch === ")" && --depth < 0) break; }
    if (depth !== 0) fail(`Unbalanced parentheses in @media ${q.slice(0, 40)}`);
    return q;
  }

  function combineMedia(outer, inner) {
    if (!outer) return inner;
    if (splitTop(outer, ",").length > 1 || splitTop(inner, ",").length > 1) fail("Nested @media can't use comma lists; write the combined query instead");
    return `${outer} and ${inner}`;
  }

  // Resolve a nested selector list against its parents. & is replaced by each parent (Sass-style &__title and
  // &--primary concatenate); a selector without & is a descendant ("> .icon" keeps its combinator).
  function resolveSelectors(prelude, parents) {
    const parts = splitTop(prelude, ",").map((p) => p.trim());
    if (!parents) return parts.map((p) => checkComplex(p));
    const out = [];
    for (const p of parts) {
      if (!p) fail("Empty selector");
      for (const parent of parents) out.push(checkComplex(p.includes("&") ? p.split("&").join(parent) : `${parent} ${p}`));
    }
    return out;
  }

  function matchBrace(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    return fail(`Missing "}" after "${text.slice(Math.max(0, open - 40), open).trim()}"`);
  }

  function parseBlock(text, parents, media, out, depth) {
    if (depth > MAX_DEPTH) fail(`Nesting is limited to ${MAX_DEPTH} levels`);
    let i = 0, run = [];
    const flush = () => {
      if (!run.length) return;
      if (!parents) fail(`"${run[0][0]}: ${run[0][1]}" needs a selector around it`);
      const styles = {};
      for (const [k, v] of run) styles[camel(k)] = v;
      out.rules.push({ selector: parents.join(", "), ...(media ? { media } : {}), styles });
      run = [];
    };
    while (i < text.length) {
      while (i < text.length && /[\s;]/.test(text[i])) i++;
      if (i >= text.length) break;
      let j = i;
      while (j < text.length && text[j] !== "{" && text[j] !== ";" && text[j] !== "}") j++;
      if (text[j] === "}") fail(`Unexpected "}" after "${text.slice(i, j).trim().slice(0, 40) || text.slice(Math.max(0, j - 40), j).trim()}"`);
      if (text[j] === "{") {
        const prelude = text.slice(i, j).trim();
        const end = matchBrace(text, j);
        flush();
        nested(prelude, text.slice(j + 1, end), parents, media, out, depth);
        i = end + 1;
        continue;
      }
      const decl = text.slice(i, j).trim();
      i = j + 1;
      const k = decl.indexOf(":");
      if (k < 1) fail(`Bad declaration "${decl.slice(0, 40)}" (expected property: value;)`);
      const prop = decl.slice(0, k).trim(), value = decl.slice(k + 1).trim();
      if (!/^(--[a-zA-Z][\w-]*|-?[a-zA-Z][a-zA-Z-]*)$/.test(prop)) fail(`Bad property name "${prop.slice(0, 40)}"`);
      if (!value) fail(`${prop} has no value`);
      run.push([prop, value]);
    }
    flush();
  }

  function nested(prelude, inner, parents, media, out, depth) {
    if (!prelude) fail("A block needs a selector or @media in front of it");
    if (prelude[0] === "@") {
      const m = /^@media\b([\s\S]*)$/i.exec(prelude);
      if (!m) fail(`${prelude.split(/[\s(]/)[0]} isn't supported in the root CSS (use @media)`);
      return parseBlock(inner, parents, combineMedia(media, checkMedia(m[1])), out, depth + 1);
    }
    if (prelude === ":root") {
      if (parents) fail(":root can't be nested inside a rule");
      const vars = { selector: ":root", parents: null, rules: [] };
      parseBlock(inner, [":root"], null, vars, depth + 1);
      for (const r of vars.rules) {
        if (r.selector !== ":root") fail(":root only holds variables, not nested rules");
        for (const [k, v] of Object.entries(r.styles)) {
          if (!k.startsWith("--")) fail(`:root only holds variables (--name: value); "${kebab(k)}" belongs in a class`);
          if (media) {
            const last = out.rules[out.rules.length - 1];
            if (last && last.selector === ":root" && last.media === media) last.styles[k] = v;
            else out.rules.push({ selector: ":root", media, styles: { [k]: v } });
          } else {
            out.vars[k] = v;
          }
        }
      }
      return undefined;
    }
    return parseBlock(inner, resolveSelectors(prelude, parents), media, out, depth + 1);
  }

  /** Parse root CSS text into { vars, rules }. Throws (status 400) with a readable message on anything unsupported. */
  function parse(css) {
    const src = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, " ");
    if (src.includes("/*")) fail("Unclosed /* comment");
    const out = { vars: {}, rules: [] };
    parseBlock(src, null, null, out, 0);
    return out;
  }

  /** Class names a selector mentions (including inside :not()/:is()/:has()). */
  const classesIn = (selector) => [...String(selector).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  /** Every class the root CSS defines anywhere: these are the classes layers can use. */
  function definedClasses(root) {
    const set = new Set();
    for (const r of root?.rules || []) for (const c of classesIn(r.selector)) set.add(c);
    return [...set];
  }
  /** A base rule is a plain `.class { … }` outside @media; states, media and nested rules apply on top of layer styles. */
  const isBase = (r) => !r.media && /^\.[a-zA-Z][\w-]*$/.test(r.selector);

  // The class a rule can be nested under when writing text: ".card:hover .x" → ".card"; a list nests when every
  // part starts with the same class (".card .a, .card .b" → "& .a, & .b"). Tag selectors stay at the top level.
  function anchorOf(selector) {
    let anchor = null;
    for (const part of splitTop(selector, ",")) {
      const p = part.trim();
      const m = /^\.[a-zA-Z][\w-]*/.exec(p);
      if (!m) return null;
      const rest = p.slice(m[0].length);
      if (rest !== "" && !/^[:\s.]/.test(rest)) return null;
      if (anchor && anchor !== m[0]) return null;
      anchor = m[0];
    }
    return anchor;
  }
  const relativeTo = (selector, anchor) => splitTop(selector, ",").map((p) => `&${p.trim().slice(anchor.length)}`).join(", ");

  const declLines = (styles, pad) => Object.entries(styles).map(([k, v]) => `${pad}${kebab(k)}: ${v};`);

  // One rule inside its class block: own declarations directly, others as "&… { }".
  const nestedRule = (r, anchor, pad) => (r.selector === anchor ? declLines(r.styles, pad)
    : [`${pad}${relativeTo(r.selector, anchor)} {`, ...declLines(r.styles, `${pad}  `), `${pad}}`]);

  /** Root CSS as readable text: :root variables, then rules nested under their class (&:hover, & .title, @media). Round-trips through parse(). */
  function toText(root) {
    const parts = [];
    const vars = Object.entries(root?.vars || {});
    if (vars.length) parts.push(`:root {\n${vars.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}`);
    const rules = root?.rules || [];
    for (let i = 0; i < rules.length;) {
      const anchor = anchorOf(rules[i].selector);
      let j = i + 1;
      if (anchor) {
        while (j < rules.length && anchorOf(rules[j].selector) === anchor) j++;
        const group = rules.slice(i, j), body = [];
        for (let k = 0; k < group.length;) {
          const q = group[k].media;
          let l = k + 1;
          if (!q) { body.push(...nestedRule(group[k], anchor, "  ")); k = l; continue; }
          while (l < group.length && group[l].media === q) l++;
          body.push(`  @media ${q} {`, ...group.slice(k, l).flatMap((r) => nestedRule(r, anchor, "    ")), "  }");
          k = l;
        }
        parts.push(`${anchor} {\n${body.join("\n")}\n}`);
      } else {
        const media = rules[i].media;
        while (j < rules.length && !anchorOf(rules[j].selector) && rules[j].media === media) j++;
        const block = rules.slice(i, j).map((r) => `${media ? "  " : ""}${r.selector} {\n${declLines(r.styles, media ? "    " : "  ").join("\n")}\n${media ? "  " : ""}}`);
        parts.push(media ? `@media ${media} {\n${block.join("\n\n")}\n}` : block.join("\n\n"));
      }
      i = j;
    }
    return parts.join("\n\n");
  }

  /** Plain (un-nested) CSS for a list of rules, grouping consecutive rules that share an @media. */
  function flatCss(rules, { selector = (s) => s, media = (q) => `@media ${q}` } = {}) {
    const out = [];
    for (let i = 0; i < rules.length;) {
      let j = i + 1;
      const q = rules[i].media;
      while (j < rules.length && rules[j].media === q) j++;
      const block = rules.slice(i, j).map((r) => `${q ? "  " : ""}${selector(r.selector)} {\n${declLines(r.styles, q ? "    " : "  ").join("\n")}\n${q ? "  " : ""}}`);
      out.push(q ? `${media(q)} {\n${block.join("\n\n")}\n}` : block.join("\n\n"));
      i = j;
    }
    return out.join("\n\n");
  }

  // ---------------------------------------------------------------- canvas (editor) rendering
  // On the canvas, layer classes are prefixed (wc-card) so they can't collide with the editor's own CSS, every
  // selector is scoped to the canvas world, and width-only @media queries become @container queries against the
  // artboard, so a 390px artboard gets its mobile styles even though the editor window is wide.
  const CANVAS_PREFIX = "wc-";
  const scopeSelector = (sel, scope) => splitTop(sel, ",").map((p) => {
    const part = p.trim().replace(/\.([a-zA-Z][\w-]*)/g, `.${CANVAS_PREFIX}$1`);
    return part === ":root" ? scope : `${scope} ${part}`;
  }).join(", ");
  function widthOnly(q) {
    const t = q.replace(/^\s*(only\s+)?(screen|all)\s+and\s+/i, "");
    const feats = t.match(/\([^()]*\)/g) || [];
    if (!feats.length) return null;
    if (t.replace(/\([^()]*\)/g, "").replace(/\b(and|or)\b/gi, "").trim()) return null;
    return feats.every((f) => /\b(min-|max-)?width\b/i.test(f)) ? t : null;
  }

  /**
   * Stylesheet for a canvas: variables on the scope, base classes, each layer's own styles, then states / media /
   * nested rules on top. Same cascade as the exported styles.css.
   */
  // The canvas cascade in three parts: `head` (variables + base classes), each layer's own styles, then `tail`
  // (states, @media, nested rules). Layer rules sit between the two at equal specificity, like the export.
  function canvasCssParts(root, scope) {
    const rules = root?.rules || [];
    const vars = Object.entries(root?.vars || {});
    const contextual = rules.filter((r) => !isBase(r));
    const sel = (s) => scopeSelector(s, scope);
    const containerRules = contextual.some((r) => r.media && widthOnly(r.media));
    return {
      head: [
        vars.length ? `${scope} {\n${vars.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}` : "",
        containerRules ? `${scope} > [data-node-id] { container: weft-artboard / inline-size; }` : "",
        flatCss(rules.filter(isBase), { selector: sel }),
      ].filter(Boolean).join("\n\n"),
      tail: flatCss(contextual, { selector: sel, media: (q) => (widthOnly(q) ? `@container weft-artboard ${widthOnly(q)}` : `@media ${q}`) }),
    };
  }

  // Layers' own styles as rules. `selectorOf(id)` picks how a layer is targeted (default: its data-node-id).
  function layerCss(layers, scope, selectorOf = (id) => `[data-node-id="${id}"]`) {
    return flatCss(layers.filter(([, st]) => st && Object.keys(st).length)
      .map(([id, st]) => ({ selector: `${scope} ${selectorOf(id)}`, styles: st, raw: true })));
  }

  function canvasCss(root, layers, scope) {
    const { head, tail } = canvasCssParts(root, scope);
    return [head, layerCss(layers, scope), tail].filter(Boolean).join("\n\n");
  }

  global.WeftRootCss = {
    VAR_NAME_RE, CLASS_NAME_RE, CANVAS_PREFIX, parse, toText, flatCss, checkSelector, checkMedia, classesIn, definedClasses,
    isBase, canvasCss, canvasCssParts, layerCss, kebab, camel, splitTop,
  };
})(typeof window !== "undefined" ? window : globalThis);
