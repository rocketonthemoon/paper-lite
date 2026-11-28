<script>
  // The inspector body (#inspector): the selected layer's properties, a summary when several are selected, or the
  // page's settings when nothing is selected.
  // The editor engine (src/editor) decides when to render (it holds updates back while a field is being edited) and fires
  // "inspector"; detail.force asks for fresh fields, e.g. after Escape discards what was typed.
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";
  import NodePanel from "./NodePanel.svelte";
  import PagePanel from "./PagePanel.svelte";
  import MultiPanel from "./MultiPanel.svelte";

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
  const key = $derived(`${forced}:${m?.multi ? "multi" : m?.node?.id ?? "page"}`);
  function click(e) {
    const b = e.target.closest("[data-action]");
    if (b) weft.inspectorAction(b);
  }
</script>

<!-- Field events and data-action buttons from both panels go to the editor engine (weft.inspector*), which saves them
     to the selected layer or the page. display:contents keeps the panels' sections direct children for layout. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div style="display:contents" oninput={weft.inspectorInput} onchange={weft.inspectorChange} onkeydown={weft.inspectorKeydown} onfocusout={weft.inspectorFocusout} onclick={click}>
  {#key key}
    {#if m?.multi}
      <MultiPanel {m} />
    {:else if m?.node}
      <NodePanel {m} />
    {:else if m}
      <PagePanel {m} />
    {/if}
  {/key}
</div>
