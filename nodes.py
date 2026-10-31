class OneDudeAI_GroupPlay:
    """JS-only trigger node. Never wired, never executed — see js/group_play/index.js."""

    CATEGORY = "OneDudeAI"
    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "OneDudeAI_GroupPlay": OneDudeAI_GroupPlay,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OneDudeAI_GroupPlay": "Group Play",
}
