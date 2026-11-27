// Projects: the project menu in the top bar (its contents are ../components/ProjectMenu.svelte).
import { ed } from "./state.js";
import { $ } from "./core.js";

export const projectMenu = $("#project-menu");

// The menu's contents (project list, actions, the new / rename / delete forms) are
// ui/src/components/ProjectMenu.svelte. This opens and closes it; "project-menu" tells it to start from the list.
export function openProjectMenu(open = projectMenu.hidden) {
  projectMenu.hidden = !open;
  $("#project-btn").setAttribute("aria-expanded", String(open));
  if (open) window.weft.events.dispatchEvent(new Event("project-menu"));
}
export function projectMenuModel() {
  return { projects: ed.projects, current: ed.S ? { id: ed.S.id, name: ed.S.name } : null };
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  $("#project-btn").addEventListener("click", () => openProjectMenu());
  document.addEventListener("pointerdown", (e) => { if (!projectMenu.hidden && !e.target.closest("#project-menu, #project-btn")) openProjectMenu(false); });
}
