<script>
  // A project card's menu on the dashboard (#dash-menu). The editor engine (src/editor) opens it for a card and places
  // it; the items run weft.dashMenuAction on that card's project.
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";

  let onlyProject = $state(false);
  weft.events.addEventListener("dash-menu", () => { onlyProject = weft.dashMenuModel().onlyProject; flushSync(); });
</script>

<button data-dact="open" onclick={() => weft.dashMenuAction("open")} class="dash-open-item">Open</button>
<button data-dact="rename" onclick={() => weft.dashMenuAction("rename")}>Rename…</button>
<button data-dact="duplicate" onclick={() => weft.dashMenuAction("duplicate")}>Duplicate</button>
<button data-dact="export-zip" onclick={() => weft.dashMenuAction("export-zip")}><span class="pn">Export .zip</span><span class="meta">HTML · JSX</span></button>
<div class="sep"></div>
<button data-dact="delete" onclick={() => weft.dashMenuAction("delete")} class="danger" disabled={onlyProject} title={onlyProject ? "The only project cannot be deleted" : undefined}>Delete…</button>
