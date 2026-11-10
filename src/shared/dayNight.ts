/**
 * dayNight.ts - fixed day/night cycle locked to the round timer.
 *
 * One round = one phase. Rounds are ROUND_LENGTH_MINUTES long and aligned to
 * UTC (same math as getNextRoundEndTimeMs / getCountdownSeconds in dateUtils),
 * so the round index is floor(utcMs / ROUND_MS):
 *   even index -> DAY, odd index -> NIGHT   (10-minute full cycle)
 *
 * Gameplay flips exactly on the round boundary. The visible sky keeps moving
 * forward through one continuous 24 h arc so it never jumps:
 *   DAY round   : 07:30 -> 16:30 (sun up), last BLEND_SEC: 16:30 -> 19:30 (dusk)
 *   NIGHT round : 19:30 -> 04:30 (dark),   last BLEND_SEC: 04:30 -> 07:30 (dawn)
 * Dusk/dawn therefore play in the final seconds of the outgoing round and
 * finish exactly on the boundary.
 *
 * Pure functions only (no engine access) - safe on server, client and in Jest.
 * Both sides use Date.now(); there is no client/server clock offset anywhere
 * in this scene (the round countdown UI uses Date.now() too).
 */
import { ROUND_LENGTH_MINUTES } from './constants'

export const ROUND_MS = ROUND_LENGTH_MINUTES * 60 * 1000
/** Seconds of dusk/dawn sky blend at the end of each round. */
export const DAY_NIGHT_BLEND_SEC = 10

export const SKYBOX_DAY_SEC = 86400
const SKY_DAY_START = 7.5 * 3600    // 07:30
const SKY_DAY_END = 16.5 * 3600     // 16:30
const SKY_NIGHT_START = 19.5 * 3600 // 19:30
const SKY_NIGHT_END = 4.5 * 3600    // 04:30

export type DayPhase = 'day' | 'night'

/**
 * HALLOWEEN MODE - flip to false after Halloween to restore the day/night cycle.
 * While on: every round is NIGHT for gameplay (ghosts always on, lights always
 * activatable, Blips Piano default), and the sky ping-pongs across the
 * whole night: forward SUNSET -> midnight -> PRE_SUNRISE, then backward
 * through the night to SUNSET, and repeat. Never shows daytime.
 * Math runs in an unwrapped seconds domain (e.g. 18:30 .. 29:45) and is
 * wrapped mod 24 h only at the end. Cosine easing over the full period, so
 * dusk and pre-dawn linger at the turnarounds.
 * The ping-pong is CLIENT-LOCAL: anchored to the client's join time (the
 * anchorMs passed in, = when the skybox system starts), so every player
 * starts at SUNSET moving forward. Purely visual - no gameplay reads sky time.
 * Period = 2 rounds of real time (5 min forward, 5 min back), but not aligned
 * to the UTC round boundaries. Normal mode ignores the anchor (UTC-aligned).
 * Hours: 19:30 / 04:30 = the normal-mode night range (SKY_NIGHT_START/END),
 * which reads properly dusky/dark; 18:30 / 05:45 showed too much daylight.
 */
export const HALLOWEEN_MODE = true
export const HALLOWEEN_SKY_SUNSET = 19.5 * 3600       // 19:30
export const HALLOWEEN_SKY_PRE_SUNRISE = 4.5 * 3600   // 04:30
export const HALLOWEEN_SKY_PERIOD_MS = 2 * ROUND_MS   // forward + back = 10 min

let halloweenMode = HALLOWEEN_MODE
/** Test hook only - production code reads the HALLOWEEN_MODE constant. */
export function setHalloweenModeForTests(on: boolean): void { halloweenMode = on }
export function isHalloweenMode(): boolean { return halloweenMode }

/** Unwrapped end of the sweep (crosses midnight when PRE_SUNRISE < SUNSET). */
const HALLOWEEN_SKY_END_UNWRAPPED =
  HALLOWEEN_SKY_PRE_SUNRISE < HALLOWEEN_SKY_SUNSET ? HALLOWEEN_SKY_PRE_SUNRISE + 86400 : HALLOWEEN_SKY_PRE_SUNRISE

/** Ping-pong phase 0..1 within the period (0 = SUNSET, 0.5 = PRE_SUNRISE). */
function halloweenPhase(utcMs: number, anchorMs: number): number {
  const p = (utcMs - anchorMs) % HALLOWEEN_SKY_PERIOD_MS
  return (p < 0 ? p + HALLOWEEN_SKY_PERIOD_MS : p) / HALLOWEEN_SKY_PERIOD_MS
}

/** Unwrapped sky seconds (SUNSET .. SUNSET+span); exported for tests. */
export function halloweenSkyUnwrappedAt(utcMs: number, anchorMs = 0): number {
  const w = (1 - Math.cos(2 * Math.PI * halloweenPhase(utcMs, anchorMs))) / 2 // 0 at SUNSET, 1 at PRE_SUNRISE
  return HALLOWEEN_SKY_SUNSET + (HALLOWEEN_SKY_END_UNWRAPPED - HALLOWEEN_SKY_SUNSET) * w
}

/**
 * True while the sky clock runs backward (pre-sunrise -> sunset), so the
 * renderer uses TM_BACKWARD and rewinds through the night instead of spinning
 * forward through the day. Normal mode: always forward.
 */
/**
 * Transition direction for one SkyboxTime write, from the value actually
 * written last time (wrap-aware shortest path), not from the clock phase.
 * Any non-zero step sets the direction to match it exactly; a zero step keeps
 * the previous one. Every write is therefore a short step in the declared
 * direction, so the renderer never takes the ~24 h long way round. (A
 * hysteresis band would be unsafe: a 1 s reversed step declared in the old
 * direction IS the long way round.)
 */
export function skyStepIsBackward(prevSec: number, nextSec: number, prevBackward: boolean): boolean {
  const day = SKYBOX_DAY_SEC
  const delta = ((nextSec - prevSec + day * 1.5) % day) - day / 2 // -12h..+12h
  if (delta === 0) return prevBackward
  return delta < 0
}

export function isSkyMovingBackwardAt(utcMs: number, anchorMs = 0): boolean {
  if (!halloweenMode) return false
  return halloweenPhase(utcMs, anchorMs) >= 0.5
}

/**
 * Scene-light window, in exact round-relative seconds (no sky-time rounding):
 * lights may turn on LIGHTS_ON_SECONDS_BEFORE_NIGHT before a day round ends
 * (285 s into the day round), stay on for the whole night round, and turn off
 * LIGHTS_OFF_SECONDS_AFTER_DAWN into the next day round.
 */
export const LIGHTS_ON_SECONDS_BEFORE_NIGHT = 15
export const LIGHTS_OFF_SECONDS_AFTER_DAWN = 15

/** UTC-aligned round index for a timestamp (same boundaries as the round timer). */
export function getRoundIndex(utcMs: number): number {
  return Math.floor(utcMs / ROUND_MS)
}

export function getDayPhaseAt(utcMs: number): DayPhase {
  if (halloweenMode) return 'night'
  return getRoundIndex(utcMs) % 2 === 0 ? 'day' : 'night'
}

export function isNightAt(utcMs: number): boolean {
  return getDayPhaseAt(utcMs) === 'night'
}

export function isNightTime(): boolean {
  return isNightAt(Date.now())
}

/** Ms timestamp of the next phase change (= next round boundary). */
export function getNextPhaseChangeMs(utcMs: number): number {
  return (getRoundIndex(utcMs) + 1) * ROUND_MS
}

function lerpForward(from: number, to: number, t: number): number {
  let delta = to - from
  if (delta < 0) delta += SKYBOX_DAY_SEC
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return (from + delta * c) % SKYBOX_DAY_SEC
}

/** Skybox time-of-day (0..86400 s) to show at `utcMs`. */
/**
 * Skybox time-of-day at utcMs. halloweenAnchorMs = the client's join time
 * (Halloween ping-pong t=0 = sunset, forward); ignored in normal mode.
 */
export function getSkyboxSecondsAt(utcMs: number, halloweenAnchorMs = 0): number {
  if (halloweenMode) return halloweenSkyUnwrappedAt(utcMs, halloweenAnchorMs) % SKYBOX_DAY_SEC
  const night = isNightAt(utcMs)
  const elapsedSec = (utcMs - getRoundIndex(utcMs) * ROUND_MS) / 1000
  const roundSec = ROUND_MS / 1000
  const mainSec = roundSec - DAY_NIGHT_BLEND_SEC
  const start = night ? SKY_NIGHT_START : SKY_DAY_START
  const end = night ? SKY_NIGHT_END : SKY_DAY_END
  const next = night ? SKY_DAY_START : SKY_NIGHT_START
  if (elapsedSec < mainSec) return lerpForward(start, end, elapsedSec / mainSec)
  return lerpForward(end, next, (elapsedSec - mainSec) / DAY_NIGHT_BLEND_SEC)
}

/** True when scene lights are allowed to be on (last seconds of day, all night, first seconds of next day). */
export function lightsEnabledAt(utcMs: number): boolean {
  if (isNightAt(utcMs)) return true
  const elapsedSec = (utcMs - getRoundIndex(utcMs) * ROUND_MS) / 1000
  const roundSec = ROUND_MS / 1000
  return elapsedSec < LIGHTS_OFF_SECONDS_AFTER_DAWN || elapsedSec >= roundSec - LIGHTS_ON_SECONDS_BEFORE_NIGHT
}

/** Default music tape per phase (ids from MUSIC_STORE in shared/upgrades.ts). */
export const DAY_MUSIC_TAPE_ID = 'w'   // Sprite Sprint - assets/sounds/SpriteSprint_Loop.mp3
export const NIGHT_MUSIC_TAPE_ID = 'b' // Blips Piano  - assets/sounds/blipspiano153 - AuthrAudio.mp3

export function defaultMusicTapeIdAt(utcMs: number): string {
  return isNightAt(utcMs) ? NIGHT_MUSIC_TAPE_ID : DAY_MUSIC_TAPE_ID
}
