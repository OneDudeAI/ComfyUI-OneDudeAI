import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

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
// interrupt (confirmed: every local pack that cancels a run, e.g.
// comfyui-vrgamedevgirl/web/music_video_builder/comfy_api.mjs, obvpm-timeline
// h3_tl_jobs.js, calls the same POST /interrupt with no per-node scoping), so
// the X stops whatever is currently executing, not provably just this
// group's job. In normal single-job use that's the same thing.
//
// Canvas-only for v1: the live D install has Comfy.VueNodes.Enabled = False
// (read from /api/settings), i.e. the classic LiteGraph renderer. In the
// Vue "Nodes 2.0" renderer, onDrawForeground/onMouseDown are skipped
// entirely (confirmed from ComfyUI-Pixaroma/js/monitor/index.js, which ships
// a whole separate DOM-widget face for that case) — this node intentionally
// does not build one yet, so it is inert there until that's added.

const FALLBACK_COLOR = "#f66744"; // Pixaroma orange — only used when the node isn't inside a group
const DEFAULT_SIZE = [120, 120];

function isVueNodes() {
  return !!window.LiteGraph?.vueNodesMode;
}

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
  _owner._odai_state = "idle";
  _owner._odai_progress = null;
  _owner = null;
  app.canvas?.setDirty?.(true, true);
}

function installListenersOnce() {
  if (_listenersInstalled || !api || typeof api.addEventListener !== "function") return;
  _listenersInstalled = true;

  api.addEventListener("executing", (e) => {
    const d = e && e.detail;
    const runningId = d && typeof d === "object" ? d.node : d;
    if (runningId == null) finishOwner();
    else app.canvas?.setDirty?.(true, true);
  });
  api.addEventListener("progress", (e) => {
    if (!_owner) return;
    const d = (e && e.detail) || {};
    _owner._odai_progress = { value: Number(d.value) || 0, max: Number(d.max) || 0 };
    app.canvas?.setDirty?.(true, true);
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
  app.canvas?.setDirty?.(true, true);

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
      return r;
    };

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

        ctx.strokeStyle = color + "40";
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
        const state = this._odai_state || "idle";
        if (state === "idle") queueGroup(this);
        else if (state === "running") cancelRun();
        return true;
      }
      return onMouseDown ? onMouseDown.apply(this, arguments) : false;
    };
  },
});
