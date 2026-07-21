// mushroomSystem.ts — Mushroom spawning, pickup, and position broadcasting

import { room } from '../shared/messages'
import {
  MUSHROOM_CX, MUSHROOM_CZ, MUSHROOM_RADIUS, MUSHROOM_CANDIDATES,
  getPlayerPosition,
} from './serverState'

const MUSHROOM_COUNT = 1
const MUSHROOM_PICKUP_COOLDOWN_MS = 2000
// Claim slack around a candidate point. Clients place the mushroom at the FIRST
// candidate whose raycast lands above water, so the true position is always one of
// the server-generated candidates — the server just can't know which (no raycasts
// here). Generous vs the client's 0.5m pickup radius for the same reason as coins:
// server-replicated positions lag a boosted player by several meters.
const MUSHROOM_CLAIM_RADIUS = 16
const lastMushroomPickup = new Map<string, number>()

/** Drop per-player mushroom state on disconnect (called from playerTrackingSystem). */
export function clearPlayerMushroomState(walletAddress: string): void {
  lastMushroomPickup.delete(walletAddress.toLowerCase())
}

interface ServerMushroom {
  id: number
  candidates: { x: number; z: number }[]
  pickedUp: boolean
}

const activeMushrooms: ServerMushroom[] = []
let mushroomIdCounter = 0

function randomMushroomCandidates(): { x: number; z: number }[] {
  const candidates: { x: number; z: number }[] = []
  for (let i = 0; i < MUSHROOM_CANDIDATES; i++) {
    const angle = Math.random() * Math.PI * 2
    const r = MUSHROOM_RADIUS * Math.sqrt(Math.random())
    candidates.push({ x: MUSHROOM_CX + Math.cos(angle) * r, z: MUSHROOM_CZ + Math.sin(angle) * r })
  }
  return candidates
}

function mushroomToPayload(m: ServerMushroom): any {
  return { id: m.id, candidates: m.candidates }
}

function spawnOneMushroom(): void {
  const candidates = randomMushroomCandidates()
  const m: ServerMushroom = { id: mushroomIdCounter++, candidates, pickedUp: false }
  activeMushrooms.push(m)
  console.log('[Server] 🍄 Spawned replacement mushroom', m.id, 'with', candidates.length, 'candidates')
  room.send('mushroomPositions', { mushroomsJson: JSON.stringify([mushroomToPayload(m)]) })
}

export function spawnMushrooms(): void {
  activeMushrooms.length = 0
  for (let i = 0; i < MUSHROOM_COUNT; i++) {
    const candidates = randomMushroomCandidates()
    activeMushrooms.push({
      id: mushroomIdCounter++,
      candidates,
      pickedUp: false
    })
  }
  console.log('[Server] 🍄 Spawned', MUSHROOM_COUNT, 'mushrooms')
  const positions = activeMushrooms.map(mushroomToPayload)
  room.send('mushroomPositions', { mushroomsJson: JSON.stringify(positions), fullReset: true })
}

export function registerMushroomHandlers(): void {
  // ── Mushroom position request (client asks on connect) ──
  room.onMessage('requestMushroomPositions', (_data, context) => {
    try {
      const remaining = activeMushrooms.filter(m => !m.pickedUp).map(mushroomToPayload)
      // Reply only to the requester, not the whole room. Lowercase to match how every
      // other targeted send addresses players (walletBalance, blessingResult, ...).
      const to = context ? [context.from.toLowerCase()] : undefined
      room.send('mushroomPositions', { mushroomsJson: JSON.stringify(remaining) }, to ? { to } : undefined)
    } catch (err) { console.error('[Server] ❌ requestMushroomPositions handler error:', err) }
  })

  // ── Mushroom pickup ──
  room.onMessage('pickupMushroom', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      // Require a replicated server position and rate-limit, so a bot can't claim every
      // mushroom the instant it spawns from anywhere on the map.
      const playerPos = getPlayerPosition(from)
      if (!playerPos) return
      const now = Date.now()
      if (now - (lastMushroomPickup.get(from) ?? 0) < MUSHROOM_PICKUP_COOLDOWN_MS) return
      const mid = (data as any).id as number
      const mushroom = activeMushrooms.find(m => m.id === mid)
      if (!mushroom || mushroom.pickedUp) return
      // The exact placed position is resolved client-side, but it's always one of the
      // candidates this server generated — require X/Z proximity to at least one, so
      // the mushroom is only claimable by players actually at it (see
      // MUSHROOM_CLAIM_RADIUS). Checked before the cooldown is charged so a false
      // rejection doesn't also lock out an honest immediate retry.
      const nearCandidate = mushroom.candidates.some(c => {
        const dx = playerPos.x - c.x
        const dz = playerPos.z - c.z
        return dx * dx + dz * dz <= MUSHROOM_CLAIM_RADIUS * MUSHROOM_CLAIM_RADIUS
      })
      if (!nearCandidate) {
        console.log('[Server] 🍄 Pickup rejected — not near any candidate of mushroom', mid, 'from', from.slice(0, 8))
        return
      }
      lastMushroomPickup.set(from, now)
      mushroom.pickedUp = true
      console.log('[Server] 🍄 Mushroom', mid, 'picked up by', from.slice(0, 8))
      room.send('mushroomPickedUp', { id: mid, playerId: from })
      // Spawn a replacement mushroom
      spawnOneMushroom()
    } catch (err) { console.error('[Server] ❌ pickupMushroom handler error:', err) }
  })
}
