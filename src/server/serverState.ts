/**
 * serverState.ts — Shared mutable state, constants, and helpers.
 * This is the foundation module: no imports from other server/ modules.
 */

import { engine, Transform, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

// ── Entity references (set during setupServer) ──

export let flagEntity: Entity
export function setFlagEntity(e: Entity) { flagEntity = e }

export let countdownEntity: Entity
export function setCountdownEntity(e: Entity) { countdownEntity = e }

export let leaderboardEntity: Entity
export function setLeaderboardEntity(e: Entity) { leaderboardEntity = e }

export let allTimeLeaderboardEntity: Entity
export function setAllTimeLeaderboardEntity(e: Entity) { allTimeLeaderboardEntity = e }

export let monthlyLeaderboardEntity: Entity
export function setMonthlyLeaderboardEntity(e: Entity) { monthlyLeaderboardEntity = e }

export let visitorAnalyticsEntity: Entity
export function setVisitorAnalyticsEntity(e: Entity) { visitorAnalyticsEntity = e }

export let monthlyVisitorAnalyticsEntity: Entity
export function setMonthlyVisitorAnalyticsEntity(e: Entity) { monthlyVisitorAnalyticsEntity = e }

export let coinStateEntity: Entity
export function setCoinStateEntity(e: Entity) { coinStateEntity = e }

// ── Per-player maps ──

export const holdTimeEntities = new Map<string, Entity>()
export const knownPlayers = new Set<string>()
export const playerNames = new Map<string, string>()
export const walletEntities = new Map<string, Entity>()
export const upgradeEntities = new Map<string, Entity>()
export const lifetimeWinsEntities = new Map<string, Entity>()

// Lifetime flag hold time cache (server-only, persisted via Storage, no CRDT sync)
export const playerLifetimeHoldTimeCache = new Map<string, number>()

export const playerBoomerangColors = new Map<string, string>() // playerId -> color ('r','y','b','g')
export const playerCoinBalances = new Map<string, number>()
export const playerUpgradeData = new Map<string, import('../shared/upgrades').UpgradeData>()
export const playerLifetimeWinsCache = new Map<string, number>()

export const deathPenaltyCooldowns = new Map<string, number>()
export const lastStealTime = new Map<string, number>()

// ── Per-session analytics counters ──
export const sessionDeaths = new Map<string, number>()
export const sessionBananasDropped = new Map<string, number>()
export const sessionBoomerangsFired = new Map<string, number>()

// ── Visitor tracking ──

export const visitorSessions = new Map<string, { name: string; sessionStartMs: number; totalSecondsToday: number }>()
export const monthlyVisitorSessions = new Map<string, { name: string; sessionStartMs: number; totalSecondsMonth: number }>()
export const currentlyConnected = new Set<string>()

// ── Constants ──

export const PICKUP_RADIUS = 3
export const PROXIMITY_STEAL_RADIUS = 2.0
export const STEAL_IMMUNITY_MS = 3000
export const HOLD_TIME_SYNC_INTERVAL = 0.5
export const SPLASH_DURATION_MS = 3000
export const FLAG_GRAVITY = 15
export const FLAG_MIN_Y = 1.5
export const CARRIER_Y_WINDOW_SEC = 2.0
export const CARRIER_NO_POSITION_TIMEOUT_MS = 5000

// ── Mushroom constants ──

export const MUSHROOM_CX = 250.75
export const MUSHROOM_CZ = 255.5
export const MUSHROOM_RADIUS = 128
export const MUSHROOM_CANDIDATES = 10

// ── Leaderboard reset tracking ──

export let lastLeaderboardResetDay = ''
export function setLastLeaderboardResetDay(d: string) { lastLeaderboardResetDay = d }

// ── Visitor reset tracking ──

export let lastVisitorResetDay = ''
export function setLastVisitorResetDay(d: string) { lastVisitorResetDay = d }

export let lastMonthlyVisitorResetMonth = ''
export function setLastMonthlyVisitorResetMonth(m: string) { lastMonthlyVisitorResetMonth = m }

// ── Concurrent user tracking (hourly peaks) ──

export let hourlyPeakConcurrent: number[] = new Array(24).fill(0)
export function setHourlyPeakConcurrent(arr: number[]) { hourlyPeakConcurrent = arr }

export let peakConcurrent = 0
export function setPeakConcurrent(n: number) { peakConcurrent = n }

export let peakConcurrentTime = '' // HH:MM UTC when peak occurred
export function setPeakConcurrentTime(t: string) { peakConcurrentTime = t }

// ── Ghost shared state ──
// Shared here so both combat.ts (ghost-trap collision) and ghostSystem.ts can access without circular imports.

export interface ActiveGhost {
  entity: Entity
  syncId: number
  hp: number
  posX: number
  posY: number
  posZ: number
  spawnedAtMs: number
  lastStaggerTime: Map<string, number>
  lastHitMs: number
  lastCrdtSyncTime: number
}

export const activeGhosts: ActiveGhost[] = []
export let ghostRespawnCooldown = 0
export function setGhostRespawnCooldown(v: number) { ghostRespawnCooldown = v }
export const GHOST_RESPAWN_COOLDOWN = 30

// ── Shared helpers ──

export function isRealName(name: string): boolean {
  return name.length > 0 && !name.startsWith('0x')
}

export function getPlayerPosition(address: string): Vector3 | null {
  const needle = address.toLowerCase()
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === needle) return Transform.get(entity).position
  }
  return null
}
