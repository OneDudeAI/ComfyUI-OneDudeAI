# ComfyUI-OneDudeAI

## Group Play

Drop it inside a group, resize it as big as you need so it stays readable
when zoomed way out. It picks up the group's own color (set that with
Pixaroma's "Group Colors" right-click dialogue — this node just reads it
live, no color picker of its own).

- **Idle**: a play circle. Click it to queue only that group's output nodes
  (same partial-run call ComfyUI-Pixaroma's pixgroup module uses).
- **No output node in the group**: a warning toast instead of running —
  put a Save/Preview node in the group first.
- **Running**: the circle becomes a progress ring with a cancel "X" in the
  center. The X calls ComfyUI's one global interrupt — it stops whatever is
  currently executing, not provably just this group (ComfyUI has no
  per-group cancel). Fine for single-job use.

v1 is canvas-renderer only (matches the live install's
`Comfy.VueNodes.Enabled = False`); it won't draw its face in the Vue
"Nodes 2.0" renderer yet.
