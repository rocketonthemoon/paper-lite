<script>
  // The dashboard's dialog (#dash-modal): new project, rename, or delete confirmation. The legacy openDashModal()
  // passes the options (title, message, value, okText, danger, input, onOk) and shows / hides the backdrop.
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";

  let d = $state.raw(null);
  let field = $state();
  weft.events.addEventListener("dash-modal", () => {
    d = weft.dashModal();
    flushSync();
    if (field) { field.focus(); field.select(); }
  });

  async function submit() {
    const v = field ? field.value.trim() : true;
    if (field && !v) return field.focus();
    const onOk = d.onOk;
    weft.closeDashModal();
    await onOk(v);
  }
  function keys(e) {
    e.stopPropagation();
    if (e.key === "Enter") submit();
    if (e.key === "Escape") weft.closeDashModal();
  }
</script>

{#if d}
  {#key d}
  <div class="dash-dialog">
    <div class="dash-dialog-head">
      {#if d.danger}<span class="dash-dialog-ic"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></span>{/if}
      <div><h3>{d.title}</h3>{#if d.message}<p>{d.message}</p>{/if}</div>
    </div>
    {#if d.input}<label class="fld"><input id="dash-modal-input" value={d.value} bind:this={field} onkeydown={keys}></label>{/if}
    <div class="dash-dialog-acts">
      <button class="btn" id="dash-modal-cancel" onclick={() => weft.closeDashModal()}>Cancel</button>
      <button class="btn {d.danger ? 'danger-solid' : 'primary'}" id="dash-modal-ok" onclick={submit}>{d.okText}</button>
    </div>
  </div>
  {/key}
{/if}
