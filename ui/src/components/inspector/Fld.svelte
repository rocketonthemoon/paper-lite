<script>
  // A labelled style field: <input data-style={key}>. The legacy inspector listeners commit it on change.
  import { weft } from "../../lib/bridge.svelte.js";
  let { label, key, value, placeholder, disabled = false, title, mono = false, kind, list = "root-vars", wide = false } = $props();
</script>

<label class="fld" class:wide class:off={disabled}><span>{label}</span><input data-style={key} value={weft.h.px(value)} {list} {placeholder} {disabled} {title} data-mono={mono ? "" : undefined} data-kind={kind}></label>
