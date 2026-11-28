<script>
  // Inspector when nothing is selected, kept short like Figma's page panel: the page background and the project's
  // styles up front; the CSS editor, fonts, agent connection, export and shortcuts in sections that open on demand.
  // Fields and buttons keep their ids / data-* attributes and are passed by Inspector.svelte to the editor engine.
  import { weft } from "../../lib/bridge.svelte.js";
  import ColorFld from "./ColorFld.svelte";
  import Section from "./Section.svelte";

  let { m } = $props();
  const h = weft.h;
  const root = $derived(m.page);
  const bg = $derived((root.styles.backgroundColor || "#eef2f6").toLowerCase());
  const vars = $derived(Object.entries(m.rootCss.vars));
  const nClasses = $derived(m.definedClasses.length);
  const nRules = $derived(m.rootCss.rules.length);
  const counts = $derived(`${vars.length} variable${vars.length === 1 ? "" : "s"} · ${nClasses} class${nClasses === 1 ? "" : "es"} · ${nRules} rule${nRules === 1 ? "" : "s"}`);
  const surfaces = [["#eef2f6", "Light"], ["#ffffff", "White"], ["#282828", "Dark"]];
  let cssOpen = $state(false);
  const stylesInfo = "Shared by every screen: layers use var(--name) and these classes, so an edit here restyles them everywhere. Nesting (&:hover, & .title), states and @media work; on the canvas, width queries follow each artboard's width. Ctrl+Enter applies.";
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

<Section key="page" title="Page" collapsible={false}>
  <div class="surface-row">
    <div class="surface-fld"><ColorFld key="backgroundColor" value={root.styles.backgroundColor} placeholder="#eef2f6" attr="data-page" fallback="#eef2f6" /></div>
    {#each surfaces as [c, label] (c)}
      <button type="button" class="surface-sw" class:on={bg === c || (c === "#eef2f6" && !root.styles.backgroundColor)} style="background:{c}" data-action="page-bg" data-bg={c} title="{label} canvas" aria-label="{label} canvas"></button>
    {/each}
  </div>
</Section>

<Section key="page-styles" id="root-css-sec" title="Styles" meta={counts} info={stylesInfo}>
  {#if vars.length}
    <div class="var-list">{#each vars.slice(0, 16) as [k, v] (k)}<div class="var-row">{#if isColor(v)}<span class="sw" style="background:{h.resolveVars(v)}"></span>{/if}<span>{k}</span><span class="vv" title={v}>{v}</span></div>{/each}{#if vars.length > 16}<div class="hint">+{vars.length - 16} more in the CSS</div>{/if}</div>
  {/if}
  {#if nClasses}
    <div class="class-list">{#each m.definedClasses as c (c)}<span class="class-chip plain">.{c}</span>{/each}</div>
  {/if}
  {#if !vars.length && !nClasses}<div class="hint">No variables or classes yet.</div>{/if}
  <button type="button" class="link-toggle" aria-expanded={cssOpen} onclick={() => (cssOpen = !cssOpen)}>{cssOpen ? "Hide CSS" : "Edit CSS"}<svg width="10" height="10" viewBox="0 0 12 12" fill="none" style="transform:rotate({cssOpen ? 180 : 0}deg)"><path d="M3.5 4.75L6 7.25l2.5-2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
  <div class="css-edit" hidden={!cssOpen}>
    <textarea class="code root-css" id="root-css" spellcheck="false" wrap="off" aria-label="Root CSS" placeholder={rootCssPlaceholder} value={window.WeftRootCss.toText(m.rootCss)}></textarea>
    <button class="btn subtle" data-action="apply-root-css" style="width:100%">Apply root CSS <kbd>Ctrl+Enter</kbd></button>
  </div>
</Section>

<Section key="page-fonts" title="Fonts" meta="{m.fontLib.length} in library" open={false}>
  <div class="font-list">{#each m.fontLib as f (f.id || f.family)}<div class="font-row"><span class="fam" style={fontStyle(f)}>{f.family}</span>
    <span class="meta">{fontMeta(f)}</span>
    {#if !f.builtin}<button class="icon-btn" data-action="remove-font" data-id={f.id} title="Remove {f.family}" aria-label="Remove {f.family}"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg></button>{/if}</div>{/each}</div>
  <label class="fld"><span>Google</span><input id="google-family" placeholder="Family, e.g. Plus Jakarta"></label>
  <div class="btnrow">
    <button class="btn" data-action="add-google"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>Google Font</button>
    <label class="btn subtle"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 10.5v-8M4.5 5.5L8 2l3.5 3.5M3 13.5h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>Upload…<input type="file" id="font-file" accept=".woff2,.woff,.ttf,.otf" multiple hidden></label>
  </div>
</Section>

<Section key="page-agent" title="Connect an agent" open={false}>
  <div class="mono">{m.mcpUrl}</div>
  <div class="mono" id="mcp-cmd" hidden>claude mcp add --transport http weft {m.mcpUrl}</div>
  <button class="btn" data-action="copy-mcp" style="width:100%"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M11 5V3.5A1 1 0 0010 2.5H3.5a1 1 0 00-1 1V10a1 1 0 001 1H5" /></svg>Copy Claude Code command</button>
</Section>

<Section key="page-export" title="Export" open={false}>
  <div class="sub-h">Project · .zip</div>
  <div class="btnrow">
    <button class="btn primary" data-action="export-zip" data-format="html">HTML</button>
    <button class="btn" data-action="export-zip" data-format="jsx">JSX</button>
    <button class="btn" data-action="export-zip" data-format="both">Both</button>
  </div>
  <div class="sub-h">This page</div>
  <div class="btnrow"><button class="btn" data-action="copy" data-format="html">Copy HTML + CSS</button><button class="btn" data-action="copy" data-format="jsx">Copy JSX</button></div>
</Section>

<Section key="page-shortcuts" title="Keyboard shortcuts" open={false}>
  {#each shortcuts as [a, b] (a)}<div class="kv"><span>{a}</span><b>{b}</b></div>{/each}
</Section>
