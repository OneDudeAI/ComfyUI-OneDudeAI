// Renderer-change signal (Nodes 2.0 <-> Legacy, live).
//
// Calls back when the user flips ComfyUI's "Modern Node Design (Nodes 2.0)"
// setting WITHOUT reloading the page. A node that chooses its UI once, at
// construction, is left holding the wrong one when the renderer changes
// under it (reported against ComfyUI-Pixaroma's Switch node, 2026-08-04:
// legacy->2.0 left the body empty; 2.0->legacy doubled it). Core's own nodes
// re-render correctly on the flip and the setting carries no requiresReload
// flag, so nothing else tells a custom node to refresh.
//
// Polled, not onChange: the setting belongs to core (Comfy.VueNodes.Enabled),
// so hanging a handler off it means registering a competing definition of
// somebody else's setting. `LiteGraph.vueNodesMode` is a plain global boolean
// both renderers already read every frame — watching it is version-proof.
// Ported from ComfyUI-Pixaroma/js/shared/renderer_switch.mjs (read in full).

const listeners = new Set();
let timer = null;
let last = null;

const INTERVAL_MS = 300; // a setting flip is rare; this is only a boolean read

function currentMode() {
  return !!window.LiteGraph?.vueNodesMode;
}

function tick() {
  const now = currentMode();
  if (now === last) return;
  last = now;
  // Iterate a copy: a handler may unregister itself (or delete its node)
  // while notifying, and one throwing handler must not stop the others.
  for (const cb of [...listeners]) {
    try {
      cb(now);
    } catch (err) {
      console.warn("[OneDudeAI] renderer-change handler failed", err);
    }
  }
}

/**
 * Register a callback fired with true (Nodes 2.0) or false (legacy) each
 * time the renderer changes. NOT called on registration — only on a change;
 * call the same check once yourself at node-creation time for the initial
 * state. Returns an unsubscribe function; call it from the node's onRemoved.
 */
export function onRendererChange(cb) {
  if (typeof cb !== "function") return () => {};
  listeners.add(cb);
  if (timer == null) {
    last = currentMode(); // seed from current mode so registering never fires a spurious change
    timer = setInterval(tick, INTERVAL_MS);
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer != null) {
      clearInterval(timer);
      timer = null;
      last = null;
    }
  };
}
