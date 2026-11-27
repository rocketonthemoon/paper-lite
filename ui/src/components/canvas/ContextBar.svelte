<script>
  // Quick actions above the selection. The legacy script shows, hides and places the bar (#ctx-bar) and handles
  // its clicks (data-ctx); this renders what is in it for the selected layer.
  import { flushSync } from "svelte";
  import { weft } from "../../lib/bridge.svelte.js";

  let c = $state.raw({ name: "", preview: false, canFlex: true, isFlex: false });
  weft.events.addEventListener("overlay", () => { if (weft.overlay.ctx) { c = weft.overlay.ctx; flushSync(); } });
</script>

<span class="ctx-name" id="ctx-name">{c.name}</span>
<span class="ctx-sep"></span>
<button type="button" class="primary-act" data-ctx="copy">Copy HTML</button>
<button type="button" data-ctx="preview" id="ctx-preview" title="Preview this screen in a new tab (P)" hidden={!c.preview}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5V13a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V4.5A.5.5 0 013 4h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg><span>Preview</span></button>
<button type="button" data-ctx="duplicate">Duplicate</button>
<button type="button" data-ctx="flex" id="ctx-flex" hidden={!c.canFlex}>{#if c.isFlex}<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>{:else}<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>{/if}<span>Flex</span></button>
<button type="button" data-ctx="comment" title="Comment (C)"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3.5h10a1 1 0 011 1v6a1 1 0 01-1 1H7l-3 2.5V11.5H3a1 1 0 01-1-1v-6a1 1 0 011-1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg><span>Comment</span></button>
