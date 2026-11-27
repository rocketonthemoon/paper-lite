<script>
  // Suggestions for CSS fields (<datalist id="root-vars">): var(--name) for each root CSS variable.
  import { flushSync } from "svelte";
  import { weft } from "../lib/bridge.svelte.js";

  let vars = $state.raw([]);
  weft.events.addEventListener("root-vars", () => {
    const next = weft.rootVarNames();
    if (next.length === vars.length && next.every((v, i) => v === vars[i])) return; // render() sends this on every edit
    vars = next;
    flushSync();
  });
</script>

{#each vars as v (v)}<option value="var({v})"></option>{/each}
