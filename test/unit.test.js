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
} from "../model.js";
import { htmlToSpecs, parseInlineStyle } from "../html-import.js";
import { FontLibrary, familiesIn, parseFontFileName } from "../fonts.js";

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
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /classes are ignored/);

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
