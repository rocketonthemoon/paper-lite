<script>
  // Inspector for the selected layer or artboard, ordered like Figma's properties panel: layout, auto layout, fill,
  // appearance, text; shared classes; then the rarely needed details (name, tag, raw CSS) in a "Layer" section that
  // starts collapsed. Fields and buttons carry the same data-* attributes as before and are passed by Inspector.svelte
  // to the editor engine (input, change, keydown, click).
  import { weft } from "../../lib/bridge.svelte.js";
  import Fld from "./Fld.svelte";
  import ColorFld from "./ColorFld.svelte";
  import Section from "./Section.svelte";

  let { m } = $props();
  const h = weft.h;
  const n = $derived(m.node);
  const st = $derived(n.styles);
  const ab = $derived(m.artboard);
  const abs = $derived(st.position === "absolute");
  const flex = $derived(st.display === "flex" || st.display === "inline-flex");
  const texty = $derived(!h.VOID_TAGS.has(n.tag) && (n.text !== "" || h.TEXT_TAGS.has(n.tag)));
  const presets = [["390×844", 390, 844], ["768×1024", 768, 1024], ["1440×900", 1440, 900], ["Auto H", null, "fit-content"]];
  const displays = [["", "default"], ["block", "block"], ["flex", "flex"], ["inline-flex", "inline-flex"], ["grid", "grid"], ["inline-block", "inline-block"], ["none", "none"]];
  const weights = ["", "100", "200", "300", "400", "500", "600", "700", "800", "900"];
  const opacity = $derived(st.opacity == null ? "100" : String(Math.round(h.num(st.opacity, 1) * 100)));
  const mine = $derived(n.classes || []);
  const avail = $derived(m.definedClasses.filter((c) => !mine.includes(c)));
  const classable = $derived(Object.keys(h.classableStyles(n)).length > 0);
  const summary = (c) => {
    const base = Object.entries(h.baseStylesOf(c)).map(([k, v]) => `${h.kebabCss(k)}: ${v}`).join("; ");
    const more = h.rulesUsing(c).length;
    return `${base || "(no base styles)"}${more ? ` + ${more} state / media / nested rule${more === 1 ? "" : "s"}` : ""}`;
  };
  const presetOn = (pw, ph) => (!pw || h.px(st.width) == pw) && h.px(st.height) == ph; // eslint-disable-line eqeqeq
  const justify = (v) => (v === "start" ? "flex-start" : v === "end" ? "flex-end" : v || "flex-start");
  const alignCells = $derived.by(() => {
    const col = st.flexDirection === "column";
    const vals = ["flex-start", "center", "flex-end"];
    const j = justify(st.justifyContent), a = justify(st.alignItems);
    const cells = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const jj = col ? vals[r] : vals[c], aa = col ? vals[c] : vals[r];
      cells.push({ j: jj, a: aa, on: jj === j && aa === a });
    }
    return cells;
  });
  const textAligns = [
    ["left", "M2.5 4h11M2.5 8h7M2.5 12h9.5"],
    ["center", "M2.5 4h11M4.5 8h7M3.5 12h9"],
    ["right", "M2.5 4h11M6.5 8h7M4 12h9.5"],
  ];
</script>

<Section key="node-layout" title={ab ? "Frame" : "Layout"} collapsible={false}>
  <div class="grid2">
    <Fld label="X" key="left" value={st.left} disabled={!abs} placeholder={abs ? undefined : "—"} title={abs ? undefined : "Set Position to absolute to move freely"} />
    <Fld label="Y" key="top" value={st.top} disabled={!abs} placeholder={abs ? undefined : "—"} title={abs ? undefined : "Set Position to absolute to move freely"} />
  </div>
  <div class="grid2"><Fld label="W" key="width" value={st.width} placeholder="auto" /><Fld label="H" key="height" value={st.height} placeholder="auto" /></div>
  {#if ab}
    <div class="chips compact">{#each presets as [lbl, pw, ph] (lbl)}<button type="button" class="chip" class:on={presetOn(pw, ph)} data-action="preset-size" data-w={pw ?? ""} data-h={ph}>{lbl}</button>{/each}</div>
    <div class="sub-h" title="Render this screen at another width to check its @media rules">Preview width</div>
    <div class="chips compact" id="vp-preview-chips">{#each [["390", 390], ["834", 834], ["1440", 1440], ["Actual", null]] as [lbl, vw] (lbl)}<button type="button" class="chip" class:on={vw === null ? !m.viewportOverride : m.viewportOverride === vw} data-action="preview-vp" data-w={vw ?? ""}>{lbl}</button>{/each}</div>
  {:else}
    <div class="grid2">
      <label class="fld"><span>Pos</span><select data-style="position">{#each ["static", "relative", "absolute"] as p (p)}<option selected={(st.position || "static") === p}>{p}</option>{/each}</select></label>
      <label class="fld"><span>Display</span><select data-style="display">{#each displays as [v, l] (v)}<option value={v} selected={(st.display || "") === v}>{l}</option>{/each}</select></label>
    </div>
  {/if}
</Section>

<Section key="node-flex" title="Auto layout" collapsible={false}>
  {#snippet actions()}
    {#if flex}<button class="icon-btn" data-action="unflex" title="Remove auto layout (flex)" aria-label="Remove flex"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button>{:else}<button class="icon-btn" data-action="flex" title="Add auto layout (flex) · Shift+A" aria-label="Add flex"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg></button>{/if}
  {/snippet}
  {#if flex}
    <div class="flex-row">
      <div class="align-grid" role="group" aria-label="Alignment">{#each alignCells as c (c.j + c.a)}<button data-action="align" data-j={c.j} data-a={c.a} class={c.on ? "on" : ""} title="{c.j} / {c.a}" aria-label="Align {c.j} / {c.a}"></button>{/each}</div>
      <div class="stack">
        <div class="seg"><button data-action="dir" data-dir="row" class={st.flexDirection !== "column" ? "on" : ""} title="Row"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg><span>Row</span></button><button data-action="dir" data-dir="column" class={st.flexDirection === "column" ? "on" : ""} title="Column"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M4.5 9.5L8 13l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg><span>Column</span></button></div>
        <Fld label="Gap" key="gap" value={st.gap} placeholder="0" />
      </div>
    </div>
    <div class="grid2"><Fld label="Padding" key="padding" value={st.padding} placeholder="0" wide /></div>
    <div class="grid2"><label class="fld wide"><span>Wrap</span><select data-style="flexWrap"><option value="">nowrap</option><option selected={st.flexWrap === "wrap"}>wrap</option></select></label></div>
  {/if}
  <label class="check"><input type="checkbox" data-style="overflow" value="hidden" checked={st.overflow === "hidden" || st.overflow === "clip"}> Clip content</label>
</Section>

<Section key="node-fill" title="Fill" collapsible={false}>
  {#snippet actions()}
    {#if st.backgroundColor}<button class="icon-btn" data-action="clear" data-key="backgroundColor" title="Remove fill" aria-label="Remove fill"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button>{/if}
  {/snippet}
  <ColorFld key="backgroundColor" value={st.backgroundColor} />
</Section>

<Section key="node-appearance" collapsible={false} title="Appearance">
  <div class="grid2"><Fld label="Radius" key="borderRadius" value={st.borderRadius} placeholder="0" /><label class="fld"><span>Opacity</span><input data-style="opacity" data-kind="percent" value={opacity}></label></div>
  <div class="grid2"><Fld label="Border" key="border" value={st.border} placeholder="none" mono wide /></div>
  <div class="grid2"><Fld label="Shadow" key="boxShadow" value={st.boxShadow} placeholder="none" mono wide /></div>
</Section>

{#if texty}
  <Section key="node-type" collapsible={false} title="Text style">
    <div class="grid2"><Fld label="Font" key="fontFamily" value={st.fontFamily} placeholder="inherit" list="font-families" kind="font" wide /></div>
    <div class="grid2"><Fld label="Size" key="fontSize" value={st.fontSize} placeholder="16" /><label class="fld"><span>Weight</span><select data-style="fontWeight">{#each weights as w (w)}<option value={w} selected={String(st.fontWeight || "") === w}>{w || "—"}</option>{/each}</select></label></div>
    <div class="grid2"><Fld label="Line" key="lineHeight" value={st.lineHeight} placeholder="normal" /><Fld label="Letter" key="letterSpacing" value={st.letterSpacing} placeholder="0" /></div>
    <div class="typo-color-row">
      <div class="color-wrap"><ColorFld key="color" value={st.color} placeholder="inherit" /></div>
      <div class="seg seg-align">{#each textAligns as [a, d] (a)}<button type="button" data-action="textAlign" data-v={a} class={(st.textAlign || "left") === a ? "on" : ""} title="Align {a}" aria-label="Align {a}"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path {d} stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg></button>{/each}</div>
    </div>
  </Section>
{/if}
{#if !n.children.length && !h.VOID_TAGS.has(n.tag) && !h.SVG_TAGS.has(n.tag)}
  <Section key="node-text" collapsible={false} title="Text" info="Double-click the layer on the canvas to edit it in place">
    <textarea class="code text" data-field="text" value={n.text}></textarea>
  </Section>
{/if}
{#if n.tag === "img" || n.tag === "a"}
  <Section key="node-attrs" collapsible={false} title={n.tag === "img" ? "Image" : "Link"}>
    {#if n.tag === "img"}
      <div class="grid2"><label class="fld wide"><span>src</span><input data-attr="src" value={n.attrs?.src || ""} placeholder="https://…"></label></div>
      <div class="grid2"><label class="fld wide"><span>alt</span><input data-attr="alt" value={n.attrs?.alt || ""}></label></div>
    {:else}
      <div class="grid2"><label class="fld wide"><span>href</span><input data-attr="href" value={n.attrs?.href || ""} placeholder="https://…"></label></div>
    {/if}
  </Section>
{/if}

<Section key="node-classes" collapsible={false} id="layer-classes" title="Shared classes" meta={mine.length ? String(mine.length) : ""} info="Classes from the project's Styles. A layer with a class shares its look with every other layer using it; the fields above show this layer's own overrides.">
  {#snippet actions()}
    <button class="icon-btn" data-action="make-class" disabled={!classable} title={classable ? "Make a class from this layer's styles" : "This layer has no styles of its own to share"} aria-label="Make class from this layer's styles"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg></button>
  {/snippet}
  {#if mine.length}
    <div class="chips">{#each mine as c (c)}<span class="class-chip" title={summary(c)}>.{c}<button type="button" data-action="remove-class" data-class={c} title="Remove .{c}" aria-label="Remove .{c}"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg></button></span>{/each}</div>
  {/if}
  {#if avail.length}
    <div class="grid2"><label class="fld wide"><span>Add</span><select data-class-add value=""><option value="">Choose a class…</option>{#each avail as c (c)}<option value={c}>.{c}</option>{/each}</select></label></div>
  {:else if !mine.length}
    <div class="hint">None yet. Use + to make one from this layer's styles.</div>
  {/if}
</Section>

<Section key="node-layer" title="Layer" open={false}>
  <div class="grid2"><label class="fld wide"><span>Name</span><input data-field="name" value={n.name}></label></div>
  <div class="grid2">
    <label class="fld"><span>Tag</span><select data-field="tag">{#each h.TAGS as t (t)}<option selected={t === n.tag}>{t}</option>{/each}</select></label>
    {#if ab}<label class="fld off"><span>Pos</span><select data-style="position" disabled>{#each ["static", "relative", "absolute"] as p (p)}<option selected={(st.position || "static") === p}>{p}</option>{/each}</select></label>{/if}
  </div>
  {#if ab}
    <div class="grid2"><label class="fld wide"><span>Display</span><select data-style="display">{#each displays as [v, l] (v)}<option value={v} selected={(st.display || "") === v}>{l}</option>{/each}</select></label></div>
  {/if}
  <div class="sub-h">Raw CSS
    <button type="button" class="link-toggle" data-action="toggle-css-json">{m.cssJsonOpen ? "Collapse" : "Expand"}<svg width="10" height="10" viewBox="0 0 12 12" fill="none" style="transform:rotate({m.cssJsonOpen ? 180 : 0}deg)"><path d="M3.5 4.75L6 7.25l2.5-2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
  </div>
  {#if m.cssJsonOpen}
    <div class="hint">Empty <code>""</code> or <code>null</code> removes a property · <kbd>Ctrl+Enter</kbd> applies</div>
    <textarea class="code" id="css-json" spellcheck="false" value={JSON.stringify(st, null, 2)}></textarea>
    <button class="btn subtle" data-action="apply-css" style="width:100%">Apply CSS</button>
  {/if}
</Section>
