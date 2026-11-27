<script>
  // Font suggestions (<datalist id="font-families">) for the inspector's font fields: the project's font library
  // and the generic families.
  import { flushSync } from "svelte";
  import { weft } from "../lib/bridge.svelte.js";

  let fonts = $state.raw([]);
  weft.events.addEventListener("fonts", () => { fonts = weft.fontFamilies(); flushSync(); });
</script>

{#each fonts as f (f)}<option value={f}></option>{/each}
