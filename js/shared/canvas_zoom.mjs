// Canvas zoom/pan passthrough for an in-node DOM widget (Classic renderer
// only — Nodes 2.0 already forwards wheel and middle-button pan to the
// canvas itself via its own node container, so every check here no-ops
// there). Without this, a DOM widget layered over the canvas (addDOMWidget)
// eats the wheel and the middle-button drag, so zooming or panning with the
// cursor over the node silently stops working — reported against every
// Pixaroma node with a DOM body (issue #17, and middle-pan 2026-09-13).
//
// Trimmed from ComfyUI-Pixaroma/js/shared/canvas_zoom.mjs (read in full):
// that version also protects a SCROLLABLE field inside the widget (a long
// prompt textarea) from having its own scroll stolen by the zoom-forward.
// Group Play has no scrollable content, so that half is left out — every
// wheel over this node always zooms the canvas, in both renderers.
import { app } from "../../../scripts/app.js";
import { isVueNodes } from "./nodes2.mjs";

const isMiddlePress = (e) => e.button === 1 || e.buttons === 4;
const isMiddleHeld = (e) => (e.buttons & 4) === 4;
const isMiddleRelease = (e) => e.button === 1;

function forwardPanToCanvas(e, matches) {
  if (isVueNodes()) return; // Nodes 2.0 forwards these itself
  if (!matches(e)) return;
  const canvasEl = app?.canvas?.canvas; // read lazily; the canvas can be recreated
  if (!canvasEl) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  canvasEl.dispatchEvent(new PointerEvent(e.type, e));
}

export function installCanvasZoomPassthrough(root) {
  if (!root || typeof root.addEventListener !== "function") return () => {};
  const onWheel = (e) => {
    if (isVueNodes()) return; // Nodes 2.0 forwards wheel to the canvas itself
    const canvasEl = app?.canvas?.canvas;
    if (!canvasEl) return;
    e.preventDefault();
    e.stopPropagation();
    const { clientX, clientY, deltaX, deltaY, deltaMode, ctrlKey, metaKey, shiftKey } = e;
    canvasEl.dispatchEvent(new WheelEvent("wheel", {
      clientX, clientY, deltaX, deltaY, deltaMode,
      ctrlKey, metaKey, shiftKey, bubbles: true, cancelable: true,
    }));
  };
  root.addEventListener("wheel", onWheel, { passive: false });
  const onPanDown = (e) => forwardPanToCanvas(e, isMiddlePress);
  const onPanMove = (e) => forwardPanToCanvas(e, isMiddleHeld);
  const onPanUp = (e) => forwardPanToCanvas(e, isMiddleRelease);
  root.addEventListener("pointerdown", onPanDown, true);
  root.addEventListener("pointermove", onPanMove, true);
  root.addEventListener("pointerup", onPanUp, true);
  return () => {
    root.removeEventListener("wheel", onWheel);
    root.removeEventListener("pointerdown", onPanDown, true);
    root.removeEventListener("pointermove", onPanMove, true);
    root.removeEventListener("pointerup", onPanUp, true);
  };
}
