# Attack emotes (F key)

**Don’t know how to make them?** There aren’t marketplace emotes that do “run→punch” or “walk→punch”; you need to create these in Blender. See **`BLENDER_EMOTES_GUIDE.md`** in this folder for step-by-step instructions and links to the official Decentraland rig.

Place your custom emote GLB files here. The combat system plays:

| File name | When |
|-----------|------|
| `run_punch_emote.glb` | Player presses **F** while **running** (WASD, no Walk key) |
| `walk_punch_emote.glb` | Player presses **F** while **walking** (WASD + Walk e.g. Shift) |
| *(predefined `punch`)* | Player presses **F** while **standing still** |

## Requirements

- File names must end with **`_emote.glb`** (Decentraland requirement for scene emotes).
- Use the **Decentraland avatar rig** so the animation plays correctly on the player.
- **Run punch**: a single animation that transitions smoothly from a run pose into the punch (no pause).
- **Walk punch**: a single animation that transitions from a walk pose into the punch.

If these files are missing, the scene will still run; when F is pressed while running or walking, the trigger will use the scene emote path and may fail silently or show an error until you add the GLBs. Standing punch always uses the built-in `punch` emote.

## Adding the files to the scene

1. Export your run→punch and walk→punch animations as GLB (Decentraland emote format, `_emote.glb`).
2. Put `run_punch_emote.glb` and `walk_punch_emote.glb` in this folder (`assets/emotes/`).
3. If using the Scene Editor / Creator Hub, add these assets to the scene so they are included in the build.
