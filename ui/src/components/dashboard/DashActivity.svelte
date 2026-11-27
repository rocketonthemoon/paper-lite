<script>
  // Dashboard → Agent activity: recent edit sessions, filtered by who made them. "Revert session" restores the
  // checkpoint taken when the session started.
  import { weft, clock } from "../../lib/bridge.svelte.js";
  import { dash } from "../../lib/dashboard.svelte.js";

  let filter = $state("all");
  const shown = $derived(dash.m.sessions.filter((s) => (filter === "agent" ? s.source === "mcp" : filter === "you" ? s.source !== "mcp" : true)));
  const tools = (tc) => Object.entries(tc || {}).map(([k, v]) => `${k} ×${v}`).join(" · ");
</script>

<div class="dash-act-head">
  <strong>Agent activity</strong>
  <span>Every MCP write, grouped into sessions · today</span>
  <div class="seg">
    {#each [["all", "All"], ["agent", "Agent"], ["you", "You"]] as [f, label] (f)}<button type="button" data-act-filter={f} class={filter === f ? "on" : ""} onclick={() => (filter = f)}>{label}</button>{/each}
  </div>
</div>
{#each shown.slice(0, 8) as s (s.id)}
  <div class="dash-act-row">
    <span class="dash-act-ic" class:live={s.live}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg></span>
    <div class="dash-act-info">
      <strong>{s.title || `${weft.plural(s.editCount || 1, "edit")} on ${s.artboard || "Canvas"}`}</strong>
      <span>{s.projectName || "Project"} · {s.artboard || "Page 1"} · {clock(s.startedAt)}</span>
    </div>
    <span class="dash-act-tools">{tools(s.toolCounts)}</span>
    <span class="dash-act-pill" class:live={s.live}>{s.live ? "Live" : s.reverted ? "Reverted" : "Done"}</span>
    <button type="button" class="btn" data-act-revert={s.id} onclick={() => weft.revertSession(s.id)} disabled={s.live || s.reverted || !s.checkpointId}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 6.5H10a3.5 3.5 0 010 7H7M6.5 4l-2.5 2.5L6.5 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>Revert session</button>
  </div>
{:else}
  <div class="dash-act-empty">No activity sessions recorded yet.</div>
{/each}
