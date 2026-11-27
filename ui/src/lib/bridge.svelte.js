// Link between the editor engine (src/editor) and the Svelte components.
// The editor engine (src/editor) runs first and sets up window.weft: its helpers (api, toast, clock) and live data it receives
// over SSE. It fires an event on window.weft.events when data changes; this module mirrors that into rune state.
import { flushSync } from "svelte";

const weft = window.weft;

export const live = $state({ history: weft.history });

// Applied synchronously (flushSync), as the old string-built panels were: code that changes data and then reads the DOM
// in the same step keeps working.
weft.events.addEventListener("history", () => {
  live.history = weft.history;
  flushSync();
});

// The editor engine (src/editor) itself, for components that call into it (command palette entries, comment threads, …).
export { weft };

export const api = (...args) => weft.api(...args);
export const toast = (...args) => weft.toast(...args);
export const clock = (iso) => weft.clock(iso);
