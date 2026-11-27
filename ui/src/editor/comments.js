// Comments on the canvas: pins and the thread popover (../components/comments), the Comments tab's rows, and
// following the agent (Follow agent button, clicking an agent's cursor).
import { ed } from "./state.js";
import { $, ago, api, clock, commentThreadEl, commentsPanelEl, elOf, plural, stage, toast } from "./core.js";
import { commentPageId, commentPinMap, iconFor, pageCommentsList, rectOnStage, render, renderLayers } from "./render.js";
import { select } from "./selection.js";
import { fitTo, worldBounds, zoomCmd } from "./view.js";

const followBtn = $("#follow-agent-btn");
export function setFollowAgent(on, notify = false) {
  ed.followAgent = Boolean(on);
  localStorage.setItem("weft:follow-agent", ed.followAgent ? "1" : "0");
  followBtn.classList.toggle("follow-on", ed.followAgent);
  followBtn.setAttribute("aria-pressed", String(ed.followAgent));
  if (notify && !ed.followAgent) toast("Follow agent paused");
}

export function updateCommentsBadge() {
  const openCount = pageCommentsList().filter((c) => c.status !== "resolved").length;
  const b = $("#comments-tab-count");
  if (b) { b.textContent = String(openCount); b.hidden = openCount === 0; }
}

// The pins and the thread popover are ui/src/components/comments/*.svelte. This script decides which thread is open
// and where things sit on the stage (it owns the canvas DOM and view), and tells them when to re-read that.
export function commentPins() {
  if (!ed.S) return [];
  const pinMap = commentPinMap();
  return pageCommentsList().filter((c) => ed.S.nodes[c.nodeId] && (ed.showResolvedPins || c.status !== "resolved")).flatMap((c) => {
    const el = elOf(c.nodeId);
    if (!el) return [];
    const r = rectOnStage(el);
    return [{ id: c.id, status: c.status, sel: ed.activeThreadId === c.id, x: Math.round(r.x), y: Math.round(r.y), title: ed.S.nodes[c.nodeId].name, pin: String(pinMap.get(c.id) || "") }];
  });
}
export function renderCommentPins() {
  if (!ed.S) return;
  window.weft.events.dispatchEvent(new Event("comment-pins"));
  if (ed.activeThreadId || ed.draftCommentNodeId) positionCommentThread();
}

function positionCommentThread() {
  const nid = ed.draftCommentNodeId || ed.comments.find((c) => c.id === ed.activeThreadId)?.nodeId;
  const el = nid && elOf(nid);
  if (!el) {
    commentThreadEl.style.left = "24px";
    commentThreadEl.style.top = "24px";
    return;
  }
  const r = rectOnStage(el);
  const left = Math.max(16, Math.min(stage.clientWidth - 376, r.x + 18));
  const top = Math.max(16, Math.min(stage.clientHeight - 360, r.y + 18));
  commentThreadEl.style.left = `${Math.round(left)}px`;
  commentThreadEl.style.top = `${Math.round(top)}px`;
}

export function closeCommentThread() {
  ed.activeThreadId = null;
  ed.draftCommentNodeId = null;
  commentThreadEl.hidden = true;
  renderCommentThread();
  renderCommentPins();
}

export function openNewComment(nodeId) {
  if (!ed.S?.nodes[nodeId]) return;
  ed.activeThreadId = null;
  ed.draftCommentNodeId = nodeId;
  renderCommentThread();
  commentThreadEl.hidden = false;
  positionCommentThread();
  commentThreadEl.querySelector("textarea")?.focus();
}

export async function openCommentThread(id) {
  const c = ed.comments.find((x) => x.id === id);
  if (!c) return closeCommentThread();
  const cPage = commentPageId(c);
  if (ed.S && cPage && cPage !== ed.S.rootId) {
    const ok = await api("POST", `/api/pages/${encodeURIComponent(cPage)}/open`);
    if (ok && ed.S) { ed.S.rootId = cPage; render(); }
  }
  ed.draftCommentNodeId = null;
  ed.activeThreadId = id;
  if (ed.S?.nodes[c.nodeId]) {
    select(c.nodeId);
    requestAnimationFrame(() => fitTo(worldBounds([elOf(c.nodeId)].filter(Boolean)), 2));
  }
  renderCommentThread();
  commentThreadEl.hidden = false;
  positionCommentThread();
  renderCommentPins();
}

export function commentThread() {
  if (!ed.activeThreadId && !ed.draftCommentNodeId) return null;
  const isNew = Boolean(ed.draftCommentNodeId);
  const c = isNew ? { nodeId: ed.draftCommentNodeId, status: "open", agentsCanSee: true, messages: [] } : ed.comments.find((x) => x.id === ed.activeThreadId);
  if (!c) return null;
  const node = ed.S?.nodes?.[c.nodeId];
  return {
    key: isNew ? `new:${ed.draftCommentNodeId}` : `t:${ed.activeThreadId}`,
    id: c.id,
    isNew,
    resolved: c.status === "resolved",
    agentsCanSee: c.agentsCanSee !== false,
    layerName: node?.name || c.layerName || "Deleted layer",
    icon: node ? iconFor(node) : "",
    messages: (c.messages || []).map((m) => {
      const isAi = m.author !== "you";
      return {
        isAi,
        initial: isAi ? (m.author || "C")[0].toUpperCase() : "Y",
        author: isAi ? m.author : "You",
        clock: clock(m.at),
        text: m.text,
        link: m.linkedStep ? { label: `${m.linkedStep.label}${m.linkedStep.step ? ` · step ${m.linkedStep.step}` : ""}`, historyId: m.linkedStep.historyId } : null,
      };
    }),
  };
}
export function renderCommentThread() {
  if ((ed.activeThreadId || ed.draftCommentNodeId) && !commentThread()) return closeCommentThread();
  window.weft.events.dispatchEvent(new Event("comment-thread"));
}

// Called by the composer with what was typed; true when it was saved (so the composer clears).
export async function submitComment(text, agentsCanSee) {
  if (ed.draftCommentNodeId) {
    const created = await api("POST", "/api/comments", { nodeId: ed.draftCommentNodeId, text, agentsCanSee });
    if (!created) return false;
    if (!ed.comments.some((x) => x.id === created.id)) ed.comments = [...ed.comments, created];
    ed.draftCommentNodeId = null;
    ed.activeThreadId = created.id;
  } else if (ed.activeThreadId) {
    const res = await api("POST", `/api/comments/${encodeURIComponent(ed.activeThreadId)}/reply`, { text, agentsCanSee });
    if (!res) return false;
    ed.comments = ed.comments.map((x) => (x.id === res.id ? res : x));
  } else return false;
  updateCommentsBadge();
  renderLayers();
  renderCommentPins();
  renderCommentsPanel();
  renderCommentThread();
  return true;
}
// The Comments tab is ui/src/components/CommentsPanel.svelte; it asks for these rows (via window.weft) whenever
// renderCommentsPanel() says they changed.
export function commentRows() {
  if (!ed.S) return [];
  const pinMap = commentPinMap();
  const agentIds = new Set(ed.agentNodes.map((a) => a.id));
  return pageCommentsList().map((c) => {
    const node = ed.S.nodes[c.nodeId];
    const orphan = !node;
    const lastMsg = c.messages?.[c.messages.length - 1];
    const linkedCount = (c.messages || []).filter((m) => m.linkedStep).length;
    const resolvedClock = c.resolvedAt || lastMsg?.at || c.createdAt;
    const statusText = c.status === "replied"
      ? `${lastMsg?.author || "Claude"} replied`
      : c.status === "read"
        ? `Read ${clock(c.readAt)}`
        : c.status === "resolved"
          ? `Resolved${resolvedClock ? ` ${clock(resolvedClock)}` : ""}`
          : `Waiting · ${ago(c.createdAt).replace(" ago", "")}`;
    return {
      id: c.id,
      status: c.status,
      orphan,
      layerTitle: node?.name || c.layerName || "Deleted layer",
      statusText,
      pin: orphan ? "?" : c.status === "resolved" ? null : String(pinMap.get(c.id) || ""),
      preview: lastMsg?.text || "",
      meta: orphan
        ? (c.deletedInStep ? `Removed in step ${c.deletedInStep}` : "Layer removed")
        : `${plural(c.messages?.length || 0, "message")}${linkedCount ? ` · ${plural(linkedCount, "linked change")}` : ""}${c.status !== "resolved" && agentIds.has(c.nodeId) ? " · agent working" : ""}`,
    };
  });
}
export function renderCommentsPanel() {
  if (!ed.S || commentsPanelEl.hidden) return;
  window.weft.events.dispatchEvent(new Event("comments"));
}

// Listeners and initial state; ./index.js runs each module's setup() once, in startup order.
export function setup() {
  setFollowAgent(ed.followAgent);
  followBtn.addEventListener("click", () => {
    setFollowAgent(!ed.followAgent);
    toast(ed.followAgent ? "Following agent" : "Follow agent off");
  });
  $("#agents").addEventListener("click", (e) => {
    const cur = e.target.closest("[data-agent-node]");
    if (!cur) return;
    const nid = cur.dataset.agentNode;
    if (ed.S?.nodes[nid]) { select(nid); zoomCmd("selection"); }
  });

  commentThreadEl.addEventListener("pointerdown", (e) => e.stopPropagation());

  ed.renderRightPanels = () => {
    commentsPanelEl.hidden = ed.rightTab !== "comments";
    if (ed.rightTab === "comments") renderCommentsPanel();
  };
}
