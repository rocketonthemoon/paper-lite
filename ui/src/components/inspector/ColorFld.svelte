<script>
  // Colour field: a swatch with a native picker plus a text input, both carrying {attr}={key} (data-style for layer
  // styles, data-page for the page surface). `fallback` is shown when the value is unset instead of the "no fill" slash.
  import { weft } from "../../lib/bridge.svelte.js";
  let { key, value, placeholder = "none", attr = "data-style", fallback = "" } = $props();
  const h = weft.h;
  const shown = $derived(h.resolveVars(!value || value === "transparent" ? fallback : value));
</script>

<label class="fld"><span class="swatch" class:empty={!shown} style={shown ? `background:${shown}` : ""}><input type="color" {...{ [attr]: key }} value={h.hex6(shown || value)}></span><input {...{ [attr]: key }} value={value || ""} {placeholder} list="root-vars"></label>
