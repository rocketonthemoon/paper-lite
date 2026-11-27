<script>
  // The toast's contents (#toast). The editor's toast() decides what to say and shows / hides it (the .show class
  // and its timer); an action button runs its callback and hides the toast.
  import { flushSync } from "svelte";
  import { weft } from "../lib/bridge.svelte.js";

  let t = $state.raw(null);
  weft.events.addEventListener("toast", () => { t = weft.toastModel(); flushSync(); });
</script>

{#if t}
  {#if t.agent}<span class="toast-dot"></span>{/if}<span class="toast-msg">{t.msg}</span>{#if t.action}<button type="button" class="toast-act" onclick={() => weft.toastAction()}>{t.action}</button>{/if}
{/if}
