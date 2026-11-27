<script>
  // Numbered comment pins over the canvas. Positions are measured by the legacy script (it owns the canvas DOM and
  // the view transform) and handed over through weft.commentPins() whenever the canvas, view or comments change.
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";

  let pins = $state.raw([]);
  weft.events.addEventListener("comment-pins", () => { pins = weft.commentPins(); flushSync(); });
</script>

{#each pins as p (p.id)}
  <button type="button" class="cmt-pin {p.status}" class:sel={p.sel} data-pin-id={p.id} style:left="{p.x}px" style:top="{p.y}px" title={p.title}
    onpointerdown={(e) => e.stopPropagation()} onclick={() => weft.openCommentThread(p.id)}
  >{#if p.status === "resolved"}<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="#6b6b68" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>{:else}{p.pin}{/if}</button>
{/each}
