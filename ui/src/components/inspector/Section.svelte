<script>
  // A right-panel section with a title row that opens and closes it, like Figma's properties panel. `info` is help
  // text shown as the title's tooltip rather than as text in the panel. The open state is
  // remembered per section (localStorage). Collapsed content stays in the page (hidden), because the editor engine
  // and its fields look controls up by id / data-* at any time.
  let { key, title, meta = "", info = "", open: initial = true, collapsible = true, id = undefined, actions, children } = $props();

  // A section's key and collapsibility are fixed for its lifetime (the inspector re-creates panels per selection),
  // so reading them once is intended.
  // svelte-ignore state_referenced_locally
  const storeKey = `weft:panel:${key}`;
  const read = () => {
    try {
      const v = localStorage.getItem(storeKey);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  };
  // svelte-ignore state_referenced_locally
  let open = $state(collapsible ? read() : true);
  function toggle() {
    open = !open;
    try { localStorage.setItem(storeKey, open ? "1" : "0"); } catch {}
  }
</script>

<div class="sec" class:closed={!open} class:collapsible {id} data-section={key}>
  <div class="sec-h">
    {#if collapsible}
      <button type="button" class="sec-toggle" aria-expanded={open} onclick={toggle}>
        <span class="sec-title" title={info || undefined}>{title}</span>{#if meta}<span class="muted">{meta}</span>{/if}
      </button>
    {:else}
      <span class="sec-title" title={info || undefined}>{title}</span>{#if meta}<span class="muted">{meta}</span>{/if}
    {/if}
    <span class="sec-acts">
      {#if actions}{@render actions()}{/if}
      {#if collapsible}<button type="button" class="icon-btn sec-chev" aria-label={open ? `Collapse ${title}` : `Expand ${title}`} aria-expanded={open} onclick={toggle}><svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3.5 4.75L6 7.25l2.5-2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></button>{/if}
    </span>
  </div>
  <div class="sec-body" hidden={!open}>{@render children?.()}</div>
</div>
