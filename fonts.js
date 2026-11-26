// Font library shared by every project: uploaded font files (woff2/woff/ttf/otf) and Google Fonts families.
// Served as one stylesheet (/fonts.css) used by the editor canvas, the screenshot renderer and code export.
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { HttpError, newId } from "./model.js";

const MAX_BYTES = 8 * 1024 * 1024;
const FORMATS = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };
const BUILTIN = [
  { id: "builtin-geist", family: "Geist", source: "google", axes: "wght@300..800", builtin: true },
  { id: "builtin-geist-mono", family: "Geist Mono", source: "google", axes: "wght@400..700", builtin: true },
];
const WEIGHT_WORDS = [
  ["extralight", 200], ["ultralight", 200], ["semibold", 600], ["demibold", 600], ["extrabold", 800], ["ultrabold", 800],
  ["hairline", 100], ["thin", 100], ["light", 300], ["regular", 400], ["normal", 400], ["book", 400], ["medium", 500],
  ["bold", 700], ["heavy", 900], ["black", 900],
];
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

function sniffFormat(buf) {
  if (buf.length < 4) return null;
  const sig = buf.subarray(0, 4).toString("latin1");
  if (sig === "wOF2") return "woff2";
  if (sig === "wOFF") return "woff";
  if (sig === "OTTO") return "otf";
  if (sig === "true" || buf.readUInt32BE(0) === 0x00010000) return "ttf";
  return null;
}

// ---------------------------------------------------------------------------
// Read family / weight / style straight from the font file (name, OS/2 and fvar tables).
// Supports TTF/OTF, WOFF (zlib) and WOFF2 (brotli). Returns null when the file can't be parsed.
// ---------------------------------------------------------------------------
const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG",
  "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar",
  "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];
const WANTED = new Set(["name", "OS/2", "fvar"]);

function sfntTables(buf) {
  const tables = {};
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    const tag = buf.toString("latin1", rec, rec + 4);
    if (WANTED.has(tag)) tables[tag] = buf.subarray(buf.readUInt32BE(rec + 8), buf.readUInt32BE(rec + 8) + buf.readUInt32BE(rec + 12));
  }
  return tables;
}

function woffTables(buf) {
  const tables = {};
  const n = buf.readUInt16BE(12);
  for (let i = 0; i < n; i++) {
    const rec = 44 + i * 20;
    const tag = buf.toString("latin1", rec, rec + 4);
    if (!WANTED.has(tag)) continue;
    const off = buf.readUInt32BE(rec + 4), comp = buf.readUInt32BE(rec + 8), orig = buf.readUInt32BE(rec + 12);
    const data = buf.subarray(off, off + comp);
    tables[tag] = comp < orig ? zlib.inflateSync(data, { maxOutputLength: 16 * 1024 * 1024 }) : data;
  }
  return tables;
}

function woff2Tables(buf) {
  if (buf.readUInt32BE(4) === 0x74746366) throw new Error("WOFF2 collections are not supported");
  const n = buf.readUInt16BE(12);
  const compressed = buf.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      if (p >= buf.length) throw new Error("EOF");
      const b = buf[p++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error("bad UIntBase128");
  };
  const dir = [];
  for (let i = 0; i < n; i++) {
    if (p >= buf.length) throw new Error("EOF");
    const flags = buf[p++];
    let tag;
    if ((flags & 0x3f) === 0x3f) { tag = buf.toString("latin1", p, p + 4); p += 4; } else tag = WOFF2_TAGS[flags & 0x3f];
    const version = (flags >> 6) & 3;
    const orig = base128();
    const transformed = (tag === "glyf" || tag === "loca") ? version === 0 : version !== 0;
    dir.push({ tag, length: transformed ? base128() : orig });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(p, p + compressed), { maxOutputLength: 32 * 1024 * 1024 });
  const tables = {};
  let off = 0;
  for (const t of dir) {
    if (WANTED.has(t.tag)) tables[t.tag] = data.subarray(off, off + t.length);
    off += t.length;
  }
  return tables;
}

function nameString(name, ids) {
  const count = name.readUInt16BE(2), strings = name.readUInt16BE(4);
  for (const id of ids) {
    let winEn = null, winAny = null, macEn = null, macAny = null;
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      if (r + 12 > name.length) break;
      if (name.readUInt16BE(r + 6) !== id) continue;
      const platform = name.readUInt16BE(r), lang = name.readUInt16BE(r + 4), len = name.readUInt16BE(r + 8), off = strings + name.readUInt16BE(r + 10);
      const raw = name.subarray(off, off + len);
      if (platform === 3 || platform === 0) {
        const le = Buffer.alloc(raw.length);
        for (let j = 0; j + 1 < raw.length; j += 2) { le[j] = raw[j + 1]; le[j + 1] = raw[j]; }
        const s = le.toString("utf16le").trim();
        if (!s) continue;
        if (platform === 3 && lang === 0x0409) { winEn = s; break; }
        if (!winAny) winAny = s;
      } else if (platform === 1) {
        const s = raw.toString("latin1").trim();
        if (!s) continue;
        if (lang === 0 && !macEn) macEn = s;
        else if (!macAny) macAny = s;
      }
    }
    const found = winEn || winAny || macEn || macAny;
    if (found) return found;
  }
  return null;
}

export function readFontMeta(buf, format) {
  try {
    const t = format === "woff2" ? woff2Tables(buf) : format === "woff" ? woffTables(buf) : sfntTables(buf);
    if (!t.name) return null;
    const family = nameString(t.name, [16, 1]);
    const sub = nameString(t.name, [17, 2]) || "";
    let weight = t["OS/2"] && t["OS/2"].length >= 6 ? t["OS/2"].readUInt16BE(4) : null;
    const italic = (t["OS/2"] && t["OS/2"].length >= 64 && (t["OS/2"].readUInt16BE(62) & 0x0201) !== 0) || /italic|oblique/i.test(sub);
    let weightRange = null;
    if (t.fvar && t.fvar.length >= 16) {
      const axesOff = t.fvar.readUInt16BE(4), axes = t.fvar.readUInt16BE(8), size = t.fvar.readUInt16BE(10);
      for (let i = 0; i < axes; i++) {
        const a = axesOff + i * size;
        if (a + 16 > t.fvar.length) break;
        if (t.fvar.toString("latin1", a, a + 4) === "wght") {
          const min = Math.round(t.fvar.readInt32BE(a + 4) / 65536), max = Math.round(t.fvar.readInt32BE(a + 12) / 65536);
          if (min > 0 && max >= min) weightRange = [min, max];
        }
      }
    }
    if (weight && (weight < 1 || weight > 1000)) weight = null;
    const cleanFam = family ? family.replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64).trim() : "";
    return { family: cleanFam && FAMILY_RE.test(cleanFam) ? cleanFam : null, weight, style: italic ? "italic" : "normal", weightRange };
  } catch {
    return null;
  }
}

/** "Inter-SemiBoldItalic.woff2" → { family: "Inter", weight: 600, style: "italic" } */
export function parseFontFileName(fileName) {
  const base = path.basename(String(fileName || "font")).replace(/\.[^.]+$/, "").replace(/\[[^\]]*\]/g, "");
  const parts = base.split(/[-_ ]+/).filter(Boolean);
  let weight = 400, style = "normal";
  const familyParts = [];
  for (const part of parts) {
    let p = part.toLowerCase();
    let matched = false;
    if (/italic|oblique/.test(p)) { style = "italic"; p = p.replace(/italic|oblique/, ""); matched = true; }
    for (const [word, w] of WEIGHT_WORDS) if (p === word) { weight = w; matched = true; p = ""; break; }
    if (/^\d{3}$/.test(p)) { weight = Number(p); matched = true; p = ""; }
    if (!matched || p) familyParts.push(part.replace(/italic|oblique/i, ""));
  }
  // "VariableFont" / "VF" suffixes are not part of the family name
  const family = familyParts.filter((p) => !/^(variable(font)?|vf|wght|webfont)$/i.test(p)).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return { family: family || "Custom Font", weight, style };
}

export class FontLibrary {
  constructor(dir) {
    this.dir = dir;
    this.filesDir = path.join(dir, "files");
    this.indexFile = path.join(dir, "fonts.json");
    this.fonts = [];
  }

  async load() {
    await fs.mkdir(this.filesDir, { recursive: true });
    try {
      this.fonts = JSON.parse(await fs.readFile(this.indexFile, "utf8"));
    } catch {
      this.fonts = [];
    }
  }

  // Saves run one at a time (overlapping writes used to race on the same temp file); each writes the latest list.
  save() {
    const run = async () => {
      const tmp = `${this.indexFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.fonts, null, 2));
      await fs.rename(tmp, this.indexFile);
    };
    this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(run);
    return this.saving;
  }

  list() {
    return [...BUILTIN, ...this.fonts];
  }

  families() {
    return [...new Set(this.list().map((f) => f.family))];
  }

  /** CSS font-family value with a sensible fallback stack for a library family. */
  stack(family) {
    return `'${family}', ${/mono|code/i.test(family) ? "ui-monospace, monospace" : "system-ui, sans-serif"}`;
  }

  async addUpload({ fileName, data, family, weight, style }) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ""), "base64");
    if (!buf.length) throw new HttpError(400, "Font file is empty");
    if (buf.length > MAX_BYTES) throw new HttpError(413, "Font file is larger than 8 MB");
    const format = sniffFormat(buf);
    if (!format) throw new HttpError(400, "Not a font file (expected woff2, woff, ttf or otf)");
    // Prefer what the font file says about itself; fall back to the file name.
    const meta = readFontMeta(buf, format) || {};
    const guess = parseFontFileName(fileName);
    const fam = String(family || meta.family || guess.family).trim().replace(/\s+/g, " ");
    if (!FAMILY_RE.test(fam)) throw new HttpError(400, `Invalid family name "${fam}"`);
    const w = Number(weight || meta.weight || guess.weight);
    if (!Number.isInteger(w) || w < 1 || w > 1000) throw new HttpError(400, "Weight must be 1–1000");
    const st = (style || meta.style || guess.style) === "italic" ? "italic" : "normal";
    const range = !weight && meta.weightRange && meta.weightRange[0] !== meta.weightRange[1] ? meta.weightRange : null;
    const existing = this.fonts.find((f) => f.source === "upload" && f.family.toLowerCase() === fam.toLowerCase() && f.weight === w && f.style === st);
    const id = existing?.id || newId();
    const file = `${id}.${format}`;
    await fs.writeFile(path.join(this.filesDir, file), buf);
    if (existing && existing.file !== file) await fs.rm(path.join(this.filesDir, existing.file), { force: true });
    const entry = { id, family: fam, weight: w, style: st, ...(range ? { weightRange: range } : {}), source: "upload", file, format,
      originalName: path.basename(String(fileName || file)), bytes: buf.length };
    this.fonts = existing ? this.fonts.map((f) => (f.id === id ? entry : f)) : [...this.fonts, entry];
    await this.save();
    return entry;
  }

  async addFromPath(filePath, opts = {}) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!FORMATS[ext]) throw new HttpError(400, "Path must point to a .woff2, .woff, .ttf or .otf file");
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new HttpError(404, `Font file not found: ${filePath}`);
    if (stat.size > MAX_BYTES) throw new HttpError(413, "Font file is larger than 8 MB");
    return this.addUpload({ ...opts, fileName: path.basename(filePath), data: await fs.readFile(filePath) });
  }

  async addGoogle({ family, axes }) {
    const fam = String(family || "").trim().replace(/\s+/g, " ");
    if (!/^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/.test(fam)) throw new HttpError(400, `Invalid Google Fonts family "${fam}"`);
    const ax = axes ? String(axes).trim() : "";
    if (ax && !/^(ital,)?wght@[\d.,;]+$/.test(ax)) throw new HttpError(400, 'axes must look like "wght@400;700" or "wght@100..900"');
    if (this.list().some((f) => f.source === "google" && f.family.toLowerCase() === fam.toLowerCase())) {
      throw new HttpError(409, `${fam} is already in the library`);
    }
    const entry = { id: newId(), family: fam, source: "google", axes: ax || undefined };
    this.fonts.push(entry);
    await this.save();
    return entry;
  }

  async remove(id) {
    const f = this.fonts.find((x) => x.id === id);
    if (!f) throw new HttpError(BUILTIN.some((b) => b.id === id) ? 400 : 404, BUILTIN.some((b) => b.id === id) ? "Built-in fonts cannot be removed" : "Font not found");
    this.fonts = this.fonts.filter((x) => x.id !== id);
    if (f.file) await fs.rm(path.join(this.filesDir, f.file), { force: true });
    await this.save();
    return f;
  }

  fileFor(name) {
    const f = this.fonts.find((x) => x.file === name);
    return f ? { path: path.join(this.filesDir, f.file), format: f.format } : null;
  }

  uploadedFor(families) {
    const want = families ? new Set([...families].map((f) => f.toLowerCase())) : null;
    return this.fonts.filter((f) => f.source === "upload" && (!want || want.has(f.family.toLowerCase())))
      .map((f) => ({ file: f.file, path: path.join(this.filesDir, f.file) }));
  }

  /** Stylesheet for the given families (all when omitted). baseUrl makes file URLs absolute; filesBase overrides the font files directory. */
  css({ families, baseUrl = "", filesBase } = {}) {
    const want = families ? new Set([...families].map((f) => f.toLowerCase())) : null;
    const fonts = this.list().filter((f) => !want || want.has(f.family.toLowerCase()));
    const filesDir = filesBase ?? `${baseUrl}/fonts/files`;
    const imports = fonts.filter((f) => f.source === "google").map((f) => {
      const q = encodeURIComponent(f.family).replace(/%20/g, "+") + (f.axes ? `:${f.axes}` : "");
      return `@import url("https://fonts.googleapis.com/css2?family=${q}&display=swap");`;
    });
    const faces = fonts.filter((f) => f.source === "upload").map((f) =>
      `@font-face {\n  font-family: '${f.family}';\n  src: url("${filesDir}/${f.file}") format("${FORMATS[f.format] || f.format}");\n  font-weight: ${f.weightRange ? f.weightRange.join(" ") : f.weight};\n  font-style: ${f.style};\n  font-display: swap;\n}`);
    return [...imports, ...faces].join("\n");
  }
}

/** Family names referenced by font-family values, e.g. "'Inter', system-ui" → ["Inter", "system-ui"]. */
export function familiesIn(fontFamily) {
  return String(fontFamily || "").split(",").map((f) => f.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}
