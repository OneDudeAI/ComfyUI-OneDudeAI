// True when ComfyUI's Nodes 2.0 (Vue) renderer is active.
// Driven by the `Comfy.VueNodes.Enabled` setting -> `LiteGraph.vueNodesMode`.
// Read live (do not cache) so a runtime renderer toggle is respected.
// Same check as ComfyUI-Pixaroma/js/shared/nodes2.mjs:89-91.
export function isVueNodes() {
  return !!window.LiteGraph?.vueNodesMode;
}
