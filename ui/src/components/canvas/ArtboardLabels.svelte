<script>
  // Artboard name + size labels above each screen. Positions are measured by the editor engine (src/editor), which also keeps
  // the pointer handlers (select, rename on double-click, drag with interact.js) delegated on #labels.
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";

  let labels = $state.raw([]);
  weft.events.addEventListener("overlay", () => { labels = weft.overlay.labels; flushSync(); });
</script>

{#each labels as l (l.id)}
  <div class="ab-label" class:sel={l.sel} data-id={l.id} style:left="{l.x}px" style:top="{l.y}px" style:max-width="{l.maxW}px"><span class="ab-nm">{l.name}</span><span class="ab-dim">{l.dim}</span></div>
{/each}
