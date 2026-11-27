// Shared dashboard state for the dashboard components: the editor engine (src/editor) fires "dashboard" whenever the project list,
// search, sort, view or activity change (and only while the dashboard is open).
import { flushSync } from "svelte";
import { weft } from "./bridge.svelte.js";

export const dash = $state({ m: { list: [], view: "grid", query: "", recent: [], sessions: [] } });
weft.events.addEventListener("dashboard", () => {
  dash.m = weft.dashboard();
  flushSync();
});
