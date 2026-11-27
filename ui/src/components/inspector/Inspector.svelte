<script>
  // The inspector body (#inspector): the selected layer's properties, or the page's settings when nothing is selected.
  // The legacy script decides when to render (it holds updates back while a field is being edited) and fires
  // "inspector"; detail.force asks for fresh fields, e.g. after Escape discards what was typed.
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";
  import NodePanel from "./NodePanel.svelte";
  import PagePanel from "./PagePanel.svelte";

  let m = $state.raw(null);
  let forced = $state(0);
  const host = document.getElementById("inspector");

  weft.events.addEventListener("inspector", (e) => {
    const scroll = host.scrollTop;
    m = weft.inspectorModel();
    if (e.detail?.force) forced += 1;
    flushSync();
    host.scrollTop = scroll;
  });
  // A fresh set of fields for each selected layer and for each forced render; otherwise fields update in place.
  const key = $derived(`${forced}:${m?.node?.id ?? "page"}`);
</script>

{#key key}
  {#if m?.node}
    <NodePanel {m} />
  {:else if m}
    <PagePanel {m} />
  {/if}
{/key}
