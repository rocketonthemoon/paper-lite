// Pages: the page list model (../components/PagesList.svelte) and the stage's page title.
import { ed } from "./state.js";
import { $, api } from "./core.js";

// The page list is ui/src/components/PagesList.svelte (switch, rename, delete); this keeps the title in sync and
// hands it the pages.
export function renderPages() {
  $("#project-name").textContent = ed.S.name;
  document.title = `${ed.S.name} · weft`;
  window.weft.events.dispatchEvent(new Event("pages"));
}
export function pagesModel() {
  if (!ed.S) return [];
  return ed.S.pages.map((id) => ({ id, name: ed.S.nodes[id].name, artboards: ed.S.nodes[id].children?.length || 0, current: id === ed.S.rootId }));
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  $("#add-page").addEventListener("click", () => api("POST", "/api/pages", {}));
}
