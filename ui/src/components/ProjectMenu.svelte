<script>
  // The project menu under the project name: switch project, new, all projects, and rename / duplicate / export /
  // delete for the open one. New, rename and delete ask inside the menu (a small form) before acting.
  // Opening, closing on outside click and Escape stay in the legacy script.
  import { flushSync } from "svelte";
  import { weft, api, toast } from "../lib/bridge.svelte.js";

  let m = $state.raw({ projects: [], current: null });
  let form = $state(null); // { label, value, okText, danger, input, onOk }
  const refresh = () => { m = weft.projectMenu(); flushSync(); };
  weft.events.addEventListener("project-menu", () => { form = null; refresh(); });
  weft.events.addEventListener("projects", refresh);

  const close = () => weft.closeProjectMenu();
  async function openProject(id) {
    close();
    if (id !== m.current?.id) await api("POST", `/api/projects/${encodeURIComponent(id)}/open`);
  }
  function ask(f) {
    form = { input: true, value: "", danger: false, ...f };
  }
  async function submit() {
    const v = form.input ? form.value.trim() : true;
    if (form.input && !v) return;
    const onOk = form.onOk;
    close();
    form = null;
    await onOk(v);
  }
  function formKeys(e) {
    e.stopPropagation();
    if (e.key === "Enter") submit();
    if (e.key === "Escape") form = null;
  }
  const focusSelect = (el) => { el.focus(); el.select(); };

  const cur = $derived(m.current);
  function newProject() {
    ask({ label: "New project name", value: "Untitled", okText: "Create", onOk: (name) => api("POST", "/api/projects", { name }) });
  }
  function rename() {
    ask({ label: "Rename project", value: cur.name, okText: "Rename", onOk: (name) => api("PATCH", `/api/projects/${encodeURIComponent(cur.id)}`, { name }) });
  }
  async function duplicate() {
    close();
    const copy = await api("POST", `/api/projects/${encodeURIComponent(cur.id)}/duplicate`, {});
    if (copy) toast(`Created “${copy.name}”`);
  }
  function remove() {
    ask({ label: `Delete “${cur.name}” permanently? This cannot be undone.`, okText: "Delete project", danger: true, input: false,
      onOk: () => api("DELETE", `/api/projects/${encodeURIComponent(cur.id)}`) });
  }
</script>

{#if form}
  <div class="form"><div class="label" style="padding:0">{form.label}</div>
    {#if form.input}<label class="fld"><input id="menu-input" bind:value={form.value} onkeydown={formKeys} use:focusSelect></label>{/if}
    <div class="btnrow"><button class="btn {form.danger ? 'danger-solid' : 'primary'}" data-ok onclick={submit}>{form.okText}</button><button class="btn" data-cancel onclick={() => (form = null)}>Cancel</button></div></div>
{:else if cur}
  {#each m.projects as p (p.id)}
    <button data-open={p.id} class={p.active ? "cur" : undefined} onclick={() => openProject(p.id)}><span class="dot" style="background:{p.accentColor || '#9ad6a4'}"></span><span class="pn">{p.name}</span>{#if p.active}<span class="check-slot"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg></span>{:else}<span class="meta">{p.artboards ?? 0}</span>{/if}</button>
  {/each}
  <div class="sep"></div>
  <button data-act="new" onclick={newProject}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg><span class="pn">New project…</span></button>
  <button data-act="dashboard" onclick={() => { close(); weft.openDashboard(); }}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.4" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.4" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.4" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.4" /></svg><span class="pn">All projects…</span><span class="meta">Ctrl P</span></button>
  <div class="sep"></div>
  <button data-act="rename" onclick={rename}>Rename “{cur.name}”…</button>
  <button data-act="duplicate" onclick={duplicate}>Duplicate “{cur.name}”</button>
  <button data-act="export-zip" onclick={() => { close(); weft.downloadZip(cur.id); }}>Export “{cur.name}” (.zip)</button>
  <button data-act="delete" class="danger" disabled={m.projects.length < 2} title={m.projects.length < 2 ? "The only project cannot be deleted" : undefined} onclick={remove}>Delete “{cur.name}”…</button>
{/if}
