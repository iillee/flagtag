// mushroomSystem.ts — Mushroom spawning, pickup, and position broadcasting

import { room } from '../shared/messages'
import {
  MUSHROOM_CX, MUSHROOM_CZ, MUSHROOM_RADIUS, MUSHROOM_CANDIDATES,
} from './serverState'

const MUSHROOM_COUNT = 1

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
  room.onMessage('requestMushroomPositions', (_data, _context) => {
    try {
      const remaining = activeMushrooms.filter(m => !m.pickedUp).map(mushroomToPayload)
      room.send('mushroomPositions', { mushroomsJson: JSON.stringify(remaining) })
    } catch (err) { console.error('[Server] ❌ requestMushroomPositions handler error:', err) }
  })

  // ── Mushroom pickup ──
  room.onMessage('pickupMushroom', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const mid = (data as any).id as number
      const mushroom = activeMushrooms.find(m => m.id === mid)
      if (!mushroom || mushroom.pickedUp) return
      mushroom.pickedUp = true
      console.log('[Server] 🍄 Mushroom', mid, 'picked up by', from.slice(0, 8))
      room.send('mushroomPickedUp', { id: mid, playerId: from })
      // Spawn a replacement mushroom
      spawnOneMushroom()
    } catch (err) { console.error('[Server] ❌ pickupMushroom handler error:', err) }
  })
}
