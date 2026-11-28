<script>
  // Left panel → Layers: the tree of artboards and layers on the current page. Rows come from the editor engine (src/editor)
  // (weft.layerRows()); selecting, expanding, renaming and moving layers call back into it, which also enforces the
  // tree's rules (canNestIn / dropLayer). The filter box above the tree is still in ui/index.html.
  import { flushSync, tick } from "svelte";
  import { weft } from "../lib/bridge.svelte.js";

  let rows = $state.raw([]);
  let filtered = $state(false);
  const list = document.getElementById("layers"); // the component renders its rows straight into #layers
  // Leaving the whole tree clears the canvas hover box (not each 1px gap between rows).
  list.addEventListener("pointerleave", () => weft.hoverLayer(null));

  // Rows update synchronously, as the old string-built tree did (typing in the filter and reading the tree in the same step).
  function refresh() {
    ({ rows, filtered } = weft.layerRows());
    flushSync();
    list.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  }
  weft.events.addEventListener("layers", refresh);

  // ---- rename (double-click a row, or an artboard label on the canvas)
  let renaming = $state(null);
  let draft = $state("");
  weft.events.addEventListener("layer-rename", (e) => startRename(e.detail));
  function startRename(id) {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    draft = row.name;
    renaming = id;
  }
  const focusSelect = (el) => { el.focus(); el.select(); };
  function finishRename(save) {
    const id = renaming;
    if (id == null) return;
    renaming = null;
    const name = draft.trim();
    const row = rows.find((r) => r.id === id);
    if (!save || !name || !row || name === row.name) return;
    rows = rows.map((r) => (r.id === id ? { ...r, name } : r)); // show it now; the server's update follows
    weft.renameLayer(id, name);
  }
  function renameKeys(e) {
    e.stopPropagation();
    if (e.key === "Enter") finishRename(true);
    if (e.key === "Escape") finishRename(false);
  }

  // ---- clicks and hover
  function onRowClick(e, r) {
    if (e.target.closest("[data-twist]")) return weft.toggleExpanded(r.id);
    if (e.shiftKey || e.ctrlKey || e.metaKey) return weft.toggleSelect(r.id); // add or remove it from the selection
    weft.select(r.id);
  }
  async function onRowDblclick(e, r) {
    if (e.target.closest("[data-twist]") || renaming === r.id) return;
    weft.select(r.id);
    await tick();
    startRename(r.id);
  }

  // ---- drag to reorder / reparent
  let dragId = null;
  let drop = $state(null); // { id, zone } of the row under the pointer
  function zoneFor(e, rowEl, targetId) {
    const box = rowEl.getBoundingClientRect();
    const f = (e.clientY - box.top) / box.height;
    if (f < 0.3) return "before";
    if (f > 0.7) return "after";
    return weft.canNestIn(dragId, targetId) ? "inside" : f < 0.5 ? "before" : "after";
  }
  function onDragStart(e, r) {
    dragId = r.id;
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragOver(e, r) {
    if (!dragId) return;
    e.preventDefault();
    drop = { id: r.id, zone: zoneFor(e, e.currentTarget, r.id) };
  }
  function onDrop(e, r) {
    e.preventDefault();
    const id = dragId;
    const zone = id ? zoneFor(e, e.currentTarget, r.id) : null;
    dragId = null;
    drop = null;
    if (id && id !== r.id) weft.dropLayer(id, r.id, zone);
  }
  function onDragEnd() {
    dragId = null;
    drop = null;
  }
</script>

{#each rows as r (r.id)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
  <div
    class="row"
    class:sel={r.sel}
    class:agent-editing={r.agent}
    class:ab={r.artboard}
    class:drop-before={drop?.id === r.id && drop.zone === "before"}
    class:drop-after={drop?.id === r.id && drop.zone === "after"}
    class:drop-inside={drop?.id === r.id && drop.zone === "inside"}
    role="treeitem"
    aria-selected={r.sel}
    draggable={r.draggable ? "true" : undefined}
    data-id={r.id}
    style="--d:{r.depth}"
    onclick={(e) => onRowClick(e, r)}
    ondblclick={(e) => onRowDblclick(e, r)}
    onpointerover={() => weft.hoverLayer(r.id)}
    ondragstart={(e) => onDragStart(e, r)}
    ondragover={(e) => onDragOver(e, r)}
    ondragleave={() => { if (drop?.id === r.id) drop = null; }}
    ondrop={(e) => onDrop(e, r)}
    ondragend={onDragEnd}
  >
    <span class="tw {r.twist === 'open' ? 'open' : r.twist === 'none' ? 'none' : ''}" data-twist={filtered ? undefined : ""}><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.75 3.5L7.25 6l-2.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg></span><span class="ic">{@html r.icon}</span>{#if renaming === r.id}<input bind:value={draft} onkeydown={renameKeys} onblur={() => finishRename(true)} use:focusSelect>{:else}<span class="nm">{r.name}</span>{/if}{#if r.agent}<span class="mcp-badge">MCP</span>{/if}{#if r.comments}<span class="row-cmt" class:replied={r.comments.replied}><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 3.5h10a1 1 0 011 1v6a1 1 0 01-1 1H7l-3 2.5V11.5H3a1 1 0 01-1-1v-6a1 1 0 011-1z" fill={r.comments.replied ? "#fbe3d9" : "none"} stroke={r.comments.replied ? "#d97757" : "currentColor"} stroke-width="1.4" stroke-linejoin="round" /></svg>{r.comments.count}</span>{/if}{#if r.dim}<span class="dim">{r.dim}</span>{/if}
  </div>
{:else}
  {#if filtered}
    <div class="layers-empty">No matching layers.</div>
  {:else}
    <div class="layers-empty-card"><svg width="18" height="18" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3" width="11" height="10" rx="2" stroke="#8a8a87" stroke-width="1.4" stroke-dasharray="2.5 2" /></svg><strong>No artboards yet</strong><span>Press F for frame, or click + to add a 390×844 or 1440×900 artboard.</span></div>
  {/if}
{/each}
