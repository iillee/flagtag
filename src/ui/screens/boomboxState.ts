/**
 * Boombox state — tape definitions, equipped tape tracking, and music toggle.
 * Owned tapes come from playerUpgradeState; this file manages playback state.
 * 
 * toggleMusic() is the single source of truth for mute/unmute — called from
 * boomboxSystem (click), uiSystems (key), and StatsRow (UI click).
 */
import { AudioSource } from '@dcl/sdk/ecs'
import { MUSIC_STORE, type MusicStoreItem } from '../../shared/upgrades'
import { getLocalUpgrades } from '../../gameState/playerUpgradeState'
import { musicEntity } from '../../systems/musicSetup'

export type { MusicStoreItem as TapeItem }

// ── Tape queries ──

/** Get the list of tapes the player owns (from upgrade data) */
export function getOwnedTapes(): MusicStoreItem[] {
  const owned = getLocalUpgrades().tapes
  return MUSIC_STORE.filter(t => owned.includes(t.id))
}

/** Get all available tapes (for store display) */
export function getAllTapes(): MusicStoreItem[] {
  return MUSIC_STORE
}

// ── Equipped state ──

let equippedTapeId: string | null = 'w'
let lastTapeId: string = 'w'

export function getEquippedTape(): string | null {
  return equippedTapeId
}

export function setEquippedTape(id: string | null): void {
  if (id !== null) lastTapeId = id
  equippedTapeId = id
}

/**
 * Reset the pause-position tracker to 0. Call when swapping to a different tape
 * (fresh track → fresh position). Toggle pause/resume within the SAME tape does
 * NOT reset — that's the whole point of the tracker.
 */
export function resetMusicPosition(): void {
  pausedPositionSec = 0
  playStartMs = Date.now()
}

export function getLastTapeId(): string {
  return lastTapeId
}

// ── Toggle (single source of truth for pause/resume) ──

// Playback position tracking. AudioSource.currentTime is WRITE-ONLY from the
// scene's side — the DCL client uses it as a seek target but never syncs the
// true playback cursor back into the CRDT. Reading `audio.currentTime` always
// returns whatever we last wrote (default 0), so the previous attempt to
// read-and-restore always resumed at 0 (restart, same symptom as before).
//
// Instead we track the position ourselves in wall-clock time:
//   - playStartMs = Date.now() when the CURRENT playing period started
//   - pausedPositionSec = cumulative seconds played before this current period
// The whole scheme runs only inside toggleMusic() — zero per-frame cost, zero
// added CRDT/network traffic.
let playStartMs: number = Date.now()
let pausedPositionSec: number = 0

/** Toggle music pause/resume. Call from boombox click, key press, or UI button. */
export function toggleMusic(): void {
  if (equippedTapeId !== null) {
    // Pause — add elapsed play time to accumulator, then stop
    setEquippedTape(null)
    try {
      pausedPositionSec += (Date.now() - playStartMs) / 1000
      const audio = AudioSource.getMutable(musicEntity)
      audio.playing = false
    } catch (e) { console.error('[Music] Failed to pause:', e) }
  } else {
    // Resume — seek back to accumulated position, restart the clock, then play
    const tape = MUSIC_STORE.find(t => t.id === lastTapeId)
    if (tape) {
      setEquippedTape(tape.id)
      try {
        const audio = AudioSource.getMutable(musicEntity) as {
          volume: number; playing: boolean; currentTime?: number
        }
        // Do NOT reassign volume here — preserve whatever musicSetup / user
        // has configured. (Old code hardcoded 0.1 which made resume inaudible
        // after we bumped the setup volume to 0.6.)
        // Seek BEFORE setting playing=true. The SDK reads currentTime at the
        // playing=false → true transition; setting it after has no effect until
        // the next such transition.
        audio.currentTime = pausedPositionSec
        audio.playing = true
        playStartMs = Date.now()
      } catch (e) { console.error('[Music] Failed to resume:', e) }
    }
  }
}
