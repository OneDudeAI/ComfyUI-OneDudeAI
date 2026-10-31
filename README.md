# ComfyUI-OneDudeAI

## Group Play

Drop it inside a group — a native ComfyUI group or one of Pixaroma's own
pixgroup frames — and resize it as big as you need so it stays readable
when zoomed way out. Its color comes from the node's own right-click color
(the standard picker, same as every other Pixaroma node), not the group.

- **Idle**: a play circle. Click it to queue only that group's output nodes
  (same partial-run call ComfyUI-Pixaroma's pixgroup module uses).
- **No output node in the group**: a warning toast instead of running —
  put a Save/Preview node in the group first.
- **Running**: the circle becomes a progress ring showing the *current
  node's* step progress, with a cancel "X" in the center, plus a vertical
  bar + percentage showing the *whole run's* progress (nodes finished so
  far out of the run's total, from ComfyUI's own `progress_state` event —
  an approximation early in a run that becomes exact once every node has
  started at least once). The X calls ComfyUI's one global interrupt — it
  stops whatever is currently executing, not provably just this group
  (ComfyUI has no per-group cancel). Fine for single-job use.
- Every shape has a black contrast halo, so it stays visible even if you
  pick a flat "solid color" that sets the node's title and body to the
  same hex.

Works in both renderers, and rebuilds live if you flip ComfyUI's
"Modern Node Design (Nodes 2.0)" setting mid-session (no page reload
needed) — same renderer-switch handling Pixaroma's own nodes use. Classic
paints the circle on the node's own canvas; Nodes 2.0 gets an inline-SVG
DOM widget instead, since that renderer never calls `onDrawForeground`.
