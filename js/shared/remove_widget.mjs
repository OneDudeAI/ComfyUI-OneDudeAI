// Take a widget off a node for good, the way the frontend wants it done.
//
// `node.removeWidget(w)` runs the widget's own onRemove (what stops ComfyUI
// re-mounting a DOM widget), unlinks any input pointed at it, and from
// frontend 1.54 also deletes the widget's entry in the widget value store.
// A bare `node.widgets.splice()` skips that last step — every DOM widget
// torn down by a renderer flip without it leaves its store entry behind.
// Ported from ComfyUI-Pixaroma/js/shared/remove_widget.mjs (read in full).
//
// Never throws. On a frontend without removeWidget, or if it throws, falls
// back to onRemove + splice so the widget is gone either way.
export function removeNodeWidget(node, widget) {
  if (!widget) return false;
  const list = node?.widgets;
  if (!Array.isArray(list) || list.indexOf(widget) < 0) {
    try { widget.onRemove?.(); } catch (_e) { /* element already detached */ }
    return false;
  }
  let onRemoveRan = false;
  if (typeof node.removeWidget === "function") {
    try {
      node.removeWidget(widget);
    } catch (_e) {
      onRemoveRan = true;
    }
    if (list.indexOf(widget) < 0) return true;
    onRemoveRan = true;
  }
  if (!onRemoveRan) {
    try { widget.onRemove?.(); } catch (_e) { /* element already detached */ }
  }
  const i = list.indexOf(widget);
  if (i >= 0) list.splice(i, 1);
  return true;
}
