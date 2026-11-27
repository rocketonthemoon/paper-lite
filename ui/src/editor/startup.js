// Startup: the editor's initial state, the live connection, interact.js once it has loaded, and the read-only
// handles the browser tests and the devtools console use.
import { ed } from "./state.js";
import { api, app, stage, toast } from "./core.js";
import { applyView, render, updateOverlay } from "./render.js";
import { select, setTool } from "./selection.js";
import { setupInteract } from "./drag.js";
import { openDashboard } from "./dashboard.js";
import { connect, setRightTab } from "./sync.js";
import { openNewComment, renderCommentPins } from "./comments.js";

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  setTool("select");
  applyView();
  setRightTab(ed.rightTab);
  connect();
  // Opened at /#dashboard: show it once everything above (including window.weft) is set up.
  if (location.hash === "#dashboard") openDashboard(true);
  document.fonts?.ready.then(updateOverlay);
  window.addEventListener("load", setupInteract);

  // Read-only handles on the editor state for the browser tests and the devtools console (the editor's module-level
  // names are not globals).
  for (const [name, get] of Object.entries({
    S: () => ed.S, sel: () => ed.sel, tool: () => ed.tool, view: () => ed.view, hoverId: () => ed.hoverId, editingId: () => ed.editingId,
    busy: () => ed.busy, pendingRender: () => ed.pendingRender, activeThreadId: () => ed.activeThreadId, projects: () => ed.projects,
    comments: () => ed.comments,
  })) Object.defineProperty(window, name, { get, configurable: true });
  Object.assign(window, { app, stage, api, toast, render, select, setTool, openDashboard, openNewComment, renderCommentPins });
}
