import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { isVueNodes } from "../shared/nodes2.mjs";
import { onRendererChange } from "../shared/renderer_switch.mjs";
import { removeNodeWidget } from "../shared/remove_widget.mjs";
import { installCanvasZoomPassthrough } from "../shared/canvas_zoom.mjs";

// OneDudeAI — Group Play
// A resizable node you drop inside a group — either a native ComfyUI group
// or one of Pixaroma's own pixgroup frames (app.graph.extra.pixaromaGroups —
// a separate, non-native system; confirmed live 2026-10-31 that a plain
// graph.getGroupOnPos miss there means nothing, Pixaroma groups don't show
// up in it at all). Idle: a play circle, colored like every other Pixaroma
// node — node.color, set with the standard right-click node color picker,
// no group-color matching. Click it: queues ONLY that group's output nodes
// via ComfyUI's own partial-execution call, exactly like ComfyUI-Pixaroma's
// pixgroup module does
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

const FALLBACK_COLOR = "#f66744"; // Pixaroma orange — only used until the node's own color is set
const DEFAULT_SIZE = [120, 120];
const ALPHA_SUFFIX = "40"; // ~25% alpha, appended to a hex color string

function toast(severity, summary, detail) {
  try {
    app.extensionManager?.toast?.add({ severity, summary, detail, life: 4000 });
  } catch (_e) {
    // extensionManager not ready this early in some boot orders — never fatal
  }
}

function nodeColorFor(node) {
  return node.color || FALLBACK_COLOR;
}

// Circle + optional vertical progress bar, both kept fully inside (w, h).
// A fixed margin wasn't enough once the node was resized into a wide
// rectangle (screenshot, 2026-10-31): a radius of min(w,h)/2 leaves the
// ring tangent to the shorter edge with zero clearance, so any rounding or
// the node's own border overflows it. MARGIN is subtracted from the
// SHORTER edge specifically to guarantee real clearance on every side.
const BAR_AREA = 56; // width reserved on the right for the bar + its % label
const BAR_W = 16;
const MARGIN = 18;

function layoutFor(w, h) {
  const showBar = w >= 150;
  const circleAreaW = showBar ? Math.max(10, w - BAR_AREA) : w;
  const cx = circleAreaW / 2;
  const cy = h / 2;
  const radius = Math.max(10, Math.min(circleAreaW, h) / 2 - MARGIN);
  let bar = null;
  if (showBar) {
    const barX = circleAreaW + (BAR_AREA - BAR_W) / 2;
    const top = MARGIN;
    const bottom = h - MARGIN - 18; // room for the % label below the bar
    bar = { x: barX, w: BAR_W, top, bottom, h: Math.max(0, bottom - top), labelY: h - MARGIN + 2 };
  }
  return { cx, cy, radius, bar };
}

function nativeGroupUnderNode(node) {
  const graph = app.graph;
  if (!graph || typeof graph.getGroupOnPos !== "function") return null;
  const cx = node.pos[0] + node.size[0] / 2;
  const cy = node.pos[1] + node.size[1] / 2;
  return graph.getGroupOnPos(cx, cy) || null;
}

// Pixaroma's own group system: NOT a native LGraphGroup, so graph.getGroupOnPos
// never sees it. Frames live at app.graph.extra.pixaromaGroups, an object of
// {id, title, x, y, w, h} keyed 0..N (confirmed live, 2026-10-31).
function pixgroupUnderNode(node) {
  const pix = app.graph?.extra?.pixaromaGroups;
  if (!pix || typeof pix !== "object") return null;
  const cx = node.pos[0] + node.size[0] / 2;
  const cy = node.pos[1] + node.size[1] / 2;
  for (const key of Object.keys(pix)) {
    const g = pix[key];
    if (g && typeof g.x === "number" && cx >= g.x && cy >= g.y && cx <= g.x + g.w && cy <= g.y + g.h) {
      return g;
    }
  }
  return null;
}

// Normalized {x, y, w, h} bounds for whichever group system the node sits
// in, native checked first. `native` carries the real LGraphGroup instance
// when there is one, so queueGroup can call its own recomputeInsideNodes.
function groupBoundsUnderNode(node) {
  const ng = nativeGroupUnderNode(node);
  if (ng) {
    const pos = ng.pos || ng._pos || [0, 0];
    const size = ng.size || ng._size || [0, 0];
    return { x: pos[0], y: pos[1], w: size[0], h: size[1], native: ng };
  }
  const pg = pixgroupUnderNode(node);
  if (pg) return { x: pg.x, y: pg.y, w: pg.w, h: pg.h, native: null };
  return null;
}

// Explicit bounding-box containment — does not depend on reading any other
// pack's private member-list cache.
function groupMemberNodes(bounds) {
  const nodes = (app.graph && app.graph._nodes) || [];
  return nodes.filter((n) => {
    if (!n || !n.pos || !n.size) return false;
    const [nx, ny] = n.pos;
    const [nw, nh] = n.size;
    return nx >= bounds.x && ny >= bounds.y && nx + nw <= bounds.x + bounds.w && ny + nh <= bounds.y + bounds.h;
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
  node._odai_totalIds = null;
  node._odai_finishedIds = null;
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
  // Whole-run total, separate from the ring's per-node step fraction above.
  // Real backend event, not invented: comfy_execution/progress.py
  // _send_progress_state sends { prompt_id, nodes: { id: {value,max,state,...} } }
  // for every node touched so far (state: pending/running/finished/error);
  // "pending" nodes are omitted until they start, so the fraction below is an
  // approximation that only gets more accurate as the run proceeds and is
  // exact at completion (the denominator stops growing once every node that
  // will run has started at least once).
  api.addEventListener("progress_state", (e) => {
    if (!_owner) return;
    const d = (e && e.detail) || {};
    const nodes = d.nodes || {};
    const seen = _owner._odai_totalIds || (_owner._odai_totalIds = new Set());
    const done = _owner._odai_finishedIds || (_owner._odai_finishedIds = new Set());
    for (const [id, st] of Object.entries(nodes)) {
      seen.add(id);
      if (st && st.state === "finished") done.add(id);
    }
    repaint(_owner);
  });
  api.addEventListener("execution_success", finishOwner);
  api.addEventListener("execution_error", finishOwner);
  api.addEventListener("execution_interrupted", finishOwner);
}

function queueGroup(node) {
  const bounds = groupBoundsUnderNode(node);
  if (!bounds) {
    toast("warn", "Not inside a group", "Drag this node fully inside a group, then press Play.");
    return;
  }
  try {
    bounds.native?.recomputeInsideNodes?.();
  } catch (_e) {
    /* best-effort refresh only */
  }
  const members = groupMemberNodes(bounds).filter((n) => n !== node);
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
  node._odai_totalIds = new Set();
  node._odai_finishedIds = new Set();
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

// Ring = current node's own step fraction (the "progress" event). Bar = whole
// run so far (the "progress_state" event, see installListenersOnce).
function fractionsFor(node) {
  const p = node._odai_progress || { value: 0, max: 0 };
  const ringFrac = p.max > 0 ? Math.max(0, Math.min(1, p.value / p.max)) : 0;
  const total = node._odai_totalIds ? node._odai_totalIds.size : 0;
  const done = node._odai_finishedIds ? node._odai_finishedIds.size : 0;
  const barFrac = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  return { ringFrac, barFrac };
}

function handleClick(node) {
  const state = node._odai_state || "idle";
  if (state === "idle") queueGroup(node);
  else if (state === "running") cancelRun();
}

// ── Nodes 2.0 (Vue) face: an inline SVG DOM widget ─────────────────────────
// viewBox stays a fixed 140x100 (not square): a right-hand column for the
// vertical progress bar + percentage, the rest for the circle. SVG's default
// preserveAspectRatio keeps this proportional at any box size.
//
// Every shape is drawn TWICE: a black halo first, the accent color on top.
// A node's right-click "solid color" option can set title and body to the
// SAME hex (that's what "solid" means), which would make an accent-colored
// shape disappear into an identically-colored body — reported 2026-10-31.
// The halo guarantees contrast regardless of what single color is picked.
function svgIdle(color) {
  return `<svg viewBox="0 0 140 100" width="100%" height="100%" style="display:block">
    <circle cx="48" cy="50" r="40" fill="none" stroke="#000000" stroke-width="11"/>
    <circle cx="48" cy="50" r="40" fill="none" stroke="${color}" stroke-width="8"/>
    <path d="M 36 28 L 36 72 L 72 50 Z" fill="#000000" stroke="#000000" stroke-width="4" stroke-linejoin="round"/>
    <path d="M 36 28 L 36 72 L 72 50 Z" fill="${color}"/>
  </svg>`;
}

function svgRunning(color, ringFrac, barFrac) {
  const rf = Math.max(0, Math.min(1, ringFrac));
  const bf = Math.max(0, Math.min(1, barFrac));
  const circumference = 2 * Math.PI * 40;
  const dash = circumference * rf;
  const barTop = 10, barBottom = 82, barH = barBottom - barTop;
  const fillTop = barBottom - barH * bf;
  const pct = Math.round(bf * 100);
  return `<svg viewBox="0 0 140 100" width="100%" height="100%" style="display:block">
    <circle cx="48" cy="50" r="40" fill="none" stroke="#000000" stroke-width="11"/>
    <circle cx="48" cy="50" r="40" fill="none" stroke="${color}${ALPHA_SUFFIX}" stroke-width="8"/>
    <circle cx="48" cy="50" r="40" fill="none" stroke="${color}" stroke-width="8"
      stroke-dasharray="${dash} ${circumference}" stroke-linecap="round"
      transform="rotate(-90 48 50)"/>
    <line x1="35" y1="37" x2="61" y2="63" stroke="#000000" stroke-width="10" stroke-linecap="round"/>
    <line x1="61" y1="37" x2="35" y2="63" stroke="#000000" stroke-width="10" stroke-linecap="round"/>
    <line x1="35" y1="37" x2="61" y2="63" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
    <line x1="61" y1="37" x2="35" y2="63" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
    <rect x="117" y="${barTop - 1}" width="14" height="${barH + 2}" rx="6" fill="#000000"/>
    <rect x="118" y="${barTop}" width="12" height="${barH}" rx="5" fill="${color}${ALPHA_SUFFIX}"/>
    <rect x="118" y="${fillTop}" width="12" height="${barH * bf}" rx="5" fill="${color}"/>
    <text x="124" y="95" text-anchor="middle" font-size="13" fill="#000000" font-family="sans-serif" stroke="#000000" stroke-width="3" paint-order="stroke">${pct}%</text>
    <text x="124" y="95" text-anchor="middle" font-size="13" fill="#ffffff" font-family="sans-serif">${pct}%</text>
  </svg>`;
}

function renderVueFace(node) {
  if (!node._odaiRoot) return;
  const color = nodeColorFor(node);
  const state = node._odai_state || "idle";
  if (state === "running") {
    const { ringFrac, barFrac } = fractionsFor(node);
    node._odaiRoot.innerHTML = svgRunning(color, ringFrac, barFrac);
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
      this._odai_totalIds = null;
      this._odai_finishedIds = null;
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

      const { cx, cy, radius, bar } = layoutFor(this.size[0], this.size[1]);
      const color = nodeColorFor(this);
      const state = this._odai_state || "idle";

      // Every stroke/fill below is drawn twice: a black halo first, the
      // accent color on top. A "solid color" node-color pick can set title
      // and body to the SAME hex, which would make an accent-colored shape
      // disappear into an identically-colored body (reported 2026-10-31) —
      // the halo guarantees contrast regardless of what color is picked.
      ctx.save();
      if (state === "running") {
        const { ringFrac, barFrac } = fractionsFor(this);
        const lw = Math.max(3, radius * 0.14);

        ctx.lineCap = "round";
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = lw + 4;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.lineWidth = lw;
        ctx.strokeStyle = color + ALPHA_SUFFIX;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + ringFrac * Math.PI * 2);
        ctx.stroke();

        const xr = radius * 0.32;
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = lw + 4;
        ctx.beginPath();
        ctx.moveTo(cx - xr, cy - xr);
        ctx.lineTo(cx + xr, cy + xr);
        ctx.moveTo(cx + xr, cy - xr);
        ctx.lineTo(cx - xr, cy + xr);
        ctx.stroke();

        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(cx - xr, cy - xr);
        ctx.lineTo(cx + xr, cy + xr);
        ctx.moveTo(cx + xr, cy - xr);
        ctx.lineTo(cx - xr, cy + xr);
        ctx.stroke();

        if (bar) {
          ctx.lineCap = "butt";
          ctx.fillStyle = "#000000";
          ctx.fillRect(bar.x - 2, bar.top - 2, bar.w + 4, bar.h + 4);

          ctx.fillStyle = color + ALPHA_SUFFIX;
          ctx.fillRect(bar.x, bar.top, bar.w, bar.h);
          const filledH = bar.h * barFrac;
          ctx.fillStyle = color;
          ctx.fillRect(bar.x, bar.bottom - filledH, bar.w, filledH);

          const label = Math.round(barFrac * 100) + "%";
          ctx.font = "13px sans-serif";
          ctx.textAlign = "center";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#000000";
          ctx.strokeText(label, bar.x + bar.w / 2, bar.labelY);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(label, bar.x + bar.w / 2, bar.labelY);
        }
      } else {
        const lw = Math.max(2, radius * 0.08);
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = lw + 4;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        const tri = radius * 0.78;
        const offset = radius * 0.12;
        const triPath = () => {
          ctx.beginPath();
          ctx.moveTo(cx - tri / 2 + offset, cy - tri * 0.62);
          ctx.lineTo(cx - tri / 2 + offset, cy + tri * 0.62);
          ctx.lineTo(cx + tri * 0.7 + offset, cy);
          ctx.closePath();
        };
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 4;
        triPath();
        ctx.stroke();
        ctx.fillStyle = "#000000";
        triPath();
        ctx.fill();
        ctx.fillStyle = color;
        triPath();
        ctx.fill();
      }
      ctx.restore();
      return r0;
    };

    const onMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (e, pos) {
      if (isVueNodes()) return onMouseDown ? onMouseDown.apply(this, arguments) : false;

      const { cx, cy, radius } = layoutFor(this.size[0], this.size[1]);
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
