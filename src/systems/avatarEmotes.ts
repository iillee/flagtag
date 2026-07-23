/**
 * Avatar Emotes — upper-body masked scene emotes for throw/drop feedback.
 *
 * Uses `triggerSceneEmote` with `mask: 0` (AM_UPPER_BODY) so the player can
 * keep running/moving while the throw animation plays on the upper body only.
 *
 * Slice 1 of the avatar-masking feature: helper only, no wiring yet.
 * Follow-up slices will call playThrowEmote(...) from the banana/boomerang/bomb
 * throw code paths.
 */

import { triggerSceneEmote, stopEmote } from '~system/RestrictedActions'

// Upper-body mask constant. The scene-emote `mask` field is a bitmask where
// 0 means "no lower-body override" → upper body plays, legs keep locomotion.
const AM_UPPER_BODY = 0

const EMOTE_DIR = 'models/emotes'

export type ThrowEmoteKind =
  | 'drop'              // generic drop / banana throw
  | 'boomerangThrow'    // single-hand boomerang throw (red/green)
  | 'boomerangThrow2'   // dual-wield boomerang throw (yellow)
  | 'boomerangStart'    // blue charge — windup start
  | 'boomerangLoop'     // blue charge — hold loop
  | 'boomerangEnd'      // blue charge — release

const EMOTE_SRC: Record<ThrowEmoteKind, string> = {
  drop:            `${EMOTE_DIR}/drop_emote.glb`,
  boomerangThrow:  `${EMOTE_DIR}/ThrowBoomerang_emote.glb`,
  boomerangThrow2: `${EMOTE_DIR}/ThrowBoomerang2_emote.glb`,
  boomerangStart:  `${EMOTE_DIR}/ThrowBoomerangStart_emote.glb`,
  boomerangLoop:   `${EMOTE_DIR}/ThrowBoomerangLoop_emote.glb`,
  boomerangEnd:    `${EMOTE_DIR}/ThrowBoomerangEnd_emote.glb`,
}

/**
 * Play a scene emote on the local player's upper body.
 * Fire-and-forget; safe to call from sync code. Errors are swallowed.
 */
export function playThrowEmote(kind: ThrowEmoteKind, loop = false): void {
  const src = EMOTE_SRC[kind]
  void triggerSceneEmote({ src, loop, mask: AM_UPPER_BODY }).catch((e) => {
    console.error('[avatarEmotes] triggerSceneEmote failed', kind, e)
  })
}

/** Stop the currently playing scene emote (e.g. cancel the blue Loop). */
export function stopThrowEmote(): void {
  void stopEmote({}).catch(() => {})
}
