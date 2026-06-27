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

export function getLastTapeId(): string {
  return lastTapeId
}

// ── Toggle (single source of truth for mute/unmute) ──

/** Toggle music on/off. Call from boombox click, key press, or UI button. */
export function toggleMusic(): void {
  if (equippedTapeId !== null) {
    // Mute — just zero volume, keep playing so position is preserved
    setEquippedTape(null)
    try {
      const audio = AudioSource.getMutable(musicEntity)
      audio.volume = 0
    } catch (e) { console.error('[Music] Failed to mute:', e) }
  } else {
    // Unmute — resume last tape (don't re-set audioClipUrl or it restarts)
    const tape = MUSIC_STORE.find(t => t.id === lastTapeId)
    if (tape) {
      setEquippedTape(tape.id)
      try {
        const audio = AudioSource.getMutable(musicEntity)
        audio.volume = 0.1
        audio.playing = true
      } catch (e) { console.error('[Music] Failed to unmute:', e) }
    }
  }
}
