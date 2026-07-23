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

/**
 * Convenience: play the correct single-hand/dual-wield throw for a boomerang color.
 * - 'r' | 'g': single-hand ThrowBoomerang
 * - 'y'      : dual-wield ThrowBoomerang2
 * - 'b'      : (charge sequence — handled separately in slice 4)
 */
export function playBoomerangThrowEmote(color: 'r' | 'g' | 'y' | 'b'): void {
  if (color === 'y') playThrowEmote('boomerangThrow2')
  else if (color === 'r' || color === 'g') playThrowEmote('boomerangThrow')
  // 'b' intentionally omitted — blue uses Start/Loop/End sequence.
}

/** Stop the currently playing scene emote (e.g. cancel the blue Loop). */
export function stopThrowEmote(): void {
  stopTimer = -1
  void stopEmote({}).catch(() => {})
}

// ─────────────────────────────────────────────────────────────────────────
// Blue boomerang charge sequence (Start → Loop → End)
// ─────────────────────────────────────────────────────────────────────────
//
// Quick taps (release under BLUE_TAP_WINDOW_SEC) play no charge emote at all
// — the throw feels snappier and we avoid a visible Start→End jitter.
//
// Held charges fire:
//   t=0                    beginBoomerangCharge()  → schedule Start
//   t=BLUE_TAP_WINDOW_SEC  fire Start emote        → schedule Loop
//   t=+BLUE_START_SEC      fire Loop emote (loop:true)
//   release                releaseBoomerangCharge() → stopEmote, fire End
//                                                    (auto-stop BLUE_END_SEC)
const BLUE_TAP_WINDOW_SEC = 0.18  // release under this = no charge emote
const BLUE_START_SEC      = 0.15  // Start clip duration before Loop takes over
const BLUE_END_SEC        = 0.40  // End clip auto-stop (matches mask test scene)

let blueTapWindowTimer = -1   // ticks down until Start fires
let blueStartTimer     = -1   // ticks down until Loop takes over
let blueLoopActive     = false
let blueStartFired     = false // whether we've entered the Start/Loop phase

// Register the blue-charge tick system exactly once (independent of stop-system).
let blueSystemRegistered = false
function registerBlueSystem(): void {
  if (blueSystemRegistered) return
  blueSystemRegistered = true
  engine.addSystem((dt: number) => {
    // Phase 1: tap window elapsed → fire Start emote.
    if (blueTapWindowTimer > 0) {
      blueTapWindowTimer -= dt
      if (blueTapWindowTimer <= 0) {
        blueTapWindowTimer = -1
        blueStartFired = true
        void triggerSceneEmote({
          src: EMOTE_SRC.boomerangStart, loop: false, mask: AM_UPPER_BODY
        }).catch(() => {})
        blueStartTimer = BLUE_START_SEC
      }
    }
    // Phase 2: Start clip finished → transition into looping Hold emote.
    if (blueStartTimer > 0) {
      blueStartTimer -= dt
      if (blueStartTimer <= 0) {
        blueStartTimer = -1
        if (!blueLoopActive) {
          blueLoopActive = true
          void triggerSceneEmote({
            src: EMOTE_SRC.boomerangLoop, loop: true, mask: AM_UPPER_BODY
          }).catch(() => {})
        }
      }
    }
  })
}

/** Call when the blue charge begins (E-key down / UI press-in). */
export function beginBoomerangCharge(): void {
  registerBlueSystem()
  blueTapWindowTimer = BLUE_TAP_WINDOW_SEC
  blueStartTimer     = -1
  blueLoopActive     = false
  blueStartFired     = false
}

/**
 * Call when the blue charge is released normally (E-key up / UI release).
 * - Quick taps (under BLUE_TAP_WINDOW_SEC): play the single-hand throw emote.
 * - Held charges: cut Loop and play End (auto-stop after BLUE_END_SEC).
 */
export function releaseBoomerangCharge(): void {
  const wasQuickTap = !blueStartFired
  blueTapWindowTimer = -1
  blueStartTimer     = -1
  blueLoopActive     = false
  blueStartFired     = false
  if (wasQuickTap) {
    // No charge emote played — fall back to the regular single-hand throw
    // so a snap-tap still gets visible feedback.
    playThrowEmote('boomerangThrow')
    return
  }
  // Play End — triggerSceneEmote replaces the currently-playing Loop.
  // (Matches mask test scene: no explicit stopEmote before End.)
  playThrowEmote('boomerangEnd', false, BLUE_END_SEC)
}

/** Call to abort the charge sequence without playing End (burnout, cinematic, spectator). */
export function cancelBoomerangCharge(): void {
  const hadEmote = blueStartFired
  blueTapWindowTimer = -1
  blueStartTimer     = -1
  blueLoopActive     = false
  blueStartFired     = false
  if (hadEmote) void stopEmote({}).catch(() => {})
}
