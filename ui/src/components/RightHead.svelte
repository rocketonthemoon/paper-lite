<script>
  // Header above the inspector: the selected layer or artboard with its actions ("N layers" for several, without
  // Preview), or the page with its counts.
  // Its buttons (preview, zoom, duplicate, delete) run weft.inspectorAction, like the inspector's.
  import { flushSync } from "svelte";
  import { weft } from "../lib/bridge.svelte.js";

  let m = $state.raw(null);
  weft.events.addEventListener("right-head", () => { m = weft.rightHeadModel(); flushSync(); });
</script>

{#if m && m.kind !== "page"}
  <div class="right-id" data-kind={m.kind}>
    <span class="right-title" title={m.name}>{m.name}</span>
    {#if m.agent}<span class="mcp-badge" title="Edited via MCP">MCP</span>{/if}
  </div>
  <div class="right-acts">
    {#if m.kind !== "multi"}
      <button class="icon-btn" data-action="preview" onclick={(e) => weft.inspectorAction(e.currentTarget)} title="Preview {m.kind === 'artboard' ? 'this screen' : 'its screen'} in a new tab (P)" aria-label="Preview screen"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5V13a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V4.5A.5.5 0 013 4h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
    {/if}
    <button class="icon-btn" data-action="zoom-sel" onclick={(e) => weft.inspectorAction(e.currentTarget)} title="Zoom to selection (Shift+2)" aria-label="Zoom to selection"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="4.5" /><path d="M8 1v3M8 12v3M1 8h3M12 8h3" /></svg></button>
    <button class="icon-btn" data-action="duplicate" onclick={(e) => weft.inspectorAction(e.currentTarget)} title="Duplicate (Ctrl+D)" aria-label="Duplicate"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M11 5V3.5A1 1 0 0010 2.5H3.5a1 1 0 00-1 1V10a1 1 0 001 1H5" /></svg></button>
    <button class="icon-btn del-act" data-action="delete" onclick={(e) => weft.inspectorAction(e.currentTarget)} title="Delete (Del)" aria-label="Delete"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></svg></button>
  </div>
{:else if m}
  <div class="right-id" data-kind="page">
    <span class="right-title" title={m.name}>{m.name}</span>
  </div>
  <span class="right-meta">{m.artboards} {m.artboards === 1 ? "artboard" : "artboards"} · {m.layers.toLocaleString()} {m.layers === 1 ? "layer" : "layers"}</span>
{/if}
