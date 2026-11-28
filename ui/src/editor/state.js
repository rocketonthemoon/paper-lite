// Editor state shared by the modules in this folder: one object, so any module can update it (an imported `let`
// can't be assigned). State only one module uses stays in that module.
export const ed = {
  S: null, // canvas state from server
  sel: null, // selected node id (with several selected, the one the inspector and context bar refer to)
  multi: [], // every selected id when more than one layer is selected (marquee, Shift+click, Ctrl+A); else empty
  pendingMulti: null, // ids to select once they arrive from the server (a duplicated multi-selection)
  hoverId: null,
  tool: "select",
  toolEpoch: 0, // toolEpoch counts tool picks, so a late reply can tell it was overtaken
  view: { x: 120, y: 120, z: 1 },
  projects: [], // [{ id, name, updatedAt, active }]
  fontLib: [], // font library entries from the server
  fontsRev: 0, // the server's font library revision (get_computed_styles only trusts this tab when it matches)
  editingId: null,
  editOriginal: "",
  pendingEdit: null,
  pendingSel: null,
  selEpoch: 0, // bumps on every explicit select(); async results only auto-select if it hasn't moved
  busy: false,
  pendingRender: false, // a drag/resize is in progress; a render is waiting for it to end
  // True while the mouse button is held on the canvas. Re-rendering then would swap out the element a gesture is acting
  // on (interact.js grabs it on pointerdown, before busy is set), so live updates wait until release.
  pointerHeld: false,
  spaceDown: false,
  inspectorDirty: false,
  cssJsonOpen: false, // UX #03: collapsed raw CSS JSON by default
  comments: [], // thread comments synced via SSE
  agentNodes: [], // [{ id, label, color }] nodes an MCP agent is working on, in that agent's color
  agentCursors: [], // live MCP agent cursors
  followAgent: localStorage.getItem("weft:follow-agent") === "1",
  followTimer: 0,
  activeThreadId: null,
  draftCommentNodeId: null,
  showResolvedPins: false,
  activitySessions: [], // dashboard activity sessions
  // The toast's contents are ui/src/components/Toast.svelte; this shows and hides it.
  toastNow: null,
  layerFilter: "",
  viewportOverrides: {}, // { [artboardId]: widthPx } local canvas responsive preview width
  // The dialog is ui/src/components/dashboard/DashDialog.svelte; this shows and hides it and holds its options.
  dashModalOpts: null,
  rightTab: localStorage.getItem("weft:right-tab") || "design",
  renderRightPanels: null, // extended by later tabs (comments)
};
