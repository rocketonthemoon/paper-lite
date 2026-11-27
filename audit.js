// Artboard rendering & DOM health diagnostics: pure WCAG contrast/font helpers + Chrome DOM audit script.

export const GENERIC_FONT_FAMILIES = new Set([
  "system-ui", "sans-serif", "serif", "monospace", "cursive", "fantasy",
  "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
  "emoji", "math", "fangsong", "-apple-system", "blinkmacsystemfont",
  "inherit", "initial", "unset", "revert",
]);

export function extractCustomFontFamilies(fontFamilyCss) {
  const out = [];
  for (const raw of String(fontFamilyCss || "").split(",")) {
    const clean = raw.trim().replace(/^['"]|['"]$/g, "").trim();
    if (!clean) continue;
    if (GENERIC_FONT_FAMILIES.has(clean.toLowerCase())) continue;
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

export function parseRgbaColor(css) {
  const m = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(String(css || "").trim());
  if (!m) return null;
  return {
    r: Math.max(0, Math.min(255, Number(m[1]))),
    g: Math.max(0, Math.min(255, Number(m[2]))),
    b: Math.max(0, Math.min(255, Number(m[3]))),
    a: m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4]))),
  };
}

export function blendColor(fg, bg) {
  const a = fg.a ?? 1;
  if (a >= 0.999) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  const inv = 1 - a;
  return {
    r: fg.r * a + bg.r * inv,
    g: fg.g * a + bg.g * inv,
    b: fg.b * a + bg.b * inv,
    a: a + (bg.a ?? 1) * inv,
  };
}

export function relativeLuminance({ r, g, b }) {
  const chan = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

export function contrastRatio(fgCss, bgCss) {
  const fg = typeof fgCss === "string" ? parseRgbaColor(fgCss) : fgCss;
  const bg = typeof bgCss === "string" ? parseRgbaColor(bgCss) : bgCss;
  if (!fg || !bg) return null;
  const composited = fg.a < 0.999 ? blendColor(fg, bg) : fg;
  const l1 = relativeLuminance(composited);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export function isLargeText(fontSizePx, fontWeight) {
  const size = parseFloat(fontSizePx) || 0;
  const weight = parseFloat(fontWeight) || 400;
  return size >= 24 || (size >= 18.66 && weight >= 700);
}

/**
 * Browser-side evaluation script for auditing a rendered artboard inside headless Chrome.
 */
export function buildDomAuditScript({ artboardId, width, checkContrast = false, checkTapTargets }) {
  const tapEnabled = checkTapTargets === undefined ? width <= 480 : Boolean(checkTapTargets);
  return `(() => {
    const GENERIC = new Set(${JSON.stringify([...GENERIC_FONT_FAMILIES])});
    const parseRgba = (s) => {
      const m = /^rgba?\\(\\s*([\\d.]+)\\s*[,\\s]\\s*([\\d.]+)\\s*[,\\s]\\s*([\\d.]+)(?:\\s*[,/]\\s*([\\d.]+))?\\s*\\)$/i.exec(String(s || "").trim());
      if (!m) return null;
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    };
    const blend = (fg, bg) => {
      const a = fg.a ?? 1;
      if (a >= 0.999) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
      const inv = 1 - a;
      return { r: fg.r * a + bg.r * inv, g: fg.g * a + bg.g * inv, b: fg.b * a + bg.b * inv, a: a + (bg.a ?? 1) * inv };
    };
    const lum = ({ r, g, b }) => {
      const ch = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const ratioOf = (fg, bg) => {
      const c = fg.a < 0.999 ? blend(fg, bg) : fg;
      const l1 = lum(c), l2 = lum(bg);
      return Number(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
    };

    const root = document.querySelector('[data-layer="${artboardId}"], .layer-${artboardId}');
    if (!root) return { error: "Artboard not found in rendered DOM" };
    const rootRect = root.getBoundingClientRect();
    const rootCs = getComputedStyle(root);
    const layers = [root, ...root.querySelectorAll("[data-layer]")];

    const brokenImages = [];
    const overflows = [];
    const tapTargets = [];
    const lowContrast = [];
    const fontRefs = new Map();
    const loadedFaces = new Map();
    for (const face of document.fonts) {
      const fam = String(face.family || "").replace(/^['"]|['"]$/g, "").trim().toLowerCase();
      if (!fam) continue;
      const prev = loadedFaces.get(fam);
      if (face.status === "loaded") loadedFaces.set(fam, "loaded");
      else if (!prev) loadedFaces.set(fam, face.status);
    }

    for (const el of layers) {
      const nodeId = el.getAttribute("data-layer") || "${artboardId}";
      const tag = el.tagName.toLowerCase();
      if (el.closest("svg") && tag !== "svg") continue;

      if (tag === "img") {
        if (!el.complete || el.naturalWidth === 0) {
          brokenImages.push({ nodeId, src: el.getAttribute("src") || "", alt: el.getAttribute("alt") || "" });
        }
      }

      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (rect.width >= 1 || rect.height >= 1) {
        const checkBox = cs.display !== "inline" && tag !== "svg";
        const horizOverflow = checkBox && cs.overflowX !== "auto" && cs.overflowX !== "scroll" && el.scrollWidth > el.clientWidth + 1;
        const clippedX = checkBox && (cs.overflowX === "hidden" || cs.overflowX === "clip") && el.scrollWidth > el.clientWidth + 2;
        const clippedY = checkBox && (cs.overflowY === "hidden" || cs.overflowY === "clip") && el.scrollHeight > el.clientHeight + 2;
        const childOutOfArtboard = el !== root && rect.right > rootRect.right + 2 && (rootCs.overflowX === "hidden" || rootCs.overflowX === "clip");
        if (horizOverflow || clippedX || clippedY || childOutOfArtboard) {
          overflows.push({
            nodeId,
            tag,
            type: childOutOfArtboard ? "exceeds-artboard-width" : horizOverflow ? "horizontal-overflow" : "clipped",
            scrollWidth: Math.round(el.scrollWidth),
            clientWidth: Math.round(el.clientWidth),
            scrollHeight: Math.round(el.scrollHeight),
            clientHeight: Math.round(el.clientHeight),
          });
        }
      }

      const hasDirectText = [...el.childNodes].some((c) => c.nodeType === 3 && c.nodeValue.trim());
      if (hasDirectText || tag === "button" || tag === "a") {
        const rawFamilies = String(cs.fontFamily || "").split(",").map((f) => f.trim().replace(/^['"]|['"]$/g, "").trim()).filter(Boolean);
        for (const fam of rawFamilies) {
          const lower = fam.toLowerCase();
          if (GENERIC.has(lower)) break;
          if (!fontRefs.has(fam)) fontRefs.set(fam, new Set());
          fontRefs.get(fam).add(nodeId);
        }
      }

      if (${tapEnabled} && (tag === "button" || tag === "a") && cs.visibility !== "hidden" && rect.width > 0 && rect.height > 0) {
        if (rect.width < 44 || rect.height < 44) {
          tapTargets.push({ nodeId, tag, width: Math.round(rect.width), height: Math.round(rect.height), minRecommended: 44 });
        }
      }

      if (${Boolean(checkContrast)} && hasDirectText && cs.visibility !== "hidden" && Number(cs.opacity) > 0) {
        const fg = parseRgba(cs.color);
        if (fg) {
          const stack = [];
          for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
            const bg = parseRgba(getComputedStyle(p).backgroundColor);
            if (bg && bg.a > 0) stack.push(bg);
            if (p === root) break;
          }
          let bg = { r: 255, g: 255, b: 255, a: 1 };
          for (let i = stack.length - 1; i >= 0; i--) bg = blend(stack[i], bg);
          const ratio = ratioOf(fg, bg);
          const fs = parseFloat(cs.fontSize) || 16;
          const fw = parseFloat(cs.fontWeight) || 400;
          const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
          const required = large ? 3 : 4.5;
          if (ratio < required) {
            lowContrast.push({
              nodeId,
              ratio,
              required,
              fontSize: cs.fontSize,
              color: cs.color,
              text: el.textContent.trim().slice(0, 40),
            });
          }
        }
      }
    }

    const missingFonts = [];
    if (fontRefs.size) {
      const ctx = document.createElement("canvas").getContext("2d");
      const sample = "mmmmmmmmmmlliWWii123456";
      const baseW = ctx ? ["monospace", "sans-serif", "serif"].map((g) => { ctx.font = \`72px \${g}\`; return ctx.measureText(sample).width; }) : [];
      for (const [fam, nodeSet] of fontRefs) {
        const lower = fam.toLowerCase();
        const faceStatus = loadedFaces.get(lower);
        let ok = faceStatus === "loaded";
        if (!ok && faceStatus === undefined) {
          const escaped = fam.replace(/"/g, "");
          const fontCheck = document.fonts.check(\`16px "\${escaped}"\`);
          if (ctx && fontCheck) {
            const fallbacks = ["monospace", "sans-serif", "serif"];
            ok = fallbacks.some((g, idx) => {
              ctx.font = \`72px "\${escaped}", \${g}\`;
              return Math.abs(ctx.measureText(sample).width - baseW[idx]) > 0.1;
            });
          }
        }
        if (!ok) {
          missingFonts.push({ family: fam, status: faceStatus || "not-loaded", nodeIds: [...nodeSet].slice(0, 10) });
        }
      }
    }

    const summary = {
      brokenImages: brokenImages.length,
      overflows: overflows.length,
      missingFonts: missingFonts.length,
      tapTargets: tapTargets.length,
      lowContrast: lowContrast.length,
    };
    const ok = Object.values(summary).every((n) => n === 0);
    return {
      ok,
      width: Math.round(rootRect.width),
      height: Math.round(rootRect.height),
      summary,
      brokenImages: brokenImages.slice(0, 25),
      overflows: overflows.slice(0, 25),
      missingFonts: missingFonts.slice(0, 25),
      tapTargets: tapTargets.slice(0, 25),
      lowContrast: lowContrast.slice(0, 25),
    };
  })()`;
}
