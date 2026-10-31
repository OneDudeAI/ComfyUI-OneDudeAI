import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { isVueNodes } from "../shared/nodes2.mjs";
import { onRendererChange } from "../shared/renderer_switch.mjs";
import { removeNodeWidget } from "../shared/remove_widget.mjs";
import { installCanvasZoomPassthrough } from "../shared/canvas_zoom.mjs";

// OneDudeAI — Group Play
// A resizable node you drop inside a group. Idle: a play circle (colored to
// match the group — set the group's color with Pixaroma's own "Group Colors"
// right-click dialogue, this node just reads group.color live). Click it:
// queues ONLY that group's output nodes via ComfyUI's own partial-execution
// call, exactly like ComfyUI-Pixaroma's pixgroup module does
// (js/pixgroup/index.js: app.queuePrompt(0, 1, ids), ids = String(node.id) of
// every member whose constructor.nodeData.output_node is true). While that
// run is live the circle becomes a progress ring with a cancel "X" in the
// center; the X calls api.interrupt() — ComfyUI only has ONE global
// interrupt (confirmed: every local pack that cancels a run calls the same
// POST /interrupt with no per-node scoping), so the X stops whatever is
// currently executing, not provably just this group's job. In normal
// single-job use that's the same thing.
//
// Works in both renderers, built the way every title-less Pixaroma node
// does it (recipe read in full from ComfyUI-Pixaroma/js/monitor/index.js):
//   • Classic: no DOM widget — the face is painted straight onto the node's
//     own canvas in onDrawForeground, so LiteGraph keeps the drag/resize.
//   • Nodes 2.0 (Vue): onDrawForeground/onMouseDown are never called, so a
//     DOM widget (addDOMWidget) carries an inline SVG face instead, built
//     once and live-rebuilt on click.
//   • A node that picks its UI once, at construction, is left holding the
//     wrong one if the renderer is flipped without a page reload (that's
//     a real, reported Pixaroma bug, not a hypothetical) — so this also
//     subscribes to the live renderer-change poll and rebuilds its face on
//     a flip, same as Monitor/Switch/Label do.
//
// Not ported from Pixaroma for v1: its resize-floor / persisted-scale
// system. That exists to keep Monitor's generated TEXT legible at a
// Vue-forced minimum height; a plain circle has no such floor, so normal
// node resize (both renderers) is left to size it.

const FALLBACK_COLOR = "#f66744"; // Pixaroma orange — only used when the node isn't inside a group
const DEFAULT_SIZE = [120, 120];
const ALPHA_SUFFIX = "40"; // ~25% alpha, appended to a hex color string

function toast(severity, summary, detail) {
  try {
    app.extensionManager?.toast?.add({ severity, summary, detail, life: 4000 });
  } catch (_e) {
    // extensionManager not ready this early in some boot orders — never fatal
  }
}

function groupUnderNode(node) {
  const graph = app.graph;
  if (!graph || typeof graph.getGroupOnPos !== "function") return null;
  const cx = node.pos[0] + node.size[0] / 2;
  const cy = node.pos[1] + node.size[1] / 2;
  return graph.getGroupOnPos(cx, cy) || null;
}

function groupColorFor(node) {
  const g = groupUnderNode(node);
  return (g && g.color) || FALLBACK_COLOR;
}

// Explicit bounding-box containment — does not depend on reading any other
// pack's private member-list cache.
function groupMemberNodes(group) {
  const nodes = (app.graph && app.graph._nodes) || [];
  const gx = (group.pos || group._pos || [0, 0])[0];
  const gy = (group.pos || group._pos || [0, 0])[1];
  const gw = (group.size || group._size || [0, 0])[0];
  const gh = (group.size || group._size || [0, 0])[1];
  return nodes.filter((n) => {
    if (!n || !n.pos || !n.size) return false;
    const [nx, ny] = n.pos;
    const [nw, nh] = n.size;
    return nx >= gx && ny >= gy && nx + nw <= gx + gw && ny + nh <= gy + gh;
  });
}

function isOutputNode(n) {
  const NEVER = window.LiteGraph?.NEVER != null ? window.LiteGraph.NEVER : 2;
  return !!(
    n &&
    n.mode !== NEVER &&
    n.constructor &&
    n.constructor.nodeData &&
    n.constructor.nodeData.output_node
  );
}

function repaint(node) {
  app.canvas?.setDirty?.(true, true); // harmless no-op in Nodes 2.0
  if (node?._odaiRoot) renderVueFace(node);
}

// ── one shared "who is running" slot for every GroupPlay node ─────────────
// v1 limitation (documented, not hidden): there's one slot. If you press
// Play on a second GroupPlay node before the first run finishes, the ring
// follows whichever queued most recently — ComfyUI's progress/executing
// events carry a node id but no prompt id to tell the two runs apart
// (confirmed from the exact event shapes already in use locally).
let _owner = null;
let _listenersInstalled = false;

function finishOwner() {
  if (!_owner) return;
  const node = _owner;
  node._odai_state = "idle";
  node._odai_progress = null;
  _owner = null;
  repaint(node);
}

function installListenersOnce() {
  if (_listenersInstalled || !api || typeof api.addEventListener !== "function") return;
  _listenersInstalled = true;

  api.addEventListener("executing", (e) => {
    const d = e && e.detail;
    const runningId = d && typeof d === "object" ? d.node : d;
    if (runningId == null) finishOwner();
    else if (_owner) repaint(_owner);
  });
  api.addEventListener("progress", (e) => {
    if (!_owner) return;
    const d = (e && e.detail) || {};
    _owner._odai_progress = { value: Number(d.value) || 0, max: Number(d.max) || 0 };
    repaint(_owner);
  });
  api.addEventListener("execution_success", finishOwner);
  api.addEventListener("execution_error", finishOwner);
  api.addEventListener("execution_interrupted", finishOwner);
}

function queueGroup(node) {
  const group = groupUnderNode(node);
  if (!group) {
    toast("warn", "Not inside a group", "Drag this node fully inside a group, then press Play.");
    return;
  }
  try {
    group.recomputeInsideNodes?.();
  } catch (_e) {
    /* best-effort refresh only */
  }
  const members = groupMemberNodes(group).filter((n) => n !== node);
  const outs = members.filter(isOutputNode);
  if (!outs.length) {
    toast(
      "warn",
      "Nothing to run in this group",
      "Put an output node (a Save or Preview) inside, then press Play.",
    );
    return;
  }
  const ids = outs.map((n) => String(n.id));

  node._odai_state = "running";
  node._odai_progress = { value: 0, max: 0 };
  _owner = node;
  repaint(node);

  try {
    const r = app.queuePrompt(0, 1, ids);
    if (r && typeof r.then === "function") {
      r.catch((e) => {
        console.error("[OneDudeAI GroupPlay] run failed", e);
        finishOwner();
        toast("error", "Could not run this group", String((e && e.message) || e));
      });
    }
  } catch (e) {
    console.error("[OneDudeAI GroupPlay] run failed", e);
    finishOwner();
    toast("error", "Could not run this group", String((e && e.message) || e));
  }
}

function cancelRun() {
  try {
    api.interrupt();
  } catch (e) {
    console.error("[OneDudeAI GroupPlay] interrupt failed", e);
  }
}

function handleClick(node) {
  const state = node._odai_state || "idle";
  if (state === "idle") queueGroup(node);
  else if (state === "running") cancelRun();
}

// ── Nodes 2.0 (Vue) face: an inline SVG DOM widget ─────────────────────────
function svgIdle(color) {
  return `<svg viewBox="0 0 100 100" width="100%" height="100%" style="display:block">
    <circle cx="50" cy="50" r="42" fill="none" stroke="${color}" stroke-width="8"/>
    <path d="M 38 28 L 38 72 L 74 50 Z" fill="${color}"/>
  </svg>`;
}

function svgRunning(color, frac) {
  const circumference = 2 * Math.PI * 42;
  const dash = circumference * Math.max(0, Math.min(1, frac));
  return `<svg viewBox="0 0 100 100" width="100%" height="100%" style="display:block">
    <circle cx="50" cy="50" r="42" fill="none" stroke="${color}${ALPHA_SUFFIX}" stroke-width="8"/>
    <circle cx="50" cy="50" r="42" fill="none" stroke="${color}" stroke-width="8"
      stroke-dasharray="${dash} ${circumference}" stroke-linecap="round"
      transform="rotate(-90 50 50)"/>
    <line x1="35" y1="35" x2="65" y2="65" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/>
    <line x1="65" y1="35" x2="35" y2="65" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/>
  </svg>`;
}

function renderVueFace(node) {
  if (!node._odaiRoot) return;
  const color = groupColorFor(node);
  const state = node._odai_state || "idle";
  if (state === "running") {
    const p = node._odai_progress || { value: 0, max: 0 };
    const frac = p.max > 0 ? p.value / p.max : 0;
    node._odaiRoot.innerHTML = svgRunning(color, frac);
  } else {
    node._odaiRoot.innerHTML = svgIdle(color);
  }
}

function buildVueFace(node) {
  if (node._odaiRoot) return;
  const root = document.createElement("div");
  root.style.cssText =
    "width:100%;height:100%;min-width:40px;min-height:40px;display:flex;align-items:center;justify-content:center;cursor:pointer;";
  root.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    handleClick(node);
  });
  node._odaiRoot = root;
  node._odaiZoomOff = installCanvasZoomPassthrough(root);

  const widget = node.addDOMWidget("odai_group_play", "onedudeai_group_play", root, {
    getValue: () => null,
    setValue: () => {},
    getMinHeight: () => 40,
    serialize: false,
  });
  node._odaiWidget = widget;
  widget.computeLayoutSize = () => ({ minHeight: 40, minWidth: 40 });
  renderVueFace(node);
}

function teardownVueFace(node) {
  try {
    node._odaiZoomOff?.();
  } catch (_e) {
    /* best-effort */
  }
  node._odaiZoomOff = null;
  removeNodeWidget(node, node._odaiWidget);
  node._odaiWidget = null;
  node._odaiRoot = null;
}

function applyRenderer(node, vue) {
  if (vue) buildVueFace(node);
  else teardownVueFace(node);
}

app.registerExtension({
  name: "OneDudeAI.GroupPlay",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "OneDudeAI_GroupPlay") return;

    // Set once on the TYPE (not per-instance) — the Vue/Nodes-2.0 renderer
    // caches title_mode from a reactive copy taken at registration, so a
    // later per-node write is silently ignored (confirmed pattern used by
    // every title-less Pixaroma node: label, info, monitor, run_timer).
    const NO_TITLE = window.LiteGraph?.NO_TITLE != null ? window.LiteGraph.NO_TITLE : 1;
    nodeType.title_mode = NO_TITLE;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      this.size = [...DEFAULT_SIZE];
      this.resizable = true;
      installListenersOnce();
      this._odai_state = "idle";
      this._odai_progress = null;
      applyRenderer(this, isVueNodes());
      this._odaiRendererOff = onRendererChange((vue) => applyRenderer(this, vue));
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      try {
        this._odaiRendererOff?.();
      } catch (_e) {
        /* best-effort */
      }
      this._odaiRendererOff = null;
      if (_owner === this) _owner = null;
      teardownVueFace(this);
      return onRemoved ? onRemoved.apply(this, arguments) : undefined;
    };

    // Classic only: Nodes 2.0 never calls onDrawForeground, its DOM face
    // renders instead (confirmed: ComfyUI-Pixaroma/js/monitor/index.js:576).
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r0 = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
      if (!ctx || isVueNodes() || this.flags?.collapsed) return r0;

      const w = this.size[0];
      const h = this.size[1];
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.max(10, Math.min(w, h) / 2 - 6);
      const color = groupColorFor(this);
      const state = this._odai_state || "idle";

      ctx.save();
      if (state === "running") {
        const p = this._odai_progress || { value: 0, max: 0 };
        const frac = p.max > 0 ? Math.max(0, Math.min(1, p.value / p.max)) : 0;

        ctx.lineCap = "round";
        ctx.lineWidth = Math.max(3, radius * 0.14);

        ctx.strokeStyle = color + ALPHA_SUFFIX;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.stroke();

        const xr = radius * 0.32;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = Math.max(3, radius * 0.14);
        ctx.beginPath();
        ctx.moveTo(cx - xr, cy - xr);
        ctx.lineTo(cx + xr, cy + xr);
        ctx.moveTo(cx + xr, cy - xr);
        ctx.lineTo(cx - xr, cy + xr);
        ctx.stroke();
      } else {
        ctx.lineWidth = Math.max(2, radius * 0.08);
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        const tri = radius * 0.78;
        const offset = radius * 0.12;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(cx - tri / 2 + offset, cy - tri * 0.62);
        ctx.lineTo(cx - tri / 2 + offset, cy + tri * 0.62);
        ctx.lineTo(cx + tri * 0.7 + offset, cy);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      return r0;
    };

    const onMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (e, pos) {
      if (isVueNodes()) return onMouseDown ? onMouseDown.apply(this, arguments) : false;

      const w = this.size[0];
      const h = this.size[1];
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.max(10, Math.min(w, h) / 2 - 6);
      const dx = pos[0] - cx;
      const dy = pos[1] - cy;
      if (Math.hypot(dx, dy) <= radius) {
        handleClick(this);
        return true;
      }
      return onMouseDown ? onMouseDown.apply(this, arguments) : false;
    };
  },
});
