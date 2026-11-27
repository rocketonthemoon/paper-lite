<script>
  // Inspector for the selected layer or artboard. Fields and buttons carry the same data-* attributes as before and
  // are passed by Inspector.svelte to the editor engine (input, change, keydown, click).
  import { weft } from "../../lib/bridge.svelte.js";
  import Fld from "./Fld.svelte";
  import ColorFld from "./ColorFld.svelte";

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

<div class="sec">
  <div class="grid2"><label class="fld wide"><span>Name</span><input data-field="name" value={n.name}></label></div>
  <div class="grid2">
    <label class="fld"><span>Tag</span><select data-field="tag">{#each h.TAGS as t (t)}<option selected={t === n.tag}>{t}</option>{/each}</select></label>
    <label class="fld" class:off={ab}><span>Pos</span><select data-style="position" disabled={ab}>{#each ["static", "relative", "absolute"] as p (p)}<option selected={(st.position || "static") === p}>{p}</option>{/each}</select></label>
  </div>
</div>
<div class="sec" id="layer-classes">
  <div class="sec-h">Shared classes <span class="muted">root CSS</span></div>
  {#if mine.length}
    <div class="chips">{#each mine as c (c)}<span class="class-chip" title={summary(c)}>.{c}<button type="button" data-action="remove-class" data-class={c} title="Remove .{c}" aria-label="Remove .{c}"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg></button></span>{/each}</div>
    <div class="hint">Fields below show this layer's own overrides.</div>
  {:else}
    <div class="hint">{m.definedClasses.length ? "None yet. Add one to share its styles." : "No shared classes yet. Turn this layer's styles into one to reuse them."}</div>
  {/if}
  {#if avail.length}
    <div class="grid2"><label class="fld wide"><span>Add</span><select data-class-add value=""><option value="">Choose a class…</option>{#each avail as c (c)}<option value={c}>.{c}</option>{/each}</select></label></div>
  {/if}
  <button class="btn subtle" data-action="make-class" style="width:100%" disabled={!classable} title={classable ? undefined : "This layer has no styles of its own to share"}>Make class from this layer's styles</button>
</div>
<div class="sec">
  <div class="sec-h">Layout</div>
  <div class="grid2">
    <Fld label="X" key="left" value={st.left} disabled={!abs} placeholder={abs ? undefined : "—"} title={abs ? undefined : "Set position: absolute to move freely"} />
    <Fld label="Y" key="top" value={st.top} disabled={!abs} placeholder={abs ? undefined : "—"} />
  </div>
  <div class="grid2"><Fld label="W" key="width" value={st.width} placeholder="auto" /><Fld label="H" key="height" value={st.height} placeholder="auto" /></div>
  <div class="grid2"><label class="fld wide"><span>Display</span><select data-style="display">{#each displays as [v, l] (v)}<option value={v} selected={(st.display || "") === v}>{l}</option>{/each}</select></label></div>
  {#if ab}
    <div class="chips">{#each presets as [lbl, pw, ph] (lbl)}<button type="button" class="chip" class:on={presetOn(pw, ph)} data-action="preset-size" data-w={pw ?? ""} data-h={ph}>{lbl}</button>{/each}</div>
  {/if}
</div>
<div class="sec">
  <div class="sec-h" class:solo={!flex}>Flex &amp; Spacing {#if flex}<button class="icon-btn" data-action="unflex" title="Remove flex" aria-label="Remove flex"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button>{:else}<button class="icon-btn" data-action="flex" title="Add flex (Shift+A)" aria-label="Add flex"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg></button>{/if}</div>
  {#if flex}
    <div class="flex-row">
      <div class="align-grid" role="group" aria-label="Alignment">{#each alignCells as c (c.j + c.a)}<button data-action="align" data-j={c.j} data-a={c.a} class={c.on ? "on" : ""} title="{c.j} / {c.a}" aria-label="Align {c.j} / {c.a}"></button>{/each}</div>
      <div class="stack">
        <div class="seg"><button data-action="dir" data-dir="row" class={st.flexDirection !== "column" ? "on" : ""} title="Row"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg><span>Row</span></button><button data-action="dir" data-dir="column" class={st.flexDirection === "column" ? "on" : ""} title="Column"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M4.5 9.5L8 13l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg><span>Column</span></button></div>
        <Fld label="Gap" key="gap" value={st.gap} placeholder="0" />
      </div>
    </div>
    <div class="grid2"><Fld label="Pad" key="padding" value={st.padding} placeholder="0" /><label class="fld"><span>Wrap</span><select data-style="flexWrap"><option value="">nowrap</option><option selected={st.flexWrap === "wrap"}>wrap</option></select></label></div>
  {/if}
  <label class="check"><input type="checkbox" data-style="overflow" value="hidden" checked={st.overflow === "hidden" || st.overflow === "clip"}> Clip content</label>
</div>
<div class="sec">
  <div class="sec-h">Surface &amp; Border {#if st.backgroundColor}<button class="icon-btn" data-action="clear" data-key="backgroundColor" title="Remove fill" aria-label="Remove fill"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button>{/if}</div>
  <div class="grid2"><div class="wide" style="grid-column:1/-1"><ColorFld key="backgroundColor" value={st.backgroundColor} /></div></div>
  <div class="grid2"><Fld label="Rad" key="borderRadius" value={st.borderRadius} placeholder="0" /><label class="fld"><span>Opc</span><input data-style="opacity" data-kind="percent" value={opacity}></label></div>
  <div class="grid2"><Fld label="Bdr" key="border" value={st.border} placeholder="1px solid #ebebea" mono wide /></div>
  <div class="grid2"><Fld label="Shd" key="boxShadow" value={st.boxShadow} placeholder="none" mono wide /></div>
</div>
{#if texty}
  <div class="sec">
    <div class="sec-h">Typography</div>
    <div class="grid2"><Fld label="Font" key="fontFamily" value={st.fontFamily} placeholder="inherit" list="font-families" kind="font" wide /></div>
    <div class="grid2"><Fld label="Size" key="fontSize" value={st.fontSize} placeholder="16" /><label class="fld"><span>Wt</span><select data-style="fontWeight">{#each weights as w (w)}<option value={w} selected={String(st.fontWeight || "") === w}>{w || "—"}</option>{/each}</select></label></div>
    <div class="grid2"><Fld label="Line" key="lineHeight" value={st.lineHeight} placeholder="normal" /><Fld label="Trk" key="letterSpacing" value={st.letterSpacing} placeholder="0" /></div>
    <div class="typo-color-row">
      <div class="color-wrap"><ColorFld key="color" value={st.color} placeholder="inherit" /></div>
      <div class="seg seg-align">{#each textAligns as [a, d] (a)}<button type="button" data-action="textAlign" data-v={a} class={(st.textAlign || "left") === a ? "on" : ""} title="Align {a}" aria-label="Align {a}"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path {d} stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg></button>{/each}</div>
    </div>
  </div>
{/if}
{#if !n.children.length && !h.VOID_TAGS.has(n.tag) && !h.SVG_TAGS.has(n.tag)}
  <div class="sec">
    <div class="sec-h">Text <span class="muted">double-click on canvas</span></div>
    <textarea class="code text" data-field="text" value={n.text}></textarea>
  </div>
{/if}
{#if n.tag === "img" || n.tag === "a"}
  <div class="sec">
    <div class="sec-h">Attributes</div>
    {#if n.tag === "img"}
      <div class="grid2"><label class="fld wide"><span>src</span><input data-attr="src" value={n.attrs?.src || ""} placeholder="https://…"></label></div>
      <div class="grid2"><label class="fld wide"><span>alt</span><input data-attr="alt" value={n.attrs?.alt || ""}></label></div>
    {:else}
      <div class="grid2"><label class="fld wide"><span>href</span><input data-attr="href" value={n.attrs?.href || ""} placeholder="https://…"></label></div>
    {/if}
  </div>
{/if}
<div class="sec">
  <div class="sec-h" class:solo={!m.cssJsonOpen}>Raw CSS JSON
    <button type="button" class="link-toggle" data-action="toggle-css-json">{m.cssJsonOpen ? "Collapse" : "Expand"}<svg width="10" height="10" viewBox="0 0 12 12" fill="none" style="transform:rotate({m.cssJsonOpen ? 180 : 0}deg)"><path d="M3.5 4.75L6 7.25l2.5-2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
  </div>
  {#if m.cssJsonOpen}
    <div class="hint">Empty <code>""</code> or <code>null</code> removes a property · <kbd>Ctrl+Enter</kbd> applies</div>
    <textarea class="code" id="css-json" spellcheck="false" value={JSON.stringify(st, null, 2)}></textarea>
    <button class="btn subtle" data-action="apply-css" style="width:100%">Apply CSS</button>
  {/if}
</div>
