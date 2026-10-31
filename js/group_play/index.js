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

// Circle + optional vertical progress bar, both kept fully inside (w, h),
// and both scaled to the node's own size — everything below was a fixed
// pixel count regardless of how big the node was resized, so the bar/text
// stayed small on a large node (reported 2026-10-31). BASE_SIZE is the
// node's own default size (DEFAULT_SIZE); every dimension below scales
// off it, so a 2x bigger node gets a 2x bigger bar and 2x bigger text.
const BASE_SIZE = 150;
const BAR_AREA_BASE = 96; // width reserved on the right for both bars + labels
const BAR_W_BASE = 14;
const BAR_GAP_BASE = 10;
const MARGIN_BASE = 18;
const MIN_SHOW_BAR_W = 110; // below this absolute width, hide the bars — no room even scaled down

// Two vertical bars: "S" = the sampler (or whichever node the ring is
// currently on) — its own total progress, high-water smoothed so a restart
// between passes doesn't saw backward. "V" = VAE encode/decode — detected
// generically by INPUT TYPE ("VAE" on a node's own input slot, not any
// class name — works for any pack's VAEDecode/VAEEncode/tiled/audio
// variant), not shown filled until one actually runs (user, 2026-10-31:
// "initialized after the sampler or when a decode or encode is happening").
function layoutFor(w, h) {
  // A fixed margin wasn't enough once the node was resized into a wide
  // rectangle: a radius of min(w,h)/2 leaves the ring tangent to the
  // shorter edge with zero clearance, so any rounding or the node's own
  // border overflows it. MARGIN is subtracted from the SHORTER edge
  // specifically to guarantee real clearance on every side.
  const scale = Math.max(0.4, Math.min(w, h) / BASE_SIZE);
  const MARGIN = MARGIN_BASE * scale;
  const BAR_AREA = BAR_AREA_BASE * scale;
  const BAR_W = BAR_W_BASE * scale;
  const BAR_GAP = BAR_GAP_BASE * scale;

  const showBar = w >= MIN_SHOW_BAR_W;
  const circleAreaW = showBar ? Math.max(10, w - BAR_AREA) : w;
  const cx = circleAreaW / 2;
  const cy = h / 2;
  const radius = Math.max(10, Math.min(circleAreaW, h) / 2 - MARGIN);

  let bar1 = null;
  let bar2 = null;
  if (showBar) {
    const top = MARGIN;
    const bottom = h - MARGIN - 28 * scale; // room for the % line + letter line below each bar
    const barH = Math.max(0, bottom - top);
    const pctY = h - MARGIN - 12 * scale;
    const letterY = h - MARGIN + 2 * scale;
    const totalBarsW = BAR_W * 2 + BAR_GAP;
    const startX = circleAreaW + (BAR_AREA - totalBarsW) / 2;
    bar1 = { x: startX, w: BAR_W, top, bottom, h: barH, pctY, letterY, letter: "S" };
    bar2 = { x: startX + BAR_W + BAR_GAP, w: BAR_W, top, bottom, h: barH, pctY, letterY, letter: "V" };
  }
  return { cx, cy, radius, bar1, bar2, scale };
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

// Generic VAE detection: a node with a "VAE"-typed input slot — the type
// system, not a class-name list, so it matches VAEDecode, VAEEncode, a
// tiled or audio/video variant, or any future pack's VAE-consuming node
// without naming any of them (corrected 2026-10-31 after hardcoding
// PixaromaPromptEach once already — see [[no-hardwired-node-types-in-tools]]).
function isVaeNode(n) {
  return !!(n && Array.isArray(n.inputs) && n.inputs.some((inp) => inp && inp.type === "VAE"));
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
  node._odai_nodeStates = null;
  node._odai_currentNodeId = null;
  node._odai_vaeNodeId = null;
  node._odai_totalNodes = 0;
  node._odai_executedCount = 0;
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
    else if (_owner) {
      const id = String(runningId);
      // "S" bar total: the exact algorithm rgthree-comfy's own progress bar
      // uses (prompt_service.ts / progress_bar.ts, read in full, confirmed
      // 2026-10-31: percent = executedNodeIds.length / totalNodes * 100,
      // where executedNodeIds grows by one each time "executing" reports a
      // DIFFERENT node than before). No per-node-type logic, no multi-pass
      // math — a node that cycles internally (KSampler across list passes)
      // never changes id, so it doesn't inflate the count either.
      if (_owner._odai_currentNodeId != null && _owner._odai_currentNodeId !== id) {
        _owner._odai_executedCount = (_owner._odai_executedCount || 0) + 1;
      }
      _owner._odai_currentNodeId = id;
      repaint(_owner);
    }
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
  // "pending" nodes are omitted until they start seen is an approximation
  // that only gets more accurate as the run proceeds and is exact once
  // every node that will run has started at least once.
  //
  // Each node's own {value,max} is kept (not just finished/not): a plain
  // finished-count/seen-count ratio freezes solid for the whole time a slow
  // node (KSampler, 14 steps) is "running" but not yet "finished" — measured
  // 2026-10-31, bar stuck at the same % through an entire sample run. Blending
  // each running node's own fraction in makes it creep forward continuously,
  // matching what "overall progress" actually looks like to someone watching.
  api.addEventListener("progress_state", (e) => {
    if (!_owner) return;
    const d = (e && e.detail) || {};
    const nodes = d.nodes || {};
    const states = _owner._odai_nodeStates || (_owner._odai_nodeStates = new Map());
    for (const [id, st] of Object.entries(nodes)) {
      if (!st) continue;
      const prev = states.get(id);
      const value = Number(st.value) || 0;
      // A generic restart counter for a list-expanded batch (a 20-line text
      // box, PixaromaPromptEach, anything — the SAME node id re-executes,
      // confirmed live, no id suffix per pass). Originally watched for
      // finished→running, which never fires: watched LIVE through a real
      // 5-pass run (2026-10-31) and KSampler's own state stayed "running"
      // the entire time while its value cycled 14→1 five times — ComfyUI
      // doesn't mark it "finished" between passes, only when the whole node
      // is truly done. The real, confirmed signal is value DROPPING while
      // still "running": that's a fresh pass starting over.
      let runCount = prev?.runCount || 0;
      if (st.state === "running" && prev?.state === "running" && value < prev.value) runCount += 1;
      else if (st.state === "running" && prev?.state !== "running") runCount += 1;
      states.set(id, { value, max: Number(st.max) || 0, state: st.state, runCount });

      // Second bar ("V"): whichever node currently running has a VAE-typed
      // input, generically detected — not the id the ring/first bar already
      // tracks. Only updated while one is actually running, so it keeps
      // showing its last real reading once that node finishes rather than
      // blanking immediately.
      if (st.state === "running" && id !== _owner._odai_currentNodeId) {
        const liveNode = app.graph.getNodeById(id);
        if (isVaeNode(liveNode)) _owner._odai_vaeNodeId = id;
      }
    }
    repaint(_owner);
  });
  api.addEventListener("execution_success", finishOwner);
  api.addEventListener("execution_error", finishOwner);
  api.addEventListener("execution_interrupted", finishOwner);
}

async function queueGroup(node) {
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
  node._odai_nodeStates = new Map();
  node._odai_currentNodeId = null;
  node._odai_vaeNodeId = null;
  node._odai_totalNodes = 0;
  node._odai_executedCount = 0;
  _owner = node;
  repaint(node);

  try {
    // Same resolved-prompt node count rgthree's own "Total" reads (see the
    // "executing" listener above) — totalNodes from the FULL resolved
    // prompt, not scoped to just this group's ids, matching their algorithm
    // exactly rather than inventing a narrower variant of it.
    const resolved = await app.graphToPrompt();
    node._odai_totalNodes = Object.keys(resolved?.output || {}).length;
  } catch (e) {
    console.error("[OneDudeAI GroupPlay] could not resolve total node count", e);
  }

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

// Ring = current node's own step fraction (the "progress" event, identical
// to what KSampler itself reports). Bar used to average every touched node
// together, but most of a chain (loaders, text nodes) runs once and sits at
// 100% forever while only the sampler cycles — measured live, 2026-10-31.
// The "S" bar now uses rgthree-comfy's own, proven algorithm instead (their
// progress_bar.ts, read in full): percent = distinct nodes the run has
// moved past / total nodes in the resolved prompt (app.graphToPrompt(),
// called once at queue time — see queueGroup). Fully generic: no node-type
// check, no assumed pass count, nothing invented — the exact metric their
// native-looking "Total: X%" readout already shows.
function fractionsFor(node) {
  const p = node._odai_progress || { value: 0, max: 0 };
  const ringFrac = p.max > 0 ? Math.max(0, Math.min(1, p.value / p.max)) : 0;

  const states = node._odai_nodeStates;
  const curId = node._odai_currentNodeId;
  const curState = curId && states ? states.get(curId) : null;

  // "Image N" — generic repeat count of whichever node is currently running.
  let imageLabel = null;
  if (curState && curState.runCount > 1) imageLabel = `Image ${curState.runCount}`;

  const total = node._odai_totalNodes || 0;
  const executed = node._odai_executedCount || 0;
  const barFrac = total > 0 ? Math.max(0, Math.min(1, executed / total)) : 0;

  // Second bar: VAE encode/decode, generic (see isVaeNode / the
  // progress_state handler). vaeActive stays false until one has actually
  // run at least once this session — stays dim/empty until then.
  const vaeId = node._odai_vaeNodeId;
  const vaeState = vaeId && states ? states.get(vaeId) : null;
  const vaeActive = !!vaeState;
  const vaeFrac = vaeState
    ? vaeState.max > 0
      ? Math.max(0, Math.min(1, vaeState.value / vaeState.max))
      : vaeState.state === "finished" || vaeState.state === "error"
        ? 1
        : 0.5 // running with no step count (max<=0) — a non-progress "active" pulse
    : 0;

  return { ringFrac, barFrac, vaeFrac, vaeActive, imageLabel };
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
// Bar is drawn in BOTH states — idle shows an empty 0% track so it reads
// as a readout that's "there, at rest", not something that only appears
// mid-job.
function svgFace(color, state, ringFrac, barFrac, vaeFrac, vaeActive, imageLabel) {
  const rf = Math.max(0, Math.min(1, ringFrac));
  const bf = Math.max(0, Math.min(1, barFrac));
  const vf = Math.max(0, Math.min(1, vaeFrac));
  const circumference = 2 * Math.PI * 40;
  const dash = circumference * rf;
  const barTop = 10, barBottom = 70, barH = barBottom - barTop;
  const fillTop = barBottom - barH * bf;
  const vaeFillTop = barBottom - barH * vf;
  const pct = Math.round(bf * 100);
  const vaePct = vaeActive ? Math.round(vf * 100) + "%" : "—";

  const ringMarkup =
    state === "running"
      ? `<circle cx="48" cy="50" r="40" fill="none" stroke="#000000" stroke-width="11"/>
         <circle cx="48" cy="50" r="40" fill="none" stroke="${color}${ALPHA_SUFFIX}" stroke-width="8"/>
         <circle cx="48" cy="50" r="40" fill="none" stroke="${color}" stroke-width="8"
           stroke-dasharray="${dash} ${circumference}" stroke-linecap="round"
           transform="rotate(-90 48 50)"/>
         <line x1="35" y1="37" x2="61" y2="63" stroke="#000000" stroke-width="10" stroke-linecap="round"/>
         <line x1="61" y1="37" x2="35" y2="63" stroke="#000000" stroke-width="10" stroke-linecap="round"/>
         <line x1="35" y1="37" x2="61" y2="63" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
         <line x1="61" y1="37" x2="35" y2="63" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>`
      : `<circle cx="48" cy="50" r="40" fill="none" stroke="#000000" stroke-width="11"/>
         <circle cx="48" cy="50" r="40" fill="none" stroke="${color}" stroke-width="8"/>
         <path d="M 36 28 L 36 72 L 72 50 Z" fill="#000000" stroke="#000000" stroke-width="4" stroke-linejoin="round"/>
         <path d="M 36 28 L 36 72 L 72 50 Z" fill="${color}"/>`;

  const imageMarkup = imageLabel
    ? `<text x="48" y="74" text-anchor="middle" font-size="9" fill="#000000" font-family="sans-serif" stroke="#000000" stroke-width="3" paint-order="stroke">${imageLabel}</text>
       <text x="48" y="74" text-anchor="middle" font-size="9" fill="#ffffff" font-family="sans-serif">${imageLabel}</text>`
    : "";

  // Two bars: "S" (sampler, always live) and "V" (VAE encode/decode,
  // generic — see isVaeNode — only filled once one has actually run).
  return `<svg viewBox="0 0 160 100" width="100%" height="100%" style="display:block">
    ${ringMarkup}
    <rect x="117" y="${barTop - 1}" width="14" height="${barH + 2}" rx="6" fill="#000000"/>
    <rect x="118" y="${barTop}" width="12" height="${barH}" rx="5" fill="${color}${ALPHA_SUFFIX}"/>
    <rect x="118" y="${fillTop}" width="12" height="${barH * bf}" rx="5" fill="${color}"/>
    <text x="124" y="80" text-anchor="middle" font-size="11" fill="#000000" font-family="sans-serif" stroke="#000000" stroke-width="3" paint-order="stroke">${pct}%</text>
    <text x="124" y="80" text-anchor="middle" font-size="11" fill="#ffffff" font-family="sans-serif">${pct}%</text>
    <text x="124" y="92" text-anchor="middle" font-size="8" fill="${color}" font-family="sans-serif" stroke="#000000" stroke-width="2" paint-order="stroke">S</text>

    <rect x="139" y="${barTop - 1}" width="14" height="${barH + 2}" rx="6" fill="#000000"/>
    <rect x="140" y="${barTop}" width="12" height="${barH}" rx="5" fill="${color}${ALPHA_SUFFIX}"/>
    ${vaeActive ? `<rect x="140" y="${vaeFillTop}" width="12" height="${barH * vf}" rx="5" fill="${color}"/>` : ""}
    <text x="146" y="80" text-anchor="middle" font-size="11" fill="#000000" font-family="sans-serif" stroke="#000000" stroke-width="3" paint-order="stroke">${vaePct}</text>
    <text x="146" y="80" text-anchor="middle" font-size="11" fill="#ffffff" font-family="sans-serif">${vaePct}</text>
    <text x="146" y="92" text-anchor="middle" font-size="8" fill="${color}" font-family="sans-serif" stroke="#000000" stroke-width="2" paint-order="stroke">V</text>
    ${imageMarkup}
  </svg>`;
}

function renderVueFace(node) {
  if (!node._odaiRoot) return;
  const color = nodeColorFor(node);
  const state = node._odai_state || "idle";
  const { ringFrac, barFrac, vaeFrac, vaeActive, imageLabel } = fractionsFor(node);
  node._odaiRoot.innerHTML = svgFace(color, state, ringFrac, barFrac, vaeFrac, vaeActive, imageLabel);
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
      this._odai_nodeStates = null;
      this._odai_currentNodeId = null;
      this._odai_vaeNodeId = null;
      this._odai_totalNodes = 0;
      this._odai_executedCount = 0;
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

      const { cx, cy, radius, bar1, bar2, scale } = layoutFor(this.size[0], this.size[1]);
      const color = nodeColorFor(this);
      const state = this._odai_state || "idle";

      // Every stroke/fill below is drawn twice: a black halo first, the
      // accent color on top. A "solid color" node-color pick can set title
      // and body to the SAME hex, which would make an accent-colored shape
      // disappear into an identically-colored body (reported 2026-10-31) —
      // the halo guarantees contrast regardless of what color is picked.
      ctx.save();
      const { ringFrac, barFrac, vaeFrac, vaeActive, imageLabel } = fractionsFor(this);

      if (imageLabel) {
        // Inside the circle, not below it — a fixed outer margin already
        // sets the ring's radius to just clear the node's edge (the overflow
        // this fixed, 2026-10-31), so there's no room outside it to add to.
        ctx.font = `${Math.max(9, Math.round(radius * 0.17))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.lineWidth = Math.max(2, 3 * scale);
        ctx.strokeStyle = "#000000";
        ctx.strokeText(imageLabel, cx, cy + radius * 0.6);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(imageLabel, cx, cy + radius * 0.6);
      }

      // Two bars, drawn in BOTH states — idle shows empty tracks, not just
      // the running one, so they read as a readout that's "there, at rest"
      // rather than something that only appears mid-job. "S" (sampler) is
      // always live; "V" (VAE) only fills/shows a % once one has actually
      // run this session — otherwise it's just a dim empty track + letter.
      const drawBar = (b, frac, active, fillLabel) => {
        if (!b) return;
        ctx.lineCap = "butt";
        ctx.fillStyle = "#000000";
        ctx.fillRect(b.x - 2, b.top - 2, b.w + 4, b.h + 4);

        ctx.fillStyle = color + ALPHA_SUFFIX;
        ctx.fillRect(b.x, b.top, b.w, b.h);
        if (active) {
          const filledH = b.h * frac;
          ctx.fillStyle = color;
          ctx.fillRect(b.x, b.bottom - filledH, b.w, filledH);
        }

        const pctFont = Math.max(8, Math.round(11 * scale));
        const letterFont = Math.max(7, Math.round(9 * scale));
        const lw = Math.max(2, 2.5 * scale);
        ctx.textAlign = "center";

        const pctLabel = active ? Math.round(frac * 100) + "%" : fillLabel || "—";
        ctx.font = `${pctFont}px sans-serif`;
        ctx.lineWidth = lw;
        ctx.strokeStyle = "#000000";
        ctx.strokeText(pctLabel, b.x + b.w / 2, b.pctY);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(pctLabel, b.x + b.w / 2, b.pctY);

        ctx.font = `${letterFont}px sans-serif`;
        ctx.strokeStyle = "#000000";
        ctx.strokeText(b.letter, b.x + b.w / 2, b.letterY);
        ctx.fillStyle = color;
        ctx.fillText(b.letter, b.x + b.w / 2, b.letterY);
      };
      drawBar(bar1, barFrac, true);
      drawBar(bar2, vaeFrac, vaeActive);

      if (state === "running") {
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
