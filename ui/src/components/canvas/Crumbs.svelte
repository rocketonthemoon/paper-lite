<script>
  // Top bar breadcrumb: the page, then the artboard of the selection (or the first artboard).
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";

  let c = $state.raw({ page: "Page 1", artboard: "" });
  weft.events.addEventListener("overlay", () => { c = weft.overlay.crumbs; flushSync(); });
</script>

<span class="pg" id="crumb-page">{c.page}</span><span>/</span><span class="cur" id="crumb-ab">{c.artboard}</span>
