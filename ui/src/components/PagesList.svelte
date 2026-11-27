<script>
  // Left panel → Pages: click to switch, double-click to rename, × to delete (with confirmation; undoable).
  import { flushSync } from "svelte";
  import { weft, api } from "../lib/bridge.svelte.js";

  let pages = $state.raw([]);
  weft.events.addEventListener("pages", () => { pages = weft.pages(); flushSync(); });

  let renaming = $state(null);
  let draft = $state("");
  const focusSelect = (el) => { el.focus(); el.select(); };

  function open(p) {
    if (!p.current && renaming !== p.id) api("POST", `/api/pages/${encodeURIComponent(p.id)}/open`);
  }
  function startRename(e, p) {
    if (e.target.closest("[data-del-page]")) return;
    draft = p.name;
    renaming = p.id;
  }
  function finishRename(save) {
    const id = renaming;
    if (id == null) return;
    renaming = null;
    const page = pages.find((p) => p.id === id);
    const name = draft.trim();
    if (!save || !name || !page || name === page.name) return;
    pages = pages.map((p) => (p.id === id ? { ...p, name } : p)); // show it now; the server's update follows
    api("PATCH", `/api/pages/${encodeURIComponent(id)}`, { name });
  }
  function renameKeys(e) {
    e.stopPropagation();
    if (e.key === "Enter") finishRename(true);
    if (e.key === "Escape") finishRename(false);
  }
  async function remove(e, p) {
    e.stopPropagation();
    if (confirm(`Delete page "${p.name}" and its ${p.artboards} artboard(s)? You can undo this.`)) await api("DELETE", `/api/pages/${encodeURIComponent(p.id)}`);
  }
</script>

{#each pages as p (p.id)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="page-row" class:cur={p.current} data-page={p.id} onclick={() => open(p)} ondblclick={(e) => startRename(e, p)}>
    {#if renaming === p.id}<input bind:value={draft} onkeydown={renameKeys} onblur={() => finishRename(true)} use:focusSelect>{:else}<span class="nm">{p.name}</span>{/if}
    <span class="pg-cnt">{p.artboards}</span>
    {#if pages.length > 1}<button class="icon-btn del" data-del-page={p.id} title="Delete page" aria-label="Delete page" onclick={(e) => remove(e, p)}><svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button>{/if}
  </div>
{/each}
