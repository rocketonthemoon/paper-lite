<script>
  // Dashboard → the project grid or list, or "no matches" for a search. Clicks on cards / menus are handled by the
  // editor engine's listener on #dash-content (data-open-project, data-dash-menu).
  import { weft } from "../../lib/bridge.svelte.js";
  import { dash } from "../../lib/dashboard.svelte.js";
  import Thumb from "./Thumb.svelte";

  const m = $derived(dash.m);
  const stats = (p) => `${weft.plural(p.pages ?? 1, "page")} · ${weft.plural(p.artboards ?? 0, "artboard")} · ${(p.layers ?? 0).toLocaleString()} ${p.layers === 1 ? "layer" : "layers"}`;
  const newProject = () => document.getElementById("dash-new").click();
</script>

{#snippet menuButton(p)}
  <button class="icon-btn" data-dash-menu={p.id} aria-expanded="false" title="Project actions" aria-label="Project actions"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg></button>
{/snippet}

{#if !m.list.length}
  <div class="dash-empty">
    <span class="dash-empty-ic"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" /><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></span>
    <div style="display:flex;flex-direction:column;gap:4px">
      <strong>No projects match “{m.query}”</strong>
      <p>Try a different project name, clear your filter, or create a new project.</p>
    </div>
    <div class="dash-empty-acts">
      <button class="btn" id="dash-clear" onclick={() => weft.clearDashSearch()}>Clear search</button>
      <button class="btn primary" id="dash-empty-new" onclick={newProject}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg><span>New project</span></button>
    </div>
  </div>
{:else if m.view === "list"}
  <div class="dash-list">
    {#each m.list as p (p.id)}
      <div class="dash-row" class:active={p.active} data-pid={p.id}>
        <Thumb {p} compact />
        <div class="dash-meta" data-open-project={p.id}>
          <div class="dash-row-title"><span class="dash-name">{p.name}</span>{#if p.active}<span class="dash-inline-badge">Open</span>{/if}{#if p.agentEditing}<span class="dash-inline-agent">Agent editing</span>{/if}</div>
          <div class="dash-sub">Updated {weft.ago(p.updatedAt)}</div>
        </div>
        <div class="dash-row-stats">
          <span>{stats(p)}</span>
        </div>
        {@render menuButton(p)}
      </div>
    {/each}
  </div>
{:else}
  <div class="dash-grid">
    {#each m.list as p (p.id)}
      <article class="dash-card" class:active={p.active} data-pid={p.id}>
        <Thumb {p} />
        <div class="dash-card-foot">
          <div class="dash-meta" data-open-project={p.id}>
            <div class="dash-name-row"><span class="dash-name">{p.name}</span>{#if p.active}<span class="dash-inline-badge">Open</span>{/if}</div>
            <div class="dash-sub">{stats(p)} · {weft.ago(p.updatedAt)}</div>
          </div>
          {@render menuButton(p)}
        </div>
      </article>
    {/each}
    {#if !m.query}
      <button type="button" class="dash-card-new" id="dash-grid-new" onclick={newProject}><span class="dash-card-new-ic"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="#1d1d1f" stroke-width="1.6" stroke-linecap="round" /></svg></span><strong>New project</strong><span>Starts empty with Page 1. Agents can also call <code>create_project</code>.</span></button>
    {/if}
  </div>
{/if}
