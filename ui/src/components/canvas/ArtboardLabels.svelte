<script>
  // Artboard name + size labels above each screen. Positions are measured by the editor engine (src/editor). Pressing a
  // label selects the artboard (or pans), double-click renames it, and interact.js drags it (src/editor/drag.js).
  // Viewport preset toggles let a single artboard preview @media breakpoints cleanly at 390 / 834 / 1440px.
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";

  let labels = $state.raw([]);
  weft.events.addEventListener("overlay", () => { labels = weft.overlay.labels; flushSync(); });
  const presets = [[390, "Mobile preview (390px)"], [834, "Tablet preview (834px)"], [1440, "Desktop preview (1440px)"]];
</script>

{#each labels as l (l.id)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ab-label" class:sel={l.sel} class:vp-on={Boolean(l.vp)} data-id={l.id} onpointerdown={(e) => weft.labelPointerDown(e, l.id)} ondblclick={() => weft.renameRow(l.id)} style:left="{l.x}px" style:top="{l.y}px" style:max-width={l.sel || l.vp ? "none" : `${l.maxW}px`}>
    <span class="ab-nm">{l.name}</span>
    {#if l.dim}<span class="ab-dim">{l.dim}</span>{/if}
    <span class="ab-vp" role="group" aria-label="Viewport preview presets" onpointerdown={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()}>
      {#each presets as [w, title] (w)}
        <button type="button" class="ab-vp-btn" class:on={l.vp === w} data-vp={w} {title} onclick={() => weft.setViewportOverride(l.id, l.vp === w ? null : w)}>{w}</button>
      {/each}
    </span>
  </div>
{/each}
