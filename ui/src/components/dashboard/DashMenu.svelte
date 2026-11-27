<script>
  // A project card's menu on the dashboard (#dash-menu). The legacy script opens it for a card, places it and
  // handles its clicks (data-dact); this renders the items.
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";

  let onlyProject = $state(false);
  weft.events.addEventListener("dash-menu", () => { onlyProject = weft.dashMenuModel().onlyProject; flushSync(); });
</script>

<button data-dact="open" class="dash-open-item">Open</button>
<button data-dact="rename">Rename…</button>
<button data-dact="duplicate">Duplicate</button>
<button data-dact="export-zip"><span class="pn">Export .zip</span><span class="meta">HTML · JSX</span></button>
<div class="sep"></div>
<button data-dact="delete" class="danger" disabled={onlyProject} title={onlyProject ? "The only project cannot be deleted" : undefined}>Delete…</button>
