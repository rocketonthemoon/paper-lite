<script>
  // Right panel → Comments: this page's threads, open or resolved. Rows come from the editor engine (src/editor)
  // (weft.commentRows()); the pins and thread popover on the canvas are comments/*.svelte.
  import { flushSync } from "svelte";
  import { weft, api } from "../lib/bridge.svelte.js";

  let rows = $state.raw([]);
  let filter = $state("open");
  let showResolvedPins = $state(weft.showResolvedPins);
  // Update the DOM right away, like the old panels did, so editor code reading it afterwards sees the new rows.
  weft.events.addEventListener("comments", () => { rows = weft.commentRows(); flushSync(); });

  const openRows = $derived(rows.filter((r) => r.status !== "resolved"));
  const resolvedRows = $derived(rows.filter((r) => r.status === "resolved"));
  const shown = $derived(filter === "resolved" ? resolvedRows : openRows);

  function restoreOrphan(e) {
    e.stopPropagation();
    api("POST", "/api/undo");
  }
</script>

<div class="cmts-filter">
  <button type="button" data-cf="open" class={filter === "open" ? "on" : ""} onclick={() => (filter = "open")}>Open · {openRows.length}</button>
  <button type="button" data-cf="resolved" class={filter === "resolved" ? "on" : ""} onclick={() => (filter = "resolved")}>Resolved · {resolvedRows.length}</button>
  <span class="cmts-scope">This page</span>
</div>
<div class="cmts-list">
  {#each shown as r (r.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="cmt-row" class:replied={r.status === "replied"} class:orphaned={r.orphan} data-open-cmt={r.id} onclick={() => weft.openCommentThread(r.id)}>
      <span class="cmt-pin sm {r.orphan ? 'orphaned' : r.status}">{#if r.pin == null}<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="#6b6b68" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>{:else}{r.pin}{/if}</span>
      <span class="cmt-row-body">
        <span class="cmt-row-top"><strong class={r.orphan ? "del" : ""}>{r.layerTitle}</strong>{#if r.orphan}<span class="cmt-warn-pill">Layer deleted</span>{:else}<span class="cmt-row-st" class:replied={r.status === "replied"}>{r.statusText}</span>{/if}</span>
        <span class="cmt-row-prev">{r.preview}</span>
        <span class="cmt-row-meta"><span>{r.meta}</span>{#if r.orphan}<button type="button" class="link-toggle" data-restore-orphan="1" onclick={restoreOrphan}>Restore</button>{/if}</span>
      </span>
    </div>
  {:else}
    <div class="hist-empty">{filter === "resolved" ? "No resolved comments yet." : "No open comments. Press C and click any layer to pin a note for your agent."}</div>
  {/each}
</div>
<div class="cmts-foot">
  <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600"><span style="width:6px;height:6px;border-radius:99px;background:var(--agent)"></span>Agents read comments over MCP</div>
  <code>get_comments · reply_to_comment · resolve_comment</code>
  <label class="cmt-check"><input type="checkbox" id="show-resolved-pins" bind:checked={showResolvedPins} onchange={() => (weft.showResolvedPins = showResolvedPins)}><span class="cmt-check-box" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg></span><span>Show resolved pins on canvas</span></label>
</div>
