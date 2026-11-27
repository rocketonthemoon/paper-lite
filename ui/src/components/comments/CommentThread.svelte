<script>
  // The comment thread popover on the canvas: a new comment's composer, or an existing thread with its replies.
  // Which thread is open, and where the popover sits, is decided by the editor engine (src/editor); this renders it and keeps
  // what you are typing (and the More menu) while replies arrive over SSE.
  import { flushSync } from "svelte";
  import { weft, api } from "../../lib/bridge.svelte.js";

  let t = $state.raw(null);
  weft.events.addEventListener("comment-thread", () => { t = weft.commentThread(); flushSync(); });

  // Per-thread composer state; reset when another thread (or a new draft) opens.
  let text = $state("");
  let agentsCanSee = $state(true);
  let moreOpen = $state(false);
  let lastKey = null;
  $effect.pre(() => {
    const key = t?.key ?? null;
    if (key === lastKey) return;
    lastKey = key;
    text = "";
    agentsCanSee = t?.agentsCanSee !== false;
    moreOpen = false;
  });

  let input = $state();
  const id = () => encodeURIComponent(t.id);

  async function send() {
    const body = (input?.value ?? text).trim();
    if (!body) return;
    if (await weft.submitComment(body, agentsCanSee)) { text = ""; if (input) input.value = ""; }
  }
  async function act(name, extra) {
    moreOpen = false;
    if (name === "close") return weft.closeCommentThread();
    if (name === "resolve") { await api("PATCH", `/api/comments/${id()}`, { status: "resolved" }); return weft.closeCommentThread(); }
    if (name === "reopen") { await api("PATCH", `/api/comments/${id()}`, { status: "open" }); return; }
    if (name === "delete") { await api("DELETE", `/api/comments/${id()}`); return weft.closeCommentThread(); }
    if (name === "jump-step") return api("POST", "/api/history/jump", { id: extra });
    if (name === "undo-step") return api("POST", "/api/undo");
  }
  function keys(e) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); weft.closeCommentThread(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  }
  function outside(e) {
    if (moreOpen && !e.target.closest(".ct-more-wrap")) moreOpen = false;
  }
</script>

<svelte:document onclick={outside} />

{#if t}
  <div class="ct-head">
    {#if t.icon}<span class="ct-ic">{@html t.icon}</span>{/if}<strong>{t.layerName}</strong>
    {#if !t.isNew}
      <button type="button" class="btn ct-res-btn" data-ct={t.resolved ? "reopen" : "resolve"} onclick={() => act(t.resolved ? "reopen" : "resolve")}><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg><span>{t.resolved ? "Reopen" : "Resolve"}</span></button>
      <div class="ct-more-wrap">
        <button type="button" class="icon-btn" data-ct="more-toggle" aria-haspopup="menu" aria-expanded={moreOpen} title="More actions" aria-label="More actions" onclick={() => (moreOpen = !moreOpen)}><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg></button>
        <div class="menu ct-more-menu" id="ct-more-menu" role="menu" hidden={!moreOpen}><button type="button" data-ct="delete" class="danger" onclick={() => act("delete")}>Delete thread</button><button type="button" data-ct="close" onclick={() => act("close")}>Close</button></div>
      </div>
    {:else}
      <button type="button" class="icon-btn" data-ct="close" aria-label="Close" title="Close" onclick={() => act("close")}>×</button>
    {/if}
  </div>
  <div class="ct-msgs">
    {#each t.messages as m, i (i)}
      <div class="ct-msg">
        <span class="ct-av" class:ai={m.isAi}>{m.initial}</span>
        <div class="ct-body">
          <div class="ct-meta"><strong>{m.author}</strong>{#if m.isAi}<span class="mcp-badge">MCP</span>{/if}<span>{m.clock}</span></div>
          <div class="ct-text">{m.text}</div>
          {#if m.link}<div class="ct-link"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5H10a3.5 3.5 0 010 7H7M6.5 4l-2.5 2.5L6.5 9" /></svg><code>{m.link.label}</code><button type="button" class="link-toggle" data-ct="jump-step" data-hid={m.link.historyId} onclick={() => act("jump-step", m.link.historyId)}>View</button><button type="button" class="link-toggle" style="color:var(--text-2)" data-ct="undo-step" onclick={() => act("undo-step")}>Undo</button></div>{/if}
        </div>
      </div>
    {/each}
  </div>
  <div class="ct-comp">
    <textarea id="ct-input" bind:this={input} bind:value={text} onkeydown={keys} placeholder={t.isNew ? "Leave a note for your agent…" : "Reply, or resolve if this looks right…"}></textarea>
    <div class="ct-comp-acts">
      <button type="button" class="ct-vis" class:on={agentsCanSee} id="ct-vis" onclick={() => (agentsCanSee = !agentsCanSee)}><i></i>Agents can see this</button>
      <span class="kbd" style="margin-left:auto">Ctrl Enter</span>
      <button type="button" class="btn primary" style="height:28px;padding:0 12px" data-ct="send" onclick={send}>{t.isNew ? "Comment" : "Reply"}</button>
    </div>
  </div>
{/if}
