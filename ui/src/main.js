// Entry for the Svelte parts of the editor. The rest of the UI is still the inline script in ui/index.html, which runs
// first and exposes window.weft (see lib/bridge.svelte.js); panels move into components here one at a time.
import { mount } from "svelte";
import HistoryPanel from "./components/HistoryPanel.svelte";
import CommentsPanel from "./components/CommentsPanel.svelte";
import CommandPalette from "./components/CommandPalette.svelte";
import LayersPanel from "./components/LayersPanel.svelte";
import RightHead from "./components/RightHead.svelte";
import Inspector from "./components/inspector/Inspector.svelte";

mount(HistoryPanel, { target: document.getElementById("history-panel") });
mount(CommentsPanel, { target: document.getElementById("comments-panel") });
mount(CommandPalette, { target: document.getElementById("cmdk") });
mount(LayersPanel, { target: document.getElementById("layers") });
mount(RightHead, { target: document.getElementById("right-head") });
mount(Inspector, { target: document.getElementById("inspector") });

// The legacy script starts first (this module loads after it), so it may already have sent data, or the user may
// have opened the palette, before these components listened. Replay the current state now.
const replay = (type) => window.weft.events.dispatchEvent(new Event(type));
replay("history");
replay("comments");
replay("layers");
replay("right-head");
replay("inspector");
if (!document.getElementById("cmdk").hidden) replay("cmdk-open");
