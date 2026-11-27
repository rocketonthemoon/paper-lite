// Link between the legacy editor script (ui/index.html) and the Svelte components while the migration is in progress.
// The legacy script runs first and sets up window.weft: its helpers (api, toast, clock) and live data it receives
// over SSE. It fires an event on window.weft.events when data changes; this module mirrors that into rune state.
const weft = window.weft;

export const live = $state({ history: weft.history });

weft.events.addEventListener("history", () => {
  live.history = weft.history;
});

export const api = (...args) => weft.api(...args);
export const toast = (...args) => weft.toast(...args);
export const clock = (iso) => weft.clock(iso);
