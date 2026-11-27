<script>
  // Export menu (#export-menu): copy the selection or page as HTML/CSS or JSX, or download the project as a ZIP.
  // The legacy script opens and closes it; this reads the scope summary when it opens and runs the actions.
  import { flushSync } from "svelte";
  import { weft } from "../lib/bridge.svelte.js";

  let m = $state.raw(null);
  let zipFmt = $state("html");
  weft.events.addEventListener("export-menu", () => { m = weft.exportMenu(); flushSync(); });

  const NUM = /^-?\d+(?:\.\d+)?$/;
  // The selection's first styles as a JSX-ish preview, wrapped at ~44 characters. Each part: [kind, text].
  function preview(node) {
    const entries = Object.entries(node.styles || {}).slice(0, 6);
    const parts = entries.map(([k, v], i) => {
      const s = String(v ?? "").trim();
      const pxv = /^(-?\d+(?:\.\d+)?)px$/.exec(s);
      const val = typeof v === "number" ? ["n", String(v)] : pxv ? ["n", pxv[1]] : NUM.test(s) ? ["n", s] : ["s", JSON.stringify(String(v ?? ""))];
      const comma = i < entries.length - 1 ? "," : "";
      return { k, val, comma, len: `${k}: ${val[1]}${comma}`.length };
    });
    const lines = [];
    let line = [], len = 0;
    for (const p of parts) {
      if (line.length && len + 1 + p.len > 44) { lines.push(line); line = [p]; len = p.len; }
      else { line.push(p); len += (line.length > 1 ? 1 : 0) + p.len; }
    }
    if (line.length) lines.push(line);
    return lines;
  }
  const lines = $derived(m?.sel ? preview(m.sel.node) : []);

  function run(act) {
    weft.closeExportMenu();
    weft.exportAction(act, zipFmt);
  }
</script>

{#if m}
  {#if m.sel}
    <section class="exp-scope">
      <div class="exp-scope-h"><strong>Selection</strong><span class="sel-nm">{m.sel.name}</span></div>
      <pre class="exp-code"><span class="t">&lt;{m.sel.node.tag}</span> style={"{{"}{#if !lines.length} <span class="cmdk-dim">/* no styles */</span> {"}}"}<span class="t">&gt;</span>{:else}{"\n"}{#each lines as line, li}{"  "}{#each line as p, pi}{pi ? " " : ""}{p.k}: <span class={p.val[0]}>{p.val[1]}</span>{p.comma}{/each}{#if li < lines.length - 1}{"\n"}{:else} {"}}"}<span class="t">&gt;</span>{/if}{/each}{/if}</pre>
      <div class="btnrow">
        <button type="button" class="btn primary" data-exp="copy-sel-html" onclick={() => run("copy-sel-html")}><span>Copy HTML + CSS</span><span class="exp-kbd">Ctrl C</span></button>
        <button type="button" class="btn" data-exp="copy-sel-jsx" onclick={() => run("copy-sel-jsx")}>Copy JSX</button>
      </div>
    </section>
  {/if}
  <section class="exp-scope">
    <div class="exp-scope-h"><strong>Page</strong><span class="exp-meta">{m.page}</span></div>
    <div class="btnrow">
      <button type="button" class="btn" data-exp="copy-page-html" onclick={() => run("copy-page-html")}>Copy HTML + CSS</button>
      <button type="button" class="btn" data-exp="copy-page-jsx" onclick={() => run("copy-page-jsx")}>Copy JSX</button>
    </div>
  </section>
  <section class="exp-scope subtle">
    <div class="exp-scope-h"><strong>Whole project</strong><span class="exp-meta">{m.project}</span></div>
    <div class="seg">
      {#each ["html", "jsx", "both"] as f (f)}<button type="button" data-exp-fmt={f} class={zipFmt === f ? "on" : ""} onclick={() => (zipFmt = f)}>{f === "both" ? "Both" : f.toUpperCase()}</button>{/each}
    </div>
    <button type="button" class="btn" data-exp="download-zip" onclick={() => run("download-zip")}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>Download {m.slug}.zip</button>
  </section>
{/if}
