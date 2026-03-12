# Creating run→punch and walk→punch emotes in Blender

There don’t appear to be any **Decentraland marketplace emotes** that are “run into punch” or “walk into punch” — the built-in `punch` is standing-only. So you need to create these two **custom scene emotes** in Blender using the official Decentraland avatar rig.

---

## 1. Get the Decentraland avatar rig

- Go to **Decentraland Creator Docs** → [Emotes](https://docs.decentraland.org/creator/wearables-and-emotes/emotes/) (or search “creating emotes” / “avatar rig” on docs.decentraland.org).
- Download the **official Blender rig** (often named something like **Avatar_File.blend** or **BaseMale_Rig_1.0.blend**). The exact link is in the “Creating and exporting emotes” / “Avatar rig” pages. If the link moves, search **“Decentraland Blender rig download”** or check the **Decentraland Discord** (creator channel) for the current file.

You must use this rig (or an approved variant) so the bone names and structure match the player avatar in Decentraland.

---

## 2. Blender project setup

- **Frame rate:** In **Output Properties** (printer icon), set **Frame Rate to 30 fps** (Decentraland requirement; Blender default is 24).
- **Pose Mode:** All animation is done in **Pose Mode** on the rig (select armature → Tab or switch to Pose Mode). Use the **colored control bones**, not the raw skeleton.
- **Timeline:** Decide length, e.g. 30–45 frames (1–1.5 s) for each emote.

---

## 3. Run → punch emote

**Idea:** Start in a “run” pose, then transition into the punch and hold the hit.

1. **Frame 1:** Pose the rig in a **mid-run** pose (one leg forward, arms in run swing). Insert keyframes (**I** → Location, Rotation, or “Whole Character” depending on rig).
2. **Frames 5–15:** Move to the **punch** pose (e.g. right arm forward, fist out, body slightly rotated). Add keyframes at the end of the transition.
3. **Frames 15–25 (or so):** Hold the punch pose, maybe a tiny settle. Add a keyframe at the end.
4. Use the **Dope Sheet** / **Action Editor** to see the clip; use **Graph Editor** to smooth the transition (e.g. run → punch should feel snappy, not floaty).

Keep the character **within 1 m** of the origin in any direction (Decentraland limit).

---

## 4. Walk → punch emote

Same idea, but start from a **walk** pose (less extreme than run: smaller stride, less arm swing).

1. **Frame 1:** Pose in a **mid-walk** pose.
2. **Frames 5–15:** Transition to the same **punch** pose as above (or a slight variation).
3. **Frames 15–25:** Hold punch.
4. Adjust timing so it feels like “walk step → punch” in one motion.

---

## 5. Export as GLB (scene emote)

- **One animation per file:** Each `.blend` / action = one exported file (e.g. run_punch_emote.glb, walk_punch_emote.glb).
- **Export:** **File → Export → glTF 2.0 (.glb)**.
  - Choose **Format: glTF Binary (.glb)**.
  - Include **Animation** (and only the armature you animated).
  - Export only the **armature** (or the scene that contains it), not extra props, unless the emote docs say otherwise.
- **File names (required):**
  - `run_punch_emote.glb`
  - `walk_punch_emote.glb`  
  Names **must** end with **`_emote.glb`** for Decentraland scene emotes.
- **Limits:** Max length 10 s (300 frames at 30 fps), max 1 MB file size, movement within 1 m of origin.

If the official docs specify a particular export script or “Export for Decentraland” steps, follow those instead of the generic glTF export (they may strip controls and bake to the correct skeleton).

---

## 6. Put the files in the scene

- Save both GLBs into **`assets/emotes/`** in this project.
- Add them to the scene in **Creator Hub** so they’re included in the build (same way you add other scene assets).

---

## If you’ve never animated in Blender

- Learn the basics: **Pose Mode**, **keyframes (I)**, **Timeline**, **Dope Sheet**, **Graph Editor** (Blender manual: “Animation”).
- Use the **Decentraland rig’s control bones** (usually colored); avoid animating the “deforming” bones directly.
- Start with a **short** run→punch (e.g. 20 frames) to test in the scene; then refine timing and add a walk→punch.

---

## Useful links

- **Emotes overview:** https://docs.decentraland.org/creator/wearables-and-emotes/emotes/
- **Avatar rig (bone structure, FK/IK):** https://docs.decentraland.org/creator/wearables-and-emotes/emotes/avatar-rig
- **Creating and exporting emotes:** search “creating and exporting emotes” on docs.decentraland.org for the current page (exact URL may change).
- **Rig features (controls, bone sets):** https://docs.decentraland.org/creator/wearables-and-emotes/emotes/rig-features

Once `run_punch_emote.glb` and `walk_punch_emote.glb` are in `assets/emotes/` and added to the scene, pressing **F** while running or walking in your Flag Tag scene will play the corresponding emote.
