<script>
  // Right panel → History: checkpoints, the project's git remote, and the labelled undo history.
  // Markup and class names match the panel's CSS in ui/index.html.
  import { live, api, toast, clock } from "../lib/bridge.svelte.js";
  import Bookmark from "./Bookmark.svelte";
  import GitIcon from "./GitIcon.svelte";

  const hist = $derived(live.history);
  const remote = $derived(hist.remote || { connected: false });

  // ---- checkpoints
  let naming = $state(false);
  let cpName = $state("");
  let showAll = $state(false);
  const checkpoints = $derived([...(hist.checkpoints || [])].sort((a, b) => String(b.at).localeCompare(String(a.at))));
  const shownCheckpoints = $derived(showAll ? checkpoints : checkpoints.slice(0, 3));
  const cpMeta = (c) => `${c.auto ? (c.kind === "agent-start" ? "Auto · agent run" : "Auto") : "Saved"} · ${clock(c.at)}`;
  const cpTitle = (c) => `${c.name}${c.layerCount != null ? ` · ${c.layerCount} layers` : ""}`;

  function startNaming() {
    cpName = `Checkpoint ${clock(new Date().toISOString())}`;
    naming = true;
  }
  async function saveCheckpoint() {
    const name = cpName.trim() || `Checkpoint ${clock(new Date().toISOString())}`;
    naming = false;
    const cp = await api("POST", "/api/checkpoints", { name });
    if (cp) toast(`Saved checkpoint “${cp.name}”`);
  }
  async function restore(c) {
    const res = await api("POST", `/api/checkpoints/${encodeURIComponent(c.id)}/restore`);
    if (res) toast(`Restored “${c.name || "checkpoint"}”`, { action: "Undo", onAction: () => api("POST", "/api/undo") });
  }
  function nameKeys(e) {
    if (e.key === "Enter") { e.preventDefault(); saveCheckpoint(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); naming = false; }
  }
  // Focus and select the checkpoint name when the field appears.
  const focusSelect = (el) => { el.focus(); el.select(); };
  const focus = (el) => { el.focus(); };

  // ---- git remote
  let gitEditing = $state(false);
  let gitBusy = $state(null);
  let draft = $state({ url: "", token: "", username: "", autoPush: false });
  const whenShort = (iso) => {
    if (!iso) return "never";
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString() ? clock(iso) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(iso)}`;
  };
  const repoLabel = (url) => { try { const u = new URL(url); return `${u.host}${u.pathname.replace(/\.git$/, "")}`; } catch { return url; } };

  function editRemote() {
    draft = { url: remote.url || "", token: "", username: "", autoPush: Boolean(remote.autoPush) };
    gitEditing = true;
  }
  async function saveRemote() {
    if (!draft.url.trim()) { toast("Paste the repository's HTTPS URL"); return; }
    const wasConnected = remote.connected;
    const token = draft.token.trim();
    const res = await api("PUT", "/api/git/remote", { url: draft.url.trim(), username: draft.username.trim(), autoPush: draft.autoPush, ...(token ? { token } : {}) });
    if (!res) return;
    gitEditing = false;
    live.history = { ...hist, remote: res };
    toast(wasConnected ? "Git remote updated" : "Git remote connected · Push to send your checkpoints");
  }
  async function disconnect() {
    if (!confirm("Disconnect this git remote? The saved token is deleted. Checkpoints stay in this project.")) return;
    const res = await api("DELETE", "/api/git/remote");
    if (res) { gitEditing = false; live.history = { ...hist, remote: res }; toast("Git remote disconnected"); }
  }
  async function gitAction(kind) {
    gitBusy = kind;
    const res = await api("POST", `/api/git/${kind}`);
    gitBusy = null;
    if (!res) return;
    if (kind === "push") toast(res.pushed ? "Pushed checkpoints to the remote" : res.reason || "Nothing to push");
    else if (res.mode === "up-to-date" || res.mode === "empty-remote") toast(res.mode === "empty-remote" ? "The remote has no checkpoints yet" : "Already up to date");
    else toast(res.added?.length ? `Pulled ${res.added.length} checkpoint${res.added.length === 1 ? "" : "s"}; restore one to apply it` : "Pulled from the remote", { ms: 3500 });
  }
  function gitKeys(e) {
    if (e.target.tagName !== "INPUT") return;
    if (e.key === "Enter") { e.preventDefault(); saveRemote(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); gitEditing = false; }
  }

  // ---- undo history
  let filter = $state("all");
  let filterOpen = $state(false);
  const entries = $derived(hist.entries || []);
  const marksByEntry = $derived.by(() => {
    const m = new Map();
    for (const c of checkpoints) if (c.historyId) { if (!m.has(c.historyId)) m.set(c.historyId, []); m.get(c.historyId).push(c); }
    return m;
  });
  // Newest first, filtered by who made the change.
  const rows = $derived(entries.map((e, i) => ({ e, i })).reverse()
    .filter(({ e }) => filter === "all" || (filter === "agent" ? e.source === "mcp" : e.source !== "mcp")));
  const stepState = (i) => (i > hist.cursor ? "undone" : i === hist.cursor ? "cur" : "");
  const stepMeta = (e, i) => {
    const s = stepState(i);
    if (s === "undone") return "Undone · Ctrl+Shift+Z to redo";
    if (s === "cur") return `Current state · ${clock(e.at)}`;
    return `${clock(e.at)}${e.nodeIds?.length > 1 ? ` · ${e.nodeIds.length} layers` : e.source !== "mcp" ? " · You" : ""}`;
  };
  const canUndoAgent = $derived(entries.some((e, i) => i <= hist.cursor && e.source === "mcp"));

  function jump(i) { if (i !== hist.cursor) api("POST", "/api/history/jump", { index: i }); }
  async function undoAgentRun() {
    const res = await api("POST", "/api/history/undo-agent-run");
    if (res?.ok) toast(`Undid the last agent run (${res.undone} ${res.undone === 1 ? "step" : "steps"})`, { action: "Redo", onAction: () => api("POST", "/api/history/jump", { index: res.cursor + res.undone }) });
  }
  function toggleFilter() { filterOpen = !filterOpen; if (!filterOpen) filter = "all"; }
</script>

<div class="hist-scroll">
  <section class="hist-cps">
    <div class="sec-h"><span>Checkpoints</span><span class="muted">{checkpoints.length} saved</span></div>
    {#if naming}
      <div class="cp-new">
        <label class="fld"><input id="cp-name" bind:value={cpName} aria-label="Checkpoint name" onkeydown={nameKeys} use:focusSelect></label>
        <button class="btn primary" data-hist="cp-save" onclick={saveCheckpoint}>Save</button>
      </div>
    {:else}
      <button class="btn primary" data-hist="cp-new" onclick={startNaming}><Bookmark color="#ffffff" />Save checkpoint</button>
    {/if}
    {#each shownCheckpoints as c (c.id)}
      <div class="cp-row">
        <Bookmark filled={c.auto && c.kind === "agent-start"} />
        <div class="cp-text" title={cpTitle(c)}><span class="cp-name">{c.name}</span><span class="cp-meta">{cpMeta(c)}</span></div>
        <button class="link-toggle" data-hist="cp-restore" data-id={c.id} onclick={() => restore(c)}>Restore</button>
      </div>
    {/each}
    {#if checkpoints.length > 3}
      <button class="link-toggle cp-more" data-hist="cp-all" onclick={() => (showAll = !showAll)}>{showAll ? "Show fewer" : `Show all ${checkpoints.length}`}</button>
    {/if}
  </section>

  <section class="hist-git">
    {#if gitEditing}
      <div class="sec-h"><span>Git remote</span><span class="muted">{remote.connected ? "Edit" : "Connect"}</span></div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="git-form" onkeydown={gitKeys}>
        <label class="fld"><span>URL</span><input id="git-url" bind:value={draft.url} placeholder="https://github.com/you/design.git" autocomplete="off" spellcheck="false" use:focus></label>
        <label class="fld"><span>Token</span><input id="git-token" type="password" bind:value={draft.token} placeholder={remote.hasToken ? "Saved · leave blank to keep" : "Access token with write access"} autocomplete="new-password"></label>
        <label class="fld"><span>User</span><input id="git-user" bind:value={draft.username} placeholder={remote.connected && remote.username ? `${remote.username} (current)` : "Automatic"} autocomplete="off" spellcheck="false"></label>
        <label class="git-check"><input type="checkbox" id="git-autopush" bind:checked={draft.autoPush}> Push after each checkpoint</label>
        <div class="git-actions">
          {#if remote.connected}<button class="link-toggle danger" data-hist="git-disconnect" onclick={disconnect}>Disconnect</button>{/if}
          <button class="btn" data-hist="git-cancel" onclick={() => (gitEditing = false)}>Cancel</button>
          <button class="btn primary" data-hist="git-save" onclick={saveRemote}>{remote.connected ? "Save" : "Connect"}</button>
        </div>
        <div class="hint">The token stays on this server and is never shown again. Pull adds the remote's checkpoints; it doesn't change your design.</div>
      </div>
    {:else if !remote.connected}
      <div class="sec-h"><span>Git remote</span><span class="muted">Not connected</span></div>
      <button class="btn" data-hist="git-edit" onclick={editRemote}><GitIcon />Connect a git remote</button>
    {:else}
      <div class="sec-h"><span>Git remote</span><span class="muted">{remote.autoPush ? "Auto-push on" : "main"}</span></div>
      <div class="cp-row">
        <GitIcon />
        <div class="cp-text" title={remote.url}><span class="cp-name">{repoLabel(remote.url)}</span><span class="cp-meta">Pushed {whenShort(remote.lastPushAt)} · Pulled {whenShort(remote.lastPullAt)}</span></div>
        <button class="link-toggle" data-hist="git-edit" onclick={editRemote}>Edit</button>
      </div>
      {#if remote.lastError}<div class="git-err" role="status">{remote.lastError}</div>{/if}
      {#if !remote.hasToken}<div class="git-err" role="status">No token saved. Edit the remote and add one to push or pull.</div>{/if}
      <div class="git-actions">
        <button class="btn" data-hist="git-pull" disabled={Boolean(gitBusy)} onclick={() => gitAction("pull")}>{gitBusy === "pull" ? "Pulling…" : "Pull"}</button>
        <button class="btn" data-hist="git-push" disabled={Boolean(gitBusy)} onclick={() => gitAction("push")}>{gitBusy === "push" ? "Pushing…" : "Push"}</button>
      </div>
    {/if}
  </section>

  <section class="hist-list">
    <div class="sec-h"><span>Undo history</span><span class="hist-count">{hist.cursor + 1} / {hist.limit}</span></div>
    {#if filterOpen}
      <div class="seg hist-filter">
        {#each [["all", "All"], ["agent", "Agent"], ["you", "You"]] as [f, label] (f)}
          <button data-hist="filter" data-f={f} class={filter === f ? "on" : ""} onclick={() => (filter = f)}>{label}</button>
        {/each}
      </div>
    {/if}
    {#each rows as { e, i } (e.id)}
      <button type="button" class="hist-step {stepState(i)}" data-hist="jump" data-index={i} title={stepState(i) === "cur" ? "Current state" : "Jump to this step"} onclick={() => jump(i)}>
        <span class="hist-av" class:ai={e.source === "mcp"}>{e.source === "mcp" ? "AI" : "Y"}</span>
        <span class="hist-txt">
          <span class="hist-lbl">{#if e.tool}<code>{e.tool}</code>{e.target ? ` · ${e.target}` : ""}{:else}{e.label || ""}{/if}</span>
          <span class="hist-meta">{stepMeta(e, i)}</span>
        </span>
      </button>
      {#each marksByEntry.get(e.id) || [] as c (c.id)}
        <div class="hist-mark" class:manual={!c.auto}><Bookmark filled={c.auto && c.kind === "agent-start"} /><span>{c.name}</span></div>
      {/each}
    {:else}
      <div class="hist-empty">{entries.length ? "No steps match this filter." : "No edits yet. Every change by you or an agent shows up here, newest first. History resets when you switch projects."}</div>
    {/each}
  </section>
</div>
<div class="hist-foot">
  <button class="btn" data-hist="undo-agent" disabled={!canUndoAgent} title="Jump back to just before the agent's most recent run (also undoes anything after it)" onclick={undoAgentRun}>Undo last agent run</button>
  <button class="icon-btn" class:on={filterOpen || filter !== "all"} data-hist="filter-toggle" title="Filter by who made the change" aria-label="Filter history" onclick={toggleFilter}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5 8h6M7 12h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
  </button>
</div>
