<script>
  // A project's thumbnail. The legacy loadThumb() fetches the project's preview and draws it into .dash-thumb-world;
  // it runs again only when the project changed since it was drawn.
  import { weft } from "../../lib/bridge.svelte.js";
  let { p, compact = false } = $props();
  function draw(el, project) {
    let key = null;
    const run = (pr) => {
      const k = `${pr.id}:${pr.updatedAt}:${pr.bg || ""}:${pr.artboards}`;
      if (k === key) return;
      key = k;
      if (pr.artboards) weft.loadThumb(el, pr);
    };
    run(project);
    return { update: run };
  }
</script>

<div class="dash-thumb" data-open-project={p.id} style="background:{p.bg || '#eef2f6'}" use:draw={p}>
  {#if !p.artboards}
    <div class="dash-empty-thumb">{#if compact}<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="4" width="18" height="16" rx="2" stroke-dasharray="3 2" /></svg>{:else}<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="4" width="18" height="16" rx="2" stroke-dasharray="3 2" /></svg><span>Empty canvas</span>{/if}</div>
  {:else}
    <div class="dash-thumb-world"></div>
  {/if}
  {#if !compact && p.agentEditing}<span class="dash-agent-chip">Agent editing</span>{/if}
</div>
