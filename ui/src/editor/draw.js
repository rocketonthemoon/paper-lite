// Drawing new layers with the Frame, Rectangle and Text tools.
import { ed } from "./state.js";
import { $, GRID, elOf, isArtboard, isDarkColor, snapInput, stage, world } from "./core.js";
import { placeBox } from "./render.js";
import { createNode } from "./selection.js";

export function startCreate(e) {
  const s = stage.getBoundingClientRect();
  const a = { x: e.clientX - s.left, y: e.clientY - s.top, cx: e.clientX, cy: e.clientY };
  // Remember the artboard by id: a live update (e.g. an agent editing over MCP) can re-render the canvas before
  // pointerup, and a detached element measures as 0,0, which would drop the new layer at raw screen coordinates.
  const boardId = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.parentElement === world && el.dataset.nodeId)?.dataset.nodeId;
  const marquee = $("#marquee");
  const gestureTool = ed.tool; // fixed for the whole gesture, even if the tool changes before pointerup
  stage.setPointerCapture(e.pointerId);
  const move = (m) => {
    if (gestureTool === "text") return;
    const bx = m.clientX - s.left, by = m.clientY - s.top;
    placeBox(marquee, { x: Math.min(a.x, bx), y: Math.min(a.y, by), w: Math.abs(bx - a.x), h: Math.abs(by - a.y) });
  };
  const up = (u) => {
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", up);
    placeBox(marquee, null);
    const bx = u.clientX - s.left, by = u.clientY - s.top;
    const dragged = Math.abs(bx - a.x) > 4 || Math.abs(by - a.y) > 4;
    let x = (Math.min(a.x, bx) - ed.view.x) / ed.view.z, y = (Math.min(a.y, by) - ed.view.y) / ed.view.z;
    let w = Math.abs(bx - a.x) / ed.view.z, h = Math.abs(by - a.y) / ed.view.z;
    let parentId = ed.S.rootId;
    const board = boardId && isArtboard(boardId) ? elOf(boardId) : null; // the artboard's current element, if it still exists
    if (board) {
      const br = board.getBoundingClientRect();
      parentId = boardId;
      x = (Math.min(a.cx, u.clientX) - br.left) / ed.view.z;
      y = (Math.min(a.cy, u.clientY) - br.top) / ed.view.z;
    }
    const snap = (v) => (snapInput.checked ? Math.round(v / GRID) * GRID : Math.round(v));
    const pos = { position: "absolute", left: snap(x), top: snap(y) };
    const top = parentId === ed.S.rootId;
    const count = ed.S.nodes[ed.S.rootId].children.length + 1;
    if (gestureTool === "text") {
      const darkPage = isDarkColor(ed.S.nodes[ed.S.rootId].styles.backgroundColor);
      const styles = { ...pos, margin: 0, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, color: top && darkPage ? "#e6e6e6" : "#0a0b0d", whiteSpace: "pre-wrap" };
      if (top) Object.assign(styles, { width: null, height: null, backgroundColor: null, overflow: null });
      return createNode({ parentId, tag: "p", name: "Text", text: "Text", styles }, { edit: true });
    }
    const size = dragged ? { width: snap(w), height: snap(h) } : top && gestureTool === "frame" ? { width: 390, height: 844 } : { width: 100, height: 100 };
    const fill = gestureTool === "rect" ? "#dde3e9" : "#ffffff";
    const name = gestureTool === "rect" ? "Rectangle" : top ? `Frame ${count}` : "Frame";
    createNode({ parentId, tag: "div", name, styles: { ...pos, ...size, backgroundColor: fill } });
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
}
