<script>
  // Dashboard sidebar → the four most recently updated projects. Clicks are handled by the legacy listener.
  import { weft } from "../../lib/bridge.svelte.js";
  import { dash } from "../../lib/dashboard.svelte.js";
</script>

{#each dash.m.recent as p (p.id)}
  <button type="button" class="dash-recent-row" class:active={p.active} data-open-project={p.id}>
    <span class="dash-recent-dot" style="background:{p.accentColor || '#9ad6a4'}"></span>
    <span class="dash-recent-nm">{p.name}</span>
    {#if p.active}<span class="dash-open-pill">Open</span>{:else}<span class="dash-recent-meta">{weft.ago(p.updatedAt).replace(" ago", "")}</span>{/if}
  </button>
{/each}
