<script>
  // Where MCP agents are working: a dashed box around each layer they are editing, and a cursor with the agent's
  // name and current tool. Clicking a cursor selects and shows the layer it is on.
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";

  let a = $state.raw({ boxes: [], cursors: [] });
  weft.events.addEventListener("overlay", () => { a = weft.overlay.agents; flushSync(); });
</script>

{#each a.boxes as b, i (i)}
  <div class="agent-box" style:left="{b.x}px" style:top="{b.y}px" style:width="{b.w}px" style:height="{b.h}px" style:border-color={b.color}></div>
{/each}
{#each a.cursors as c, i (i)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="agent-cursor" class:look={c.look} class:flip-x={c.flipX} class:flip-y={c.flipY} data-agent-node={c.nodeId} onclick={() => weft.focusAgentNode(c.nodeId)} style:left="{c.x}px" style:top="{c.y}px"><svg width="36" height="36" viewBox="0 0 28 28" fill="none"><path d="M4 3l19 8.4-8.2 2.4-3.3 8z" fill={c.look ? "#ffffff" : c.color} stroke={c.look ? c.color : "#ffffff"} stroke-width="2" stroke-linejoin="round" /></svg><div class="agent-cursor-tag" style:border-color={c.look ? c.color : undefined} style:color={c.look ? c.color : undefined} style:background={c.look ? undefined : c.color}><strong>{c.name}</strong>{#if c.sub}<span>{c.sub}</span>{/if}</div></div>
{/each}
