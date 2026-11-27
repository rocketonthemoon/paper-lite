<script>
  // Artboard name + size labels above each screen. Positions are measured by the editor engine (src/editor). Pressing a
  // label selects the artboard (or pans), double-click renames it, and interact.js drags it (src/editor/drag.js).
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";

  let labels = $state.raw([]);
  weft.events.addEventListener("overlay", () => { labels = weft.overlay.labels; flushSync(); });
</script>

{#each labels as l (l.id)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ab-label" class:sel={l.sel} data-id={l.id} onpointerdown={(e) => weft.labelPointerDown(e, l.id)} ondblclick={() => weft.renameRow(l.id)} style:left="{l.x}px" style:top="{l.y}px" style:max-width="{l.maxW}px"><span class="ab-nm">{l.name}</span><span class="ab-dim">{l.dim}</span></div>
{/each}
