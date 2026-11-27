// Project SVG icon / asset registry: strict sanitisation and <icon name="..."> expansion.
import { HttpError, ICON_NAME_RE, cleanClassList, cleanName, mergeAttrs, sanitizeSvgSpecNode } from "./model.js";
import { htmlToSpecs } from "./html-import.js";

export const MAX_ICONS = 200;

/**
 * Parse and strictly sanitise a raw `<svg>...</svg>` string into a reusable icon asset.
 */
export function parseSvgIcon(rawName, svgMarkup) {
  const name = String(rawName ?? "").trim();
  if (!ICON_NAME_RE.test(name)) {
    throw new HttpError(400, `Icon names use letters, digits, - or _ (got "${name}")`);
  }
  const markup = String(svgMarkup ?? "").trim();
  if (!markup) throw new HttpError(400, `Icon "${name}": SVG markup cannot be empty`);
  if (/<script\b|on[a-z]+\s*=|javascript:|url\s*\(|<\s*(?:use|a|image|foreignobject)\b/i.test(markup)) {
    throw new HttpError(400, `Icon "${name}": unsafe SVG construct is not allowed`);
  }
  const { specs, warnings } = htmlToSpecs(markup);
  if (warnings.length) {
    throw new HttpError(400, `Icon "${name}": ${warnings[0]}`);
  }
  if (specs.length !== 1 || String(specs[0].tag || "").toLowerCase() !== "svg") {
    throw new HttpError(400, `Icon "${name}": markup must have a single root <svg> element`);
  }
  const cleanRoot = sanitizeSvgSpecNode(specs[0], `Icon "${name}"`);
  if (!cleanRoot.children.length) {
    throw new HttpError(400, `Icon "${name}": <svg> must contain at least one shape`);
  }
  return {
    name,
    ...(cleanRoot.attrs?.viewBox ? { viewBox: cleanRoot.attrs.viewBox } : {}),
    attrs: cleanRoot.attrs || {},
    ...(cleanRoot.styles && Object.keys(cleanRoot.styles).length ? { styles: cleanRoot.styles } : {}),
    children: cleanRoot.children,
  };
}

function toLayerSpec(node, defaultName) {
  const tag = node.tag || "svg";
  return {
    tag,
    name: cleanName(defaultName, tag === "svg" ? "SVG" : tag),
    text: "",
    styles: structuredClone(node.styles || {}),
    attrs: structuredClone(node.attrs || {}),
    children: (node.children || []).map((c) => toLayerSpec(c, c.tag[0].toUpperCase() + c.tag.slice(1))),
  };
}

/**
 * Expand an `<icon name="..." />` instance spec using its registered `iconAsset`.
 */
export function expandIconAsset(iconAsset, instanceSpec = {}) {
  const expanded = toLayerSpec(iconAsset, instanceSpec.name || iconAsset.name);
  if (instanceSpec.styles && Object.keys(instanceSpec.styles).length) {
    Object.assign(expanded.styles, instanceSpec.styles);
  }
  if (instanceSpec.classes?.length) {
    expanded.classes = cleanClassList(instanceSpec.classes);
  }
  if (instanceSpec.attrs && Object.keys(instanceSpec.attrs).length) {
    const overrideAttrs = {};
    for (const [k, v] of Object.entries(instanceSpec.attrs)) {
      if (k === "name") continue;
      overrideAttrs[k] = v;
    }
    if (Object.keys(overrideAttrs).length) {
      expanded.attrs = mergeAttrs(expanded.attrs, overrideAttrs, "svg");
    }
  }
  return expanded;
}

/**
 * Recursively expand `{ tag: "icon", iconName }` specs across a parsed `htmlToSpecs` tree.
 * Unknown icons are skipped with a warning (consistent with write_html leniency).
 */
export function expandIconSpecs(specs, iconsMap, warnings = []) {
  const map = iconsMap || {};
  const walkList = (list) => {
    const out = [];
    for (const sp of list || []) {
      if (sp.tag === "icon") {
        const iconName = String(sp.iconName || "").trim();
        const asset = iconName && Object.hasOwn(map, iconName) ? map[iconName] : null;
        if (!asset) {
          warnings.push(`<icon${iconName ? ` name="${iconName}"` : ""}> isn't registered; register it with register_icons first. Skipped`);
          continue;
        }
        out.push(expandIconAsset(asset, sp));
        continue;
      }
      out.push({ ...sp, children: walkList(sp.children) });
    }
    return out;
  };
  return walkList(specs);
}
