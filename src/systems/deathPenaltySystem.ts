/**
 * Death Penalty System
 * 
 * Tracks coin penalties on death for UI display.
 * Each death type (drown, lightning, ghost) sends a penalty request to the server.
 */
import { room } from '../shared/messages'

// ── State ──
let lastPenalty = 0
let penaltyVisible = false

/** Send a death penalty request to the server */
export function sendDeathPenalty(cause: string): void {
  room.send('deathPenalty', { cause })
  // Optimistically show -10 on the death screen (server will confirm)
  lastPenalty = 10
  penaltyVisible = true
  console.log(`[DeathPenalty] 💀 Sending penalty for: ${cause}`)
}

/** Get the last penalty amount (for death screen display) */
export function getLastDeathPenalty(): number {
  return lastPenalty
}

/** Whether a penalty should be shown on the current death screen */
export function isDeathPenaltyVisible(): boolean {
  return penaltyVisible
}

/** Clear penalty display (call when death screen ends) */
export function clearDeathPenalty(): void {
  penaltyVisible = false
  lastPenalty = 0
}

/** Set up message listeners */
export function setupDeathPenaltyMessages(): void {
  room.onMessage('deathPenaltyApplied', (data) => {
    lastPenalty = (data as any).penalty ?? 10
    console.log(`[DeathPenalty] Server confirmed penalty: -${lastPenalty} coins`)
  })
}
