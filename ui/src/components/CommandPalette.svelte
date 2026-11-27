<script>
  // Command palette (Ctrl/Cmd+K): search, highlight matches, arrows / Tab / Enter. The entries come from the legacy
  // script (weft.cmdkEntries()) because they depend on the editor's state; each has { group, label, dim, kbd, isKbd,
  // icon (trusted SVG markup), pinNum, mcp, isAgentReply, search, run }. Opening is driven by the legacy openCmdk(),
  // which shows #cmdk and fires "cmdk-open".
  // The DOM updates synchronously (flushSync) on open and on input, as it did before the move to Svelte: code that
  // types into the palette and clicks the first result in the same step sees the filtered list.
  import { flushSync, tick } from "svelte";
  import { weft } from "../lib/bridge.svelte.js";

  let query = $state("");
  let idx = $state(0);
  let entries = $state.raw([]);
  let input, list;

  weft.events.addEventListener("cmdk-open", () => {
    query = "";
    idx = 0;
    entries = weft.cmdkEntries();
    flushSync();
    input.focus();
  });

  const terms = $derived(query.trim().toLowerCase().split(/\s+/).filter(Boolean));
  const items = $derived(terms.length
    ? entries.filter((it) => {
      const hay = it.search || `${it.label} ${it.dim || ""} ${it.group} ${it.kbd}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    }).slice(0, 30)
    : entries.slice(0, 14));
  const active = $derived(Math.min(idx, Math.max(0, items.length - 1)));

  // Keep the highlighted row in view.
  $effect(() => {
    void active;
    tick().then(() => list?.querySelector(".cmdk-item.on")?.scrollIntoView({ block: "nearest" }));
  });

  // Split text into plain and matched parts for <mark>; Svelte escapes both.
  function parts(str) {
    const raw = String(str ?? "");
    if (!terms.length) return [{ text: raw }];
    const pat = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
    const out = [];
    let last = 0, m;
    while ((m = pat.exec(raw)) !== null) {
      if (m.index > last) out.push({ text: raw.slice(last, m.index) });
      out.push({ text: m[0], mark: true });
      last = m.index + m[0].length;
      if (m[0].length === 0) break;
    }
    if (last < raw.length) out.push({ text: raw.slice(last) });
    return out;
  }

  function run(it) {
    weft.closeCmdk();
    it.run();
  }

  function onInput() {
    idx = 0;
    entries = weft.cmdkEntries(); // the editor may have changed since the palette opened
    flushSync();
  }

  function onKeydown(e) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); weft.closeCmdk(); return; }
    if (!items.length) { if (e.key === "Tab") e.preventDefault(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); idx = (active + 1) % items.length; return; }
    if (e.key === "ArrowUp") { e.preventDefault(); idx = (active - 1 + items.length) % items.length; return; }
    if (e.key === "Tab") {
      e.preventDefault();
      const starts = [];
      items.forEach((it, i) => { if (!starts.length || items[starts[starts.length - 1]].group !== it.group) starts.push(i); });
      const g = Math.max(0, starts.findIndex((s) => items[s].group === items[active].group));
      idx = starts[(g + (e.shiftKey ? -1 : 1) + starts.length) % starts.length];
      return;
    }
    if (e.key === "Enter" && items[active]) { e.preventDefault(); run(items[active]); }
  }
</script>

{#snippet highlighted(text)}{#each parts(text) as p, i (i)}{#if p.mark}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}{/snippet}

<div class="cmdk-box">
  <div class="cmdk-head">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="#1d1d1f" stroke-width="1.5" /><path d="M10.5 10.5L14 14" stroke="#1d1d1f" stroke-width="1.5" stroke-linecap="round" /></svg>
    <input id="cmdk-input" placeholder="Jump to a layer, page, tool or action…" autocomplete="off" bind:value={query} bind:this={input} oninput={onInput} onkeydown={onKeydown}>
    <span class="cmdk-scope">Layers, pages, tools, actions</span>
    <button type="button" class="cmdk-esc" id="cmdk-esc" onclick={() => weft.closeCmdk()}>Esc</button>
  </div>
  <div class="cmdk-list" id="cmdk-list" bind:this={list}>
    {#each items as it, i (i)}
      {#if i === 0 || items[i - 1].group !== it.group}
        {#if i > 0}<div class="cmdk-sep"></div>{/if}
        <div class="cmdk-group">{it.group}</div>
      {/if}
      <button type="button" class="cmdk-item" class:on={i === active} data-cmdk-idx={i} onclick={() => run(it)}>
        {#if it.pinNum != null}<span class="cmdk-ic pin">{it.pinNum}</span>{:else}<span class="cmdk-ic">{@html it.icon || ""}</span>{/if}<span class="cmdk-label">{@render highlighted(it.label)}{#if it.dim}{" "}<span class="cmdk-dim">{@render highlighted(it.dim)}</span>{/if}</span>{#if it.mcp}<span class="mcp-badge">MCP</span>{/if}{#if it.kbd}<span class={it.isAgentReply ? "cmdk-sub agent-reply" : `cmdk-sub${it.isKbd ? " kbd" : ""}`}>{it.kbd}</span>{/if}
      </button>
    {:else}
      <div class="cmdk-empty">No matching commands or layers.</div>
    {/each}
  </div>
  <div class="cmdk-foot">
    <span><span class="cmdk-arrows"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M4.5 6.5L8 3l3.5 3.5" stroke="#8a8a87" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg><svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M4.5 9.5L8 13l3.5-3.5" stroke="#8a8a87" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg></span>Move</span><span><kbd>Enter</kbd>Run</span><span><kbd>Tab</kbd>Next group</span><span class="cmdk-count" id="cmdk-count">{items.length} {items.length === 1 ? "result" : "results"}</span>
  </div>
</div>
