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
export function getSkyboxSecondsAt(utcMs: number): number {
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
