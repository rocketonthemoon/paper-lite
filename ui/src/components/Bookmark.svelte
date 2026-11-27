<script>
  // Checkpoint marker: filled orange for an agent-run checkpoint.
  let { filled = false, color = "currentColor" } = $props();
</script>

<svg width="12" height="12" viewBox="0 0 16 16" fill={filled ? "#d97757" : "none"}>
  <path d="M4 2.5h8v11l-4-2.8-4 2.8z" stroke={filled ? "#d97757" : color} stroke-width="1.5" stroke-linejoin="round" />
</svg>
