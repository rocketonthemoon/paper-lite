<script>
  // Inspector when nothing is selected: root CSS, canvas surface, fonts, MCP, export and shortcuts. Fields and buttons
  // keep their ids / data-* attributes and are handled by the legacy listeners on #inspector / #right.
  import { weft } from "../../lib/bridge.svelte.js";
  import ColorFld from "./ColorFld.svelte";

  let { m } = $props();
  const h = weft.h;
  const root = $derived(m.page);
  const bg = $derived((root.styles.backgroundColor || "#eef2f6").toLowerCase());
  const vars = $derived(Object.entries(m.rootCss.vars));
  const nClasses = $derived(m.definedClasses.length);
  const nRules = $derived(m.rootCss.rules.length);
  const isColor = (v) => /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(h.resolveVars(v).trim());
  const rootCssPlaceholder = ":root {\n  --color-primary: #0000ff;\n  --space-4: 16px;\n}\n\n.card {\n  padding: var(--space-4);\n}";
  const fontMeta = (f) => (f.source === "upload"
    ? `${f.weightRange ? f.weightRange.join("–") : f.weight}${f.style === "italic" ? " italic" : ""} · ${f.format}`
    : f.builtin ? "built-in" : "Google");
  const fontStyle = (f) => `font-family:${h.fontStack(f.family)}${f.source === "upload" ? `;font-weight:${f.weight};font-style:${f.style}` : ""}`;
  const shortcuts = [["Command palette", "Ctrl K"], ["Select / Hand", "V / H"], ["Frame / Rect / Text", "F / R / T"], ["Pan", "Space + drag"],
    ["Fit / Selection / 100%", "Shift 1 / 2 / 0"], ["Parent / child", "Esc / Enter"], ["Duplicate / Delete", "Ctrl D / Del"], ["Preview screen", "P"],
    ["Undo / Redo", "Ctrl Z / Ctrl Shift Z"], ["Add flex / Snap", "Shift A / Shift G"], ["Copy HTML / Hide UI", "Ctrl C / Ctrl \\"]];
</script>

<div class="sec" id="root-css-sec">
  <div class="sec-h">Root CSS <span class="muted">{vars.length} variable{vars.length === 1 ? "" : "s"} · {nClasses} class{nClasses === 1 ? "" : "es"} · {nRules} rule{nRules === 1 ? "" : "s"}</span></div>
  {#if vars.length}
    <div class="var-list">{#each vars.slice(0, 16) as [k, v] (k)}<div class="var-row">{#if isColor(v)}<span class="sw" style="background:{h.resolveVars(v)}"></span>{/if}<span>{k}</span><span class="vv" title={v}>{v}</span></div>{/each}{#if vars.length > 16}<div class="hint">+{vars.length - 16} more in the editor below</div>{/if}</div>
  {/if}
  <div class="hint">Shared by every screen: layers use <code>var(--name)</code> and these classes, so an edit here restyles them everywhere. Nesting (<code>&amp;:hover</code>, <code>&amp; .title</code>), states and <code>@media</code> work; on the canvas, width queries follow each artboard's width · <kbd>Ctrl+Enter</kbd> applies</div>
  <textarea class="code root-css" id="root-css" spellcheck="false" wrap="off" aria-label="Root CSS" placeholder={rootCssPlaceholder} value={window.WeftRootCss.toText(m.rootCss)}></textarea>
  <button class="btn subtle" data-action="apply-root-css" style="width:100%">Apply root CSS</button>
</div>
<div class="sec">
  <div class="sec-h">Canvas surface</div>
  <ColorFld key="backgroundColor" value={root.styles.backgroundColor} placeholder="#eef2f6" attr="data-page" fallback="#eef2f6" />
  <div class="chips">
    <button type="button" class="chip" class:on={bg === "#eef2f6" || !root.styles.backgroundColor} style="flex:1" data-action="page-bg" data-bg="#eef2f6">Light</button>
    <button type="button" class="chip" class:on={bg === "#ffffff"} style="flex:1" data-action="page-bg" data-bg="#ffffff">White</button>
    <button type="button" class="chip" class:on={bg === "#282828"} style="flex:1;background:#282828;color:#fff;border-color:{bg === '#282828' ? '#4c7dff' : '#282828'}" data-action="page-bg" data-bg="#282828">Dark</button>
  </div>
</div>
<div class="sec">
  <div class="sec-h">Fonts <span class="muted">{m.fontLib.length} in library</span></div>
  <div class="font-list">{#each m.fontLib as f (f.id || f.family)}<div class="font-row"><span class="fam" style={fontStyle(f)}>{f.family}</span>
    <span class="meta">{fontMeta(f)}</span>
    {#if !f.builtin}<button class="icon-btn" data-action="remove-font" data-id={f.id} title="Remove {f.family}" aria-label="Remove {f.family}"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg></button>{/if}</div>{/each}</div>
  <label class="fld"><span>Google</span><input id="google-family" placeholder="Family, e.g. Plus Jakarta"></label>
  <div class="btnrow">
    <button class="btn" data-action="add-google"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>Google Font</button>
    <label class="btn subtle"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 10.5v-8M4.5 5.5L8 2l3.5 3.5M3 13.5h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>Upload…<input type="file" id="font-file" accept=".woff2,.woff,.ttf,.otf" multiple hidden></label>
  </div>
</div>
<div class="sec">
  <div class="sec-h">MCP server <span class="mcp-live-tag">Connected</span></div>
  <div class="mono">{m.mcpUrl}</div>
  <div class="mono" id="mcp-cmd" hidden>claude mcp add --transport http weft {m.mcpUrl}</div>
  <button class="btn" data-action="copy-mcp" style="width:100%"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M11 5V3.5A1 1 0 0010 2.5H3.5a1 1 0 00-1 1V10a1 1 0 001 1H5" /></svg>Copy Claude Code command</button>
</div>
<div class="sec">
  <div class="sec-h">Export project <span class="muted">.zip</span></div>
  <div class="btnrow">
    <button class="btn primary" data-action="export-zip" data-format="html">HTML</button>
    <button class="btn" data-action="export-zip" data-format="jsx">JSX</button>
    <button class="btn" data-action="export-zip" data-format="both">Both</button>
  </div>
</div>
<div class="sec">
  <div class="sec-h">Export page</div>
  <div class="btnrow"><button class="btn" data-action="copy" data-format="html">Copy HTML + CSS</button><button class="btn" data-action="copy" data-format="jsx">Copy JSX</button></div>
</div>
<div class="sec">
  <div class="sec-h">Shortcuts</div>
  {#each shortcuts as [a, b] (a)}<div class="kv"><span>{a}</span><b>{b}</b></div>{/each}
</div>
