// Entry for the Svelte parts of the editor. The rest of the UI is still the inline script in ui/index.html, which runs
// first and exposes window.weft (see lib/bridge.svelte.js); panels move into components here one at a time.
import { mount } from "svelte";
import HistoryPanel from "./components/HistoryPanel.svelte";
import CommandPalette from "./components/CommandPalette.svelte";

mount(HistoryPanel, { target: document.getElementById("history-panel") });
mount(CommandPalette, { target: document.getElementById("cmdk") });

// The legacy script may have rendered before these mounted; ask it for the current data now.
window.weft.events.dispatchEvent(new Event("history"));
