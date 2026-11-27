// The editor engine: canvas rendering, pan and zoom, drawing, drag and resize, keyboard shortcuts and the live
// connection to the server. Panels and menus are Svelte components (../components); this runs first (../main.js)
// and hands them their data through window.weft (../lib/bridge.svelte.js). Shared state is ./state.js; state used
// by one module only is kept in that module.
//
// Each module's setup() registers its listeners and initial state, in the order the editor has always started up.
// interact.js (drag and resize) and WeftRootCss (/root-css.js, shared with the server) are classic scripts on the page.
import { setup as coreSetup } from "./core.js";
import { setup as inspectorSetup } from "./inspector.js";
import { setup as viewSetup } from "./view.js";
import { setup as pointerSetup } from "./pointer.js";
import { setup as pagesSetup } from "./pages.js";
import { setup as projectsSetup } from "./projects.js";
import { setup as cmdkSetup } from "./cmdk.js";
import { setup as dashboardSetup } from "./dashboard.js";
import { setup as keyboardSetup } from "./keyboard.js";
import { setup as chromeSetup } from "./chrome.js";
import { setup as syncSetup } from "./sync.js";
import { setup as commentsSetup } from "./comments.js";
import { setup as startupSetup } from "./startup.js";

coreSetup();
inspectorSetup();
viewSetup();
pointerSetup();
pagesSetup();
projectsSetup();
cmdkSetup();
dashboardSetup();
keyboardSetup();
chromeSetup();
syncSetup();
commentsSetup();
startupSetup();
