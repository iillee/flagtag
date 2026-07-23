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
import { engine } from '@dcl/sdk/ecs'

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

// Default auto-stop duration for one-shot throw emotes. The baked clips
// contain multiple repetitions; we cut them after ~one iteration so the
// avatar returns to idle instead of looping the throw pose.
const DEFAULT_STOP_SEC = 0.65

// Countdown until we should call stopEmote() for the current one-shot.
// -1 = idle. Ticked by an engine system registered lazily on first use.
let stopTimer = -1
let systemRegistered = false

function ensureStopSystem(): void {
  if (systemRegistered) return
  systemRegistered = true
  engine.addSystem((dt: number) => {
    if (stopTimer <= 0) return
    stopTimer -= dt
    if (stopTimer <= 0) {
      stopTimer = -1
      void stopEmote({}).catch(() => {})
    }
  })
}

/**
 * Play a scene emote on the local player's upper body.
 * Fire-and-forget; safe to call from sync code. Errors are swallowed.
 *
 * One-shot emotes are auto-stopped after `stopAfterSec` (default 0.65s) to
 * prevent the baked clip from repeating. Pass `loop: true` to disable auto-stop
 * (caller is responsible for calling stopThrowEmote()).
 */
export function playThrowEmote(
  kind: ThrowEmoteKind,
  loop = false,
  stopAfterSec: number = DEFAULT_STOP_SEC
): void {
  const src = EMOTE_SRC[kind]
  void triggerSceneEmote({ src, loop, mask: AM_UPPER_BODY }).catch((e) => {
    console.error('[avatarEmotes] triggerSceneEmote failed', kind, e)
  })
  if (!loop && stopAfterSec > 0) {
    ensureStopSystem()
    stopTimer = stopAfterSec
  } else {
    // Looping emote or explicit no-auto-stop: cancel any pending auto-stop.
    stopTimer = -1
  }
}

/** Stop the currently playing scene emote (e.g. cancel the blue Loop). */
export function stopThrowEmote(): void {
  stopTimer = -1
  void stopEmote({}).catch(() => {})
}
