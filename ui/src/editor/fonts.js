// Fonts: CSS font stacks for family names, the font suggestions list, and font file uploads.
import { ed } from "./state.js";
import { GENERIC_FONTS, api, toast } from "./core.js";

export function fontStack(value) {
  const t = String(value || "").trim();
  if (!t || t.includes(",")) return t;
  const name = t.replace(/^['"]|['"]$/g, "");
  if (GENERIC_FONTS.includes(name.toLowerCase())) return name.toLowerCase();
  const lib = ed.fontLib.find((f) => f.family.toLowerCase() === name.toLowerCase());
  const fam = lib ? lib.family : name;
  return `'${fam}', ${/mono|code/i.test(fam) ? "ui-monospace, monospace" : "system-ui, sans-serif"}`;
}

// The <datalist> is ui/src/components/FontList.svelte.
export function renderFontList() {
  window.weft.events.dispatchEvent(new Event("fonts"));
}

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

export async function uploadFonts(files) {
  let ok = 0;
  for (const file of files) {
    const res = await api("POST", "/api/fonts", { fileName: file.name, data: await readAsBase64(file) });
    if (res) ok += 1;
  }
  if (ok) toast(`Added ${ok} font file${ok > 1 ? "s" : ""}`);
}
