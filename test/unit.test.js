import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HttpError,
  cleanName,
  cleanTag,
  emptyPage,
  emptyProject,
  lenientMerge,
  mergeAttrs,
  mergeStyles,
  normalizeProject,
  cleanClassList,
  mergeRootCss,
  parseRootCss,
  rootCssText,
  varsIn,
  rootBaseClasses,
  definedRootClasses,
  analyzeRootCssUsage,
  pruneUnusedRootCss,
} from "../server/model.js";
import { htmlToSpecs, parseInlineStyle } from "../server/html-import.js";
import { expandIconSpecs, parseSvgIcon } from "../server/icons.js";
import { FontLibrary, familiesIn, parseFontFileName, renameWithRetry } from "../server/fonts.js";
import { analyzeDesignLint, exportDesignTokens, importDesignTokens } from "../server/design-tokens.js";
import { extractCustomFontFamilies, parseRgbaColor, blendColor, contrastRatio, isLargeText, buildDomAuditScript } from "../server/audit.js";

test("model: cleanTag normalises case and rejects disallowed tags", () => {
  assert.equal(cleanTag("DIV"), "div");
  assert.equal(cleanTag("Section"), "section");
  assert.equal(cleanTag(""), "div");
  assert.equal(cleanTag("svg"), "svg");
  assert.throws(() => cleanTag("script"), HttpError);
  assert.throws(() => cleanTag("iframe"), HttpError);
});

test("model: mergeStyles converts numbers, deletes empty/null, blocks unsafe values", () => {
  const s1 = mergeStyles({}, { width: 320, height: "auto", opacity: 0.5, fontWeight: 600, zIndex: 2 });
  assert.deepEqual(s1, {
    width: "320px",
    height: "auto",
    opacity: "0.5",
    fontWeight: "600",
    zIndex: "2",
  });

  const s2 = mergeStyles(s1, { width: null, height: "", backgroundColor: "#0000ff" });
  assert.deepEqual(s2, {
    opacity: "0.5",
    fontWeight: "600",
    zIndex: "2",
    backgroundColor: "#0000ff",
  });

  assert.throws(() => mergeStyles({}, { "font-size": "12px" }), /camelCase/);
  assert.throws(() => mergeStyles({}, { width: Infinity }), /Invalid number/);
  assert.throws(() => mergeStyles({}, { color: "red; background:url(x)" }), /Unsafe value/);
  assert.throws(() => mergeStyles({}, { backgroundImage: "javascript:alert(1)" }), /Unsafe value/);
  assert.throws(() => mergeStyles({}, { width: "expression(alert(1))" }), /Unsafe value/);
});

test("model: mergeAttrs validates HTML URLs and SVG presentation attributes", () => {
  const a = mergeAttrs({}, { href: "https://example.com", alt: "logo" }, "a");
  assert.deepEqual(a, { href: "https://example.com", alt: "logo" });
  assert.deepEqual(mergeAttrs(a, { href: null }, "a"), { alt: "logo" });

  assert.throws(() => mergeAttrs({}, { href: "javascript:alert(1)" }, "a"), /Unsafe URL/);
  assert.throws(() => mergeAttrs({}, { onclick: "evil()" }, "div"), /not supported/);

  const svg = mergeAttrs({}, { viewBox: "0 0 32 32", fill: "#0000ff", "stroke-width": "2" }, "svg");
  assert.deepEqual(svg, { viewBox: "0 0 32 32", fill: "#0000ff", "stroke-width": "2" });
  assert.throws(() => mergeAttrs({}, { href: "#bad" }, "svg"), /not supported/);
  assert.throws(() => mergeAttrs({}, { fill: "url(#grad)" }, "path"), /Unsafe value/);
});

test("model: mergeAttrs allows safe semantic attributes (type, role, aria-*, title, tabindex, target, rel)", () => {
  assert.deepEqual(
    mergeAttrs({}, { type: "button", role: "switch", "aria-label": "Toggle dark mode", "aria-pressed": "false", title: "Hi", tabindex: "0" }, "button"),
    { type: "button", role: "switch", "aria-label": "Toggle dark mode", "aria-pressed": "false", title: "Hi", tabindex: "0" },
  );
  assert.deepEqual(mergeAttrs({}, { href: "https://x.dev", target: "_blank" }, "a"), { href: "https://x.dev", target: "_blank", rel: "noopener noreferrer" });
  assert.deepEqual(mergeAttrs({}, { target: "_blank", rel: "noopener" }, "a"), { target: "_blank", rel: "noopener" });

  assert.throws(() => mergeAttrs({}, { type: "evil" }, "button"), /Unsupported value for type/);
  assert.throws(() => mergeAttrs({}, { type: "button" }, "div"), /only supported on <button>/);
  assert.throws(() => mergeAttrs({}, { target: "_top" }, "a"), /Unsupported value for target/);
  assert.throws(() => mergeAttrs({}, { role: "x\" onclick=\"y" }, "div"), /Unsafe value for role/);
  assert.throws(() => mergeAttrs({}, { "aria-label": "a\u0000b" }, "div"), /Unsafe value/);
  assert.throws(() => mergeAttrs({}, { "aria-label": "<script>x</script>" }, "div"), /Unsafe value for aria-label/);
  assert.throws(() => mergeAttrs({}, { title: "a > b" }, "div"), /Unsafe value for title/);
  assert.deepEqual(mergeAttrs({}, { "aria-label": "x".repeat(200) }, "div"), { "aria-label": "x".repeat(200) });
  assert.throws(() => mergeAttrs({}, { "aria-label": "x".repeat(201) }, "div"), /too long/);
  assert.deepEqual(mergeAttrs({}, { tabindex: "-1" }, "div"), { tabindex: "-1" });
  for (const bad of ["1.5", "abc", "1000", "0 onclick"]) assert.throws(() => mergeAttrs({}, { tabindex: bad }, "div"), /Unsafe value for tabindex/, bad);
  for (const bad of ["onclick", "onmouseover", "style", "id", "class", "aria-", "data-x"]) {
    assert.throws(() => mergeAttrs({}, { [bad]: "1" }, "div"), /not supported/, bad);
  }
});

test("model: lenientMerge keeps valid properties and records capped warnings", () => {
  const warnings = [];
  const res = lenientMerge(mergeStyles, { width: 100, "bad-key": 12, color: "#0a0b0d", height: "x;y" }, warnings, "Card");
  assert.deepEqual(res, { width: "100px", color: "#0a0b0d" });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Card:/);
});

test("model: cleanName, emptyProject, and normalizeProject handle legacy & malformed docs", () => {
  assert.equal(cleanName("   "), "Untitled");
  assert.equal(cleanName("a".repeat(200)).length, 120);
  assert.equal(emptyPage("Spec", "pg01").name, "Spec");

  const p = emptyProject("abcd1234", "  Demo  ");
  assert.equal(p.id, "abcd1234");
  assert.equal(p.name, "Demo");
  assert.equal(p.pages.length, 1);
  assert.equal(p.nodes[p.rootId].name, "Page 1");

  const warnings = [];
  const legacy = normalizeProject({
    rootId: "root",
    nodes: {
      root: { id: "root", name: "Main", tag: "div", children: ["ab1", "missing", "ab1"] },
      ab1: { id: "ab1", name: "Hero", tag: "script", children: [], text: "Hello", styles: { width: 390, bad: "{bad}" } },
    },
  }, { id: "proj1", warnings });

  assert.deepEqual(legacy.pages, ["root"]);
  assert.deepEqual(legacy.nodes.root.children, ["ab1"]); // deduped & skipped missing
  assert.equal(legacy.nodes.ab1.tag, "div"); // downgraded with warning
  assert.deepEqual(legacy.nodes.ab1.styles, { width: "390px" });
  assert.equal(warnings.length, 2);

  assert.throws(() => normalizeProject({ nodes: {} }), /no pages/);
  assert.throws(() => normalizeProject(null), /nodes object/);
});

test("model: normalizeProject keeps comment page, layer name and resolved time across reloads", () => {
  const doc = {
    rootId: "root",
    nodes: { root: { id: "root", name: "Main", tag: "div", children: [] } },
    comments: [
      { id: "c1", nodeId: "gone1", pageId: "root", layerName: "Deleted card", status: "resolved", resolvedAt: "2026-01-02T00:00:00.000Z", messages: [{ text: "hi" }] },
      { id: "c2", nodeId: "n2", pageId: "../../x", layerName: 42, messages: [{ text: "yo" }] },
    ],
  };
  const [kept, cleaned] = normalizeProject(doc, { id: "p1" }).comments;
  assert.equal(kept.pageId, "root");
  assert.equal(kept.layerName, "Deleted card");
  assert.equal(kept.resolvedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(cleaned.pageId, undefined, "invalid page ids are dropped");
  assert.equal(cleaned.layerName, undefined, "non-string layer names are dropped");
});

test("html-import: parseInlineStyle handles urls, quotes, vendor prefixes, and custom props", () => {
  const styles = parseInlineStyle(
    "color: #0000ff !important; background-image: url('data:image/svg+xml;utf8,<svg/>'); -webkit-backdrop-filter: blur(8px); --token: 4px; font-size: 16px;"
  );
  assert.deepEqual(styles, {
    color: "#0000ff",
    backgroundImage: "url('data:image/svg+xml;utf8,<svg/>')",
    WebkitBackdropFilter: "blur(8px)",
    fontSize: "16px",
  });
});

test("html-import: htmlToSpecs parses layout, aliases, SVG namespace, mixed text, and strips scripts", () => {
  const { specs, warnings } = htmlToSpecs(`
    <!-- ignored comment -->
    <script>alert(1)</script>
    <section data-name="Hero Card" class="hero" onclick="bad()" style="display:flex; flex-direction:column; gap:12px">
      <h1>Welcome <b>team</b> today</h1>
      <svg viewBox="0 0 24 24"><defs><path d="M1 1 L10 10"/></defs></svg>
      <img src="https://example.com/a.png" alt="Preview">
    </section>
  `);
  assert.equal(specs.length, 1);
  assert.deepEqual(warnings, [`Event handler attribute "onclick" isn't allowed; dropped`]);
  assert.deepEqual(specs[0].classes, ["hero"], "class names are kept for the root CSS");

  const root = specs[0];
  assert.equal(root.name, "Hero Card");
  assert.equal(root.tag, "section");
  assert.equal(root.styles.flexDirection, "column");
  assert.equal(root.children.length, 3);

  const h1 = root.children[0];
  assert.equal(h1.tag, "h1");
  assert.equal(h1.children.length, 3);
  assert.equal(h1.children[0].text, "Welcome ");
  assert.equal(h1.children[1].tag, "strong");
  assert.equal(h1.children[1].text, "team");
  assert.equal(h1.children[2].text, " today");

  const svg = root.children[1];
  assert.equal(svg.tag, "svg");
  assert.equal(svg.attrs.viewBox, "0 0 24 24");
  assert.equal(svg.children[0].tag, "g"); // defs -> g alias

  const img = root.children[2];
  assert.equal(img.tag, "img");
  assert.equal(img.attrs.alt, "Preview");
});

test("html-import: lossy tag mappings warn once per tag; same-meaning swaps stay quiet", () => {
  const { specs, warnings } = htmlToSpecs(`<b>x</b><i>y</i><table><tr><td>a</td><td>b</td></tr></table><table></table><input>`);
  assert.deepEqual(specs.map((s) => s.tag), ["strong", "em", "div", "div", "div"]);
  assert.equal(warnings.filter((w) => /<table>/.test(w)).length, 1, "one warning per tag, not per element");
  assert.equal(warnings.filter((w) => /<td>/.test(w)).length, 1);
  assert.ok(warnings.some((w) => /<tr>/.test(w)) && warnings.some((w) => /<input>/.test(w)));
  assert.ok(!warnings.some((w) => /<b>|<i>/.test(w)), "b/i map silently");
  assert.deepEqual(htmlToSpecs("<b>bold</b><em>e</em>").warnings, []);
});

test("fonts: parseFontFileName, familiesIn, and FontLibrary manage Google and uploaded fonts", async () => {
  assert.deepEqual(parseFontFileName("Inter-SemiBoldItalic.woff2"), { family: "Inter", weight: 600, style: "italic" });
  assert.deepEqual(parseFontFileName("GeistMono_VariableFont[wght].ttf"), { family: "Geist Mono", weight: 400, style: "normal" });
  assert.deepEqual(familiesIn("'Geist', system-ui, sans-serif"), ["Geist", "system-ui", "sans-serif"]);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pl-fonts-"));
  try {
    const lib = new FontLibrary(tmp);
    await lib.load();
    assert.ok(lib.families().includes("Geist"));
    assert.ok(lib.families().includes("Geist Mono"));

    await assert.rejects(() => lib.remove("builtin-geist"), /Built-in fonts/);

    const g = await lib.addGoogle({ family: "Space Grotesk", axes: "wght@400;700" });
    assert.equal(g.source, "google");
    await assert.rejects(() => lib.addGoogle({ family: "Space Grotesk" }), /already in the library/);
    await assert.rejects(() => lib.addGoogle({ family: "Bad;Font" }), /Invalid Google Fonts/);

    // Minimal valid WOFF2 header signature
    const woff2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(64)]);
    const up = await lib.addUpload({ fileName: "CustomSans-Bold.woff2", data: woff2 });
    assert.equal(up.format, "woff2");
    assert.equal(up.weight, 700);
    assert.equal(up.family, "Custom Sans");
    assert.ok(lib.fileFor(up.file));

    const css = lib.css({ families: ["Space Grotesk", "Custom Sans"], baseUrl: "http://localhost:3000" });
    assert.match(css, /fonts\.googleapis\.com\/css2\?family=Space\+Grotesk:wght@400;700/);
    assert.match(css, /@font-face/);
    assert.match(css, /Custom Sans/);

    await assert.rejects(() => lib.addUpload({ fileName: "bad.woff2", data: Buffer.from("NOTAFONT") }), /Not a font file/);

    await lib.remove(up.id);
    assert.equal(lib.fileFor(up.file), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("fonts: overlapping library changes all succeed and are all saved", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pl-fonts-race-"));
  try {
    const lib = new FontLibrary(tmp);
    await lib.load();
    const families = ["Inter", "Manrope", "Sora", "Outfit", "Lexend", "Urbanist", "Figtree", "Onest"];
    const added = await Promise.all(families.map((family) => lib.addGoogle({ family })));
    await Promise.all(added.slice(0, 3).map((f) => lib.remove(f.id)));

    const onDisk = JSON.parse(await fs.readFile(path.join(tmp, "fonts.json"), "utf8")).map((f) => f.family).sort();
    assert.deepEqual(onDisk, families.slice(3).sort(), "fonts.json reflects every change");
    assert.deepEqual((await fs.readdir(tmp)).filter((f) => f.endsWith(".tmp")), [], "no temp files left");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("fonts: renameWithRetry renames, and fails fast on errors that aren't transient locks", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pl-rename-"));
  try {
    const a = path.join(tmp, "a.json"), b = path.join(tmp, "b.json");
    await fs.writeFile(a, "{}");
    await renameWithRetry(a, b);
    assert.equal(await fs.readFile(b, "utf8"), "{}");
    const t0 = Date.now();
    await assert.rejects(() => renameWithRetry(path.join(tmp, "missing.json"), b), { code: "ENOENT" });
    assert.ok(Date.now() - t0 < 100, "a missing file is not retried");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("audit: WCAG color, contrast, font extraction, and script generation", () => {
  assert.deepEqual(
    extractCustomFontFamilies("'Bebas Neue', 'Inter', system-ui, sans-serif"),
    ["Bebas Neue", "Inter"],
  );
  assert.deepEqual(extractCustomFontFamilies("system-ui, -apple-system, sans-serif"), []);

  assert.deepEqual(parseRgbaColor("rgb(255, 0, 128)"), { r: 255, g: 0, b: 128, a: 1 });
  assert.deepEqual(parseRgbaColor("rgba(0, 0, 0, 0.5)"), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.equal(parseRgbaColor("not-a-color"), null);

  const halfBlackOnWhite = blendColor({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(Math.round(halfBlackOnWhite.r), 128);

  assert.equal(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)"), 21);
  assert.ok(contrastRatio("rgb(153, 153, 153)", "rgb(255, 255, 255)") < 4.5);
  assert.ok(contrastRatio("rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)") < 4.5);

  assert.equal(isLargeText("24px", "400"), true);
  assert.equal(isLargeText("19px", "700"), true);
  assert.equal(isLargeText("16px", "400"), false);

  const script = buildDomAuditScript({ artboardId: "ab123456", width: 390, checkContrast: true });
  assert.match(script, /ab123456/);
  assert.match(script, /brokenImages/);
  assert.match(script, /lowContrast/);
});

test("root CSS: nesting, states and @media parse into ordered rules and round-trip as text", () => {
  const css = `/* brand */
    :root { --brand: #0000ff; --pad: 16px }
    @media (prefers-color-scheme: dark) { :root { --brand: #9ab8ff; } }
    .card {
      padding: var(--pad);
      &:hover { box-shadow: 0 1px 2px #000; }
      & > .title { font-size: 20px; }
      .icon, .badge { width: 16px; }
      &__footer { margin-top: 8px; }
      &.is-active:not(:first-child) { outline: 1px solid var(--brand); }
      @media (max-width: 640px) { padding: 8px; &:hover { box-shadow: none; } @media (min-width: 320px) { gap: 4px; } }
    }
    ul li:nth-child(2n + 1)::before { content: "•"; }
    .btn:has(> svg) { gap: 6px; --btn-gap: 6px; }`;
  const parsed = parseRootCss(css);
  assert.deepEqual(parsed.vars, { "--brand": "#0000ff", "--pad": "16px" });
  assert.deepEqual(parsed.rules.map((r) => [r.selector, r.media || ""]), [
    [":root", "(prefers-color-scheme: dark)"],
    [".card", ""],
    [".card:hover", ""],
    [".card > .title", ""],
    [".card .icon, .card .badge", ""],
    [".card__footer", ""],
    [".card.is-active:not(:first-child)", ""],
    [".card", "(max-width: 640px)"],
    [".card:hover", "(max-width: 640px)"],
    [".card", "(max-width: 640px) and (min-width: 320px)"],
    ["ul li:nth-child(2n + 1)::before", ""],
    [".btn:has(> svg)", ""],
  ]);
  assert.deepEqual(parsed.rules[11].styles, { gap: "6px", "--btn-gap": "6px" }, "classes can scope their own variables");

  const root = mergeRootCss(null, { css }, { replace: true });
  const text = rootCssText(root);
  assert.match(text, /^\.card \{\n {2}padding: var\(--pad\);\n {2}&:hover \{\n {4}box-shadow: 0 1px 2px #000;\n {2}\}\n {2}& > \.title \{/m, "rules nest under their class");
  assert.match(text, / {2}@media \(max-width: 640px\) \{\n {4}padding: 8px;\n {4}&:hover \{/);
  assert.deepEqual(mergeRootCss(null, { css: text }, { replace: true }), root, "the text round-trips exactly");
  assert.deepEqual(definedRootClasses(root).sort(), ["badge", "btn", "card", "card__footer", "icon", "is-active", "title"]);
  assert.deepEqual(rootBaseClasses(root), { card: { padding: "var(--pad)" }, card__footer: { marginTop: "8px" } });

  for (const [bad, why] of [
    ["#id { color: red; }", /ids and attribute selectors/],
    [".a[href] { color: red; }", /ids and attribute selectors/],
    ["& { color: red; }", /& only works inside a rule/],
    [".a { color: red;", /Missing "\}"/],
    [".a { color: red; } }", /Unexpected "\}"/],
    ["@supports (display: grid) { .a { color: red; } }", /@supports isn't supported/],
    [".a:hoverx { color: red; }", /:hoverx isn't supported/],
    ["table { color: red; }", /<table> isn't a canvas tag/],
    ["color: red;", /needs a selector/],
    [".a::before .b { color: red; }", /Nothing can follow a pseudo-element/],
    [":root { color: red; }", /only holds variables/],
    [".a { :root { --x: 1px; } }", /:root can't be nested/],
    [".a:nth-child(foo) { color: red; }", /Bad :nth-child\(\) argument/],
    ["@media { .a { color: red; } }", /needs a query/],
    ["@media (max-width: 1px), print { .a { @media (min-width: 1px) { color: red; } } }", /comma lists/],
    [".a { b { c { d { e { f { g { h { i { color: red; } } } } } } } } }", /Nesting is limited|isn't a canvas tag/],
    [".a { color red; }", /Bad declaration/],
    ["/* open", /Unclosed/],
  ]) assert.throws(() => parseRootCss(bad), why, bad);
  assert.throws(() => mergeRootCss(null, { css: ".a { color: red; } } .b { x: y }" }), (err) => err instanceof HttpError && err.status === 400);
  assert.throws(() => mergeRootCss(null, { css: ".a { background: url(javascript:alert(1)); }" }), /Unsafe value/);
  assert.throws(() => mergeRootCss(null, { css: ".a { color: red</style> }" }), /Unsafe value|Bad declaration/);
});

test("root CSS: merging text, vars and classes keeps rule order and validates everything", () => {
  let root = mergeRootCss(null, { css: ".card { padding: 4px; &:hover { color: red; } }" });
  root = mergeRootCss(root, { css: ".card { margin: 0; } .pill { border-radius: 999px; }", vars: { "--gap": 8 } });
  assert.deepEqual(root.rules.map((r) => r.selector), [".card", ".card:hover", ".pill"], "same selector + media merges in place");
  assert.deepEqual(root.rules[0].styles, { padding: "4px", margin: "0" });
  assert.equal(root.vars["--gap"], "8");
  root = mergeRootCss(root, { classes: { card: { padding: null }, chip: { gap: 4 }, pill: null } });
  assert.deepEqual(root.rules.map((r) => r.selector), [".card", ".card:hover", ".chip"]);
  assert.equal(root.rules[2].styles.gap, "4px");
  assert.deepEqual(mergeRootCss(root, { classes: { card: { margin: null } } }).rules.map((r) => r.selector), [".card:hover", ".chip"], "an emptied rule is removed");
  const replaced = mergeRootCss(root, { css: ".a { color: red; } .b { color: blue; } .a { color: green; }" }, { replace: true });
  assert.deepEqual(replaced.rules.map((r) => r.selector), [".a", ".b", ".a"], "replace keeps the author's order exactly");
  assert.deepEqual(replaced.vars, {});
  assert.equal(root.rules[0].styles.margin, "0", "merging never mutates the base");
  assert.throws(() => mergeRootCss(null, { vars: { color: "red" } }), /--color-primary/);
  assert.throws(() => mergeRootCss(null, { classes: { "a b": {} } }), /start with a letter/);
  assert.throws(() => mergeRootCss(null, { classes: { a: { "font-size": "1px" } } }), /camelCase/);
  assert.throws(() => mergeRootCss(null, { classes: { a: ["bad"] } }), /object of camelCase/);

  assert.deepEqual(cleanClassList("card  card primary"), ["card", "primary"]);
  assert.deepEqual(cleanClassList(["a", "", null]), ["a"]);
  assert.throws(() => cleanClassList(["9lives"]), /start with a letter/);
  assert.deepEqual(varsIn("1px solid var(--line, var(--fallback))"), ["--line", "--fallback"]);
});

test("root CSS: key cleaning, null deletions, @media canonicalization, and unused CSS pruning", () => {
  // P0 #1: quoted/trimmed keys and null deletions on both vars and classes
  let root = mergeRootCss(null, {
    vars: { "\"--nf-border\"": "1px solid #333", " --nf-keep ": "#fff" },
    classes: { "\"nf-mobile-btn-list\"": { display: "flex", gap: 8 }, "nf-card": { padding: 12 } },
  });
  assert.deepEqual(root.vars, { "--nf-border": "1px solid #333", "--nf-keep": "#fff" });
  assert.deepEqual(rootBaseClasses(root), {
    "nf-mobile-btn-list": { display: "flex", gap: "8px" },
    "nf-card": { padding: "12px" },
  });
  root = mergeRootCss(root, { vars: { "--nf-border": null }, classes: { "nf-mobile-btn-list": null } });
  assert.deepEqual(root.vars, { "--nf-keep": "#fff" });
  assert.deepEqual(rootBaseClasses(root), { "nf-card": { padding: "12px" } });

  root = mergeRootCss(root, { vars: { " \"--nf-keep\" ": null }, classes: { "'nf-card'": null } });
  assert.deepEqual(root.vars, {});
  assert.deepEqual(root.rules, []);

  // P0 #2: canonical @media normalization & coalescing between top-level and nested @media
  const fromTopAndNested = mergeRootCss(null, {
    css: `
      .nf-card { padding: 16px; @media (max-width:640px) { padding: 8px; } }
      @media ( max-width : 640px ) { .nf-card { margin: 4px; gap: 6px; } }
    `,
  }, { replace: true });
  const mediaRules = fromTopAndNested.rules.filter((r) => r.selector === ".nf-card" && r.media);
  assert.equal(mediaRules.length, 1, "top-level and nested @media coalesce into one canonical rule");
  assert.equal(mediaRules[0].media, "(max-width: 640px)");
  assert.deepEqual(mediaRules[0].styles, { padding: "8px", margin: "4px", gap: "6px" });

  // Incremental update into nested @media merges cleanly too
  const updatedMedia = mergeRootCss(fromTopAndNested, {
    css: "@media (max-width: 640px) { .nf-card { gap: 10px; } }",
  });
  assert.equal(updatedMedia.rules.filter((r) => r.selector === ".nf-card" && r.media).length, 1);
  assert.equal(updatedMedia.rules[1].styles.gap, "10px");

  // P0 #3: analyzeRootCssUsage (with transitive vars) and pruneUnusedRootCss
  const sys = mergeRootCss(null, {
    css: `
      :root {
        --base-blue: #0055ff;
        --brand: var(--base-blue);
        --dead-base: #999999;
        --dead-var: var(--dead-base);
        --inline-only: 14px;
      }
      @media (prefers-color-scheme: dark) {
        :root { --brand: #9ab8ff; --dead-var: #111111; }
      }
      .used-btn { color: var(--brand); }
      .dead-btn { color: var(--dead-var); }
    `,
  });
  const nodes = {
    a: { id: "a", tag: "button", classes: ["used-btn"], styles: { fontSize: "var(--inline-only)" } },
  };
  const report = analyzeRootCssUsage(sys, nodes);
  assert.deepEqual(report.usage, { "used-btn": 1 });
  assert.deepEqual(report.unusedClasses, ["dead-btn"]);
  assert.deepEqual(report.unusedVars.sort(), ["--dead-base", "--dead-var"]);

  const pruned = pruneUnusedRootCss(sys, nodes);
  assert.deepEqual(Object.keys(pruned.vars).sort(), ["--base-blue", "--brand", "--inline-only"]);
  assert.deepEqual(definedRootClasses(pruned), ["used-btn"]);
  const darkVars = pruned.rules.find((r) => r.selector === ":root")?.styles;
  assert.deepEqual(darkVars, { "--brand": "#9ab8ff" }, "unused dark-mode var is pruned too");
});

test("normalizeProject keeps root CSS and layer classes, dropping invalid entries leniently", () => {
  const raw = {
    pages: ["p"], rootId: "p",
    nodes: { p: { name: "Page", tag: "div", children: ["a"] }, a: { name: "A", tag: "div", children: [], classes: ["card", "bad name", "card"] } },
    rootCss: {
      vars: { "--ok": "1px", nope: "2px" },
      rules: [{ selector: ".card:hover", styles: { color: "red" } }, { selector: "#bad", styles: { color: "red" } }, { selector: ".x", media: "(max-width: 1px)", styles: { "bad-key": "1px" } }],
      classes: { card: { padding: "4px" } },
    },
  };
  const warnings = [];
  const doc = normalizeProject(raw, { warnings });
  assert.deepEqual(doc.rootCss, { vars: { "--ok": "1px" }, rules: [{ selector: ".card:hover", styles: { color: "red" } }, { selector: ".card", styles: { padding: "4px" } }] }, "older { classes } saves become rules");
  assert.deepEqual(doc.nodes.a.classes, ["card"], "valid names are kept, invalid ones reported");
  assert.ok(warnings.length >= 4, warnings.join("\n"));
  assert.throws(() => normalizeProject({ ...raw, nodes: { p: raw.nodes.p, a: { ...raw.nodes.a, classes: ["card"] } } }), /look like --color-primary/, "strict loading rejects bad root CSS");
  assert.deepEqual(normalizeProject({ nodes: { p: { name: "P", tag: "div" } }, pages: ["p"] }).rootCss, { vars: {}, rules: [] }, "older projects get an empty root CSS");
});

test("icons: parseSvgIcon validates/sanitises SVG assets and expandIconSpecs expands self-closing <icon />", () => {
  const icon = parseSvgIcon("nf-n", '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 2V22M20 2V22" stroke="#e50914" stroke-width="4"/></svg>');
  assert.equal(icon.name, "nf-n");
  assert.equal(icon.viewBox, "0 0 24 24");
  assert.equal(icon.children.length, 1);

  assert.throws(() => parseSvgIcon("bad name", "<svg><path d='M0 0'/></svg>"), /letters, digits/);
  assert.throws(() => parseSvgIcon("bad-url", '<svg><path d="M0 0" fill="url(#g)"/></svg>'), /unsafe/i);
  assert.throws(() => parseSvgIcon("bad-script", '<svg><script>alert(1)</script></svg>'), /unsafe/i);
  assert.throws(() => parseSvgIcon("bad-use", '<svg><use href="#x"/></svg>'), /unsafe/i);

  const { specs, warnings } = htmlToSpecs('<div><icon name="nf-n" width="16" style="opacity: 0.8" /><icon name="missing" /><span>Title</span></div>');
  const expanded = expandIconSpecs(specs, { "nf-n": icon }, warnings);
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].children.length, 2, "self-closing <icon /> does not swallow following sibling and missing icon is skipped");
  assert.equal(expanded[0].children[0].tag, "svg");
  assert.equal(expanded[0].children[0].attrs.width, "16");
  assert.equal(expanded[0].children[0].styles.opacity, "0.8");
  assert.equal(expanded[0].children[1].tag, "span");
  assert.ok(warnings.some((w) => /missing.*isn't registered/.test(w)));

  const doc = normalizeProject({
    pages: ["p"], rootId: "p",
    nodes: { p: { name: "P", tag: "div", children: [] } },
    icons: { "nf-n": icon },
  }, { id: "icproj" });
  assert.equal(doc.icons["nf-n"].viewBox, "0 0 24 24");
});

test("design-tokens: W3C DTCG export/import round-trips vars, aliases, collisions and composites", () => {
  const doc = {
    rootCss: {
      vars: {
        "--color-primary": "#0000ff",
        "--color-accent": "var(--color-primary)",
        "--radius": "12px",
        "--radius-lg": "20px",
        "--space-4": "16px",
        "--font-ui": "'Geist', sans-serif",
      },
      rules: [],
    },
  };
  const tokens = exportDesignTokens(doc);
  assert.equal(tokens.color.primary.$type, "color");
  assert.equal(tokens.color.accent.$value, "{color.primary}");
  assert.equal(tokens.radius.$root.$value, "12px", "leaf/group collision uses $root");
  assert.equal(tokens.radius.lg.$value, "20px");
  assert.equal(tokens.font.ui.$type, "fontFamily");

  const reimported = importDesignTokens(tokens);
  assert.deepEqual(reimported.vars, doc.rootCss.vars, "W3C tokens round-trip back to :root vars losslessly");

  const dtcg = importDesignTokens({
    spacing: { $type: "dimension", sm: { $value: { value: 8, unit: "px" } } },
    brand: { $type: "color", base: { $value: { colorSpace: "srgb", components: [1, 0, 0] } }, alias: { $value: "{brand.base}" } },
    heading: { $type: "typography", $value: { fontFamily: ["Inter", "sans-serif"], fontSize: { value: 24, unit: "px" } } },
  });
  assert.equal(dtcg.vars["--spacing-sm"], "8px");
  assert.equal(dtcg.vars["--brand-base"], "#ff0000");
  assert.equal(dtcg.vars["--brand-alias"], "var(--brand-base)");
  assert.equal(dtcg.vars["--heading-font-family"], "Inter, sans-serif");
  assert.equal(dtcg.vars["--heading-font-size"], "24px");
});

test("design-tokens: analyzeDesignLint catches spacing, radii, font-size, shorthand and color tokens", () => {
  const doc = {
    pages: ["p1"],
    nodes: {
      p1: { id: "p1", children: ["n1"] },
      n1: {
        id: "n1",
        name: "Card",
        parentId: "p1",
        styles: {
          padding: "12px 16px",
          borderRadius: "10px",
          fontSize: "19px",
          color: "rgb(0, 0, 255)",
          backgroundColor: "#ff00ff",
        },
      },
    },
    rootCss: {
      vars: {
        "--color-primary": "#0000ff",
        "--space-3": "12px",
        "--space-4": "16px",
        "--radius-md": "8px",
        "--font-size-md": "16px",
      },
      rules: [],
    },
  };
  const hints = analyzeDesignLint(["n1"], doc);
  assert.ok(hints.some((h) => /12px 16px repeats root variable values/.test(h)), hints.join("\n"));
  assert.ok(hints.some((h) => /borderRadius: 10px doesn't use a radius token/.test(h)), hints.join("\n"));
  assert.ok(hints.some((h) => /fontSize: 19px doesn't use a font-size token/.test(h)), hints.join("\n"));
  assert.ok(hints.some((h) => /color: rgb\(0, 0, 255\) matches the root variable --color-primary/.test(h)), hints.join("\n"));
  assert.ok(hints.some((h) => /backgroundColor: #ff00ff doesn't use a color token/.test(h)), hints.join("\n"));
  assert.deepEqual(analyzeDesignLint(["n1"], doc, { lint: false }), []);
});

test("design-tokens: analyzeDesignLint only suggests tokens of the property's category; lint:false silences suggestions", () => {
  const mk = (styles) => ({
    pages: ["p1"],
    nodes: { p1: { id: "p1", children: ["n1"] }, n1: { id: "n1", name: "Box", parentId: "p1", styles } },
    rootCss: {
      vars: {
        "--radius-lg": "18px", "--radius-md": "12px", "--fs-md": "16px", "--space-3": "12px",
        "--color-x": "#123456", "--shadow-float": "0 8px 24px rgba(0,0,0,.12)", "--size-18": "18px",
      },
      rules: [],
    },
  });
  const run = (styles, opts) => analyzeDesignLint(["n1"], mk(styles), opts);

  let h = run({ fontSize: "18px" });
  assert.ok(!h.some((x) => /--radius-lg/.test(x)), h.join("\n"));
  assert.ok(h.some((x) => /fontSize: 18px is the root variable --size-18/.test(x)), "uncategorized variables still match: " + h.join("\n"));

  h = run({ padding: "16px" });
  assert.ok(!h.some((x) => /--fs-md/.test(x)), h.join("\n"));

  h = run({ gap: "12px" });
  assert.ok(h.some((x) => /gap: 12px is the root variable --space-3; use var\(--space-3\) so/.test(x)), h.join("\n"));
  assert.ok(!h.some((x) => /--radius-md/.test(x)), h.join("\n"));

  h = run({ borderRadius: "18px", fontSize: "12px", width: "18px" });
  assert.ok(h.some((x) => /borderRadius: 18px is the root variable --radius-lg( \/ --size-18)?;/.test(x)), h.join("\n"));
  assert.ok(!h.some((x) => /fontSize: 12px.*(--space-3|--radius-md)/.test(x)), h.join("\n"));
  assert.ok(!h.some((x) => /width: 18px.*--radius-lg/.test(x)), h.join("\n"));

  h = run({ color: "#123456", border: "1px solid #123456", boxShadow: "0 8px 24px rgba(0,0,0,.12)" });
  assert.ok(h.some((x) => /color: #123456 is the root variable --color-x/.test(x)), h.join("\n"));
  assert.ok(h.some((x) => /border: 1px solid #123456 repeats root variable values \(#123456 → var\(--color-x\)\)/.test(x)), h.join("\n"));
  assert.ok(h.some((x) => /boxShadow: .* is the root variable --shadow-float/.test(x)), h.join("\n"));

  assert.deepEqual(run({ fontSize: "18px", color: "#123456", padding: "16px" }, { lint: false }), [], "lint:false emits no token suggestions");
  h = run({ color: "var(--missing)" }, { lint: false });
  assert.ok(h.some((x) => /var\(--missing\) isn't defined/.test(x)), "unknown variables are still reported with lint:false");
});

test("htmlToSpecs captures data-component and data-slot, and normalizeProject preserves components", () => {
  const { specs } = htmlToSpecs('<div data-component="hero-card"><span data-slot="title">Hi</span></div>');
  assert.equal(specs[0].component, "hero-card");
  assert.equal(specs[0].children[0].slot, "title");

  const doc = normalizeProject({
    pages: ["p"],
    rootId: "p",
    nodes: {
      p: { name: "Page", tag: "div", children: ["c1"] },
      c1: {
        name: "Card", tag: "div", children: [],
        componentId: "hero-card", componentKey: "root",
        componentOverrides: { text: true, styles: ["width", "bad-style!"] },
      },
    },
    components: {
      "hero-card": {
        id: "hero-card",
        name: "hero-card",
        tree: { key: "root", tag: "div", name: "Card", text: "", styles: { padding: 12 }, attrs: {}, children: [] },
      },
      "bad name": { id: "bad name", tree: { key: "root", tag: "div", children: [] } },
    },
  }, { warnings: [] });

  assert.ok(doc.components["hero-card"]);
  assert.equal(doc.components["bad name"], undefined);
  assert.equal(doc.components["hero-card"].tree.styles.padding, "12px");
  assert.deepEqual(doc.nodes.c1.componentOverrides, { text: true, styles: ["width"] });
});

test("ui time: stamp shows the date for steps that aren't from today", async () => {
  const { clock, stamp, fullStamp } = await import("../ui/src/editor/time.js");
  const now = new Date(2026, 10, 28, 12, 0, 0);
  const today = new Date(2026, 10, 28, 9, 5, 0).toISOString();
  const yesterday = new Date(2026, 10, 27, 9, 5, 0).toISOString();
  const lastYear = new Date(2025, 2, 1, 9, 5, 0).toISOString();
  assert.equal(stamp(today, now), clock(today), "today: time only");
  assert.notEqual(stamp(yesterday, now), clock(yesterday));
  assert.ok(stamp(yesterday, now).endsWith(clock(yesterday)), "other days: date then time");
  assert.match(stamp(lastYear, now), /2025/, "another year shows the year");
  assert.doesNotMatch(stamp(yesterday, now), /2026/, "this year's dates omit the year");
  assert.match(fullStamp(yesterday), /2026/);
  assert.equal(stamp("not a date", now), "");
  assert.equal(fullStamp(undefined), "");
});
