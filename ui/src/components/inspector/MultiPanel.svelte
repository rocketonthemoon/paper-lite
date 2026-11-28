<script>
  // Inspector while several layers are selected: what is selected and what can be done to all of them. Its buttons
  // (data-action) go through Inspector.svelte to the editor engine, like the single-layer panel's.
  let { m } = $props();
  const shown = $derived(m.multi.names.slice(0, 8));
</script>

<div class="sec">
  <div class="sec-h"><span>{m.multi.count} layers selected</span></div>
  <ul class="multi-names">
    {#each shown as name, i (i)}<li>{name}</li>{/each}
    {#if m.multi.count > shown.length}<li class="more">and {m.multi.count - shown.length} more</li>{/if}
  </ul>
  <div class="btnrow">
    <button type="button" class="btn" data-action="duplicate">Duplicate all</button>
    <button type="button" class="btn danger" data-action="delete">Delete all</button>
  </div>
  <p class="hint">
    {#if m.multi.movable}Drag any of them or use the arrow keys (Shift for 10px) to move {m.multi.movable === m.multi.count ? "them" : `the ${m.multi.movable} placed freely`} together.{/if}
    Shift+click a layer to add or remove it; Esc clears.
  </p>
</div>
