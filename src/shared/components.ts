import { engine, Schemas } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'
import { createSyncIdPool } from './syncIdPool'

// ── Re-exports for backward compatibility ──
// Consumers that imported constants/utils from this file will still work.
// New code should import from './constants' and './dateUtils' directly.
export { FLAG_BASE_POSITION, FLAG_SPAWN_POINTS, getRandomSpawnPoint, PROXIMITY_STEAL_RADIUS, STEAL_IMMUNITY_MS, TRAP_LIFETIME_SEC, TRAP_COOLDOWN_SEC, TRAP_MAX_ACTIVE, TRAP_TRIGGER_RADIUS, PROJECTILE_COOLDOWN_SEC, PROJECTILE_MAX_ACTIVE, PROJECTILE_SPEED, PROJECTILE_MAX_RANGE, PROJECTILE_HIT_RADIUS, PROJECTILE_LIFETIME_SEC, GHOST_DETECT_RADIUS, GHOST_SPEED, GHOST_FAST_SPEED, GHOST_FAST_DIST, GHOST_HIT_RADIUS, GHOST_SPAWN_INTERVAL, GHOST_MAX_ACTIVE, BOMB_FUSE_SEC, BOMB_COOLDOWN_SEC, BOMB_EXPLOSION_RADIUS, BOMB_STAGGER_MS, BOMB_IMPACT_HEIGHT } from './constants'
export { getTodayDateString, getCurrentMonthString, getNextRoundEndTimeMs, getCountdownSeconds } from './dateUtils'

// ══════════════════════════════════════════════
// ECS Component Definitions
// ══════════════════════════════════════════════

// ── Flag ──

export enum FlagState {
  AtBase = 'atBase',
  Carried = 'carried',
  Dropped = 'dropped'
}

export const Flag = engine.defineComponent('ctf-flag', {
  teamId: Schemas.Int,
  state: Schemas.EnumString<FlagState>(FlagState, FlagState.AtBase),
  carrierPlayerId: Schemas.String,
  baseX: Schemas.Float,
  baseY: Schemas.Float,
  baseZ: Schemas.Float,
  dropAnchorX: Schemas.Float,
  dropAnchorY: Schemas.Float,
  dropAnchorZ: Schemas.Float
}, {
  teamId: 0,
  state: FlagState.AtBase,
  carrierPlayerId: '',
  baseX: 0, baseY: 0, baseZ: 0,
  dropAnchorX: 0, dropAnchorY: 0, dropAnchorZ: 0
})

Flag.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Player hold time ──

export const PlayerFlagHoldTime = engine.defineComponent('ctf-player-flag-hold-time', {
  playerId: Schemas.String,
  seconds: Schemas.Float,
  roundId: Schemas.String
}, { playerId: '', seconds: 0, roundId: '' })

PlayerFlagHoldTime.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Countdown timer ──

export const CountdownTimer = engine.defineComponent('ctf-countdown-timer', {
  roundEndTimeMs: Schemas.Number,
  roundEndTriggered: Schemas.Boolean,
  roundEndDisplayUntilMs: Schemas.Number,
  roundWinnerJson: Schemas.String
}, {
  roundEndTimeMs: 0,
  roundEndTriggered: false,
  roundEndDisplayUntilMs: 0,
  roundWinnerJson: ''
})

CountdownTimer.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Leaderboard state (synced from server) ──

export const LeaderboardState = engine.defineComponent('ctf-leaderboard-state', {
  json: Schemas.String,
  date: Schemas.String
}, { json: '[]', date: '' })

LeaderboardState.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── All-Time Leaderboard state (synced from server) ──

export const AllTimeLeaderboardState = engine.defineComponent('ctf-alltime-leaderboard-state', {
  json: Schemas.String,
}, { json: '[]' })

AllTimeLeaderboardState.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Monthly Leaderboard state (synced from server) ──

export const MonthlyLeaderboardState = engine.defineComponent('ctf-monthly-leaderboard-state', {
  json: Schemas.String,
  month: Schemas.String,
}, { json: '[]', month: '' })

MonthlyLeaderboardState.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Visitor Analytics (server-synced) ──

export const VisitorAnalytics = engine.defineComponent('ctf-visitor-analytics', {
  date: Schemas.String,
  visitorDataJson: Schemas.String,
  onlineCount: Schemas.Int,
  totalUniqueVisitors: Schemas.Int
}, { 
  date: '', 
  visitorDataJson: '[]', 
  onlineCount: 0, 
  totalUniqueVisitors: 0 
})

VisitorAnalytics.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Monthly Visitor Analytics (synced from server) ──

export const MonthlyVisitorAnalytics = engine.defineComponent('ctf-monthly-visitor-analytics', {
  month: Schemas.String,
  visitorDataJson: Schemas.String,
  onlineCount: Schemas.Int,
  totalUniqueVisitors: Schemas.Int
}, { 
  month: '', 
  visitorDataJson: '[]', 
  onlineCount: 0, 
  totalUniqueVisitors: 0 
})

MonthlyVisitorAnalytics.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Trap ──

export const Trap = engine.defineComponent('ctf-banana', {
  droppedByPlayerId: Schemas.String,
  droppedAtMs: Schemas.Number,
}, {
  droppedByPlayerId: '',
  droppedAtMs: 0,
})

Trap.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Trap sync ID pool ──

const trapPool = createSyncIdPool(1_000_000, 40)
export const getNextTrapSyncId = trapPool.next.bind(trapPool)
export const recycleTrapSyncId = trapPool.recycle.bind(trapPool)

// ── Projectile ──

export const Projectile = engine.defineComponent('ctf-shell', {
  firedByPlayerId: Schemas.String,
  firedAtMs: Schemas.Number,
  startX: Schemas.Float,
  startY: Schemas.Float,
  startZ: Schemas.Float,
  dirX: Schemas.Float,
  dirZ: Schemas.Float,
  distanceTraveled: Schemas.Float,
  maxDistance: Schemas.Float,
  active: Schemas.Boolean,
}, {
  firedByPlayerId: '',
  firedAtMs: 0,
  startX: 0, startY: 0, startZ: 0,
  dirX: 0, dirZ: 0,
  distanceTraveled: 0,
  maxDistance: 50,
  active: true,
})

Projectile.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Projectile sync ID pool ──

const projectilePool = createSyncIdPool(2_000_000, 30)
export const getNextProjectileSyncId = projectilePool.next.bind(projectilePool)
export const recycleProjectileSyncId = projectilePool.recycle.bind(projectilePool)

// ── Ghost ──

export const Ghost = engine.defineComponent('ctf-ghost', {
  hp: Schemas.Int,
  spawnX: Schemas.Float,
  spawnY: Schemas.Float,
  spawnZ: Schemas.Float,
  active: Schemas.Boolean,
  targetX: Schemas.Float,
  targetY: Schemas.Float,
  targetZ: Schemas.Float,
}, {
  hp: 1,
  spawnX: 0, spawnY: 0, spawnZ: 0,
  active: true,
  targetX: 0, targetY: 0, targetZ: 0,
})

Ghost.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Ghost sync ID pool ──

// Pool sized generously (64 slots) so recycled IDs aren't handed back before the
// SDK's internal CRDT tombstone for a removed entity has cleared across the
// network. With single-ghost gameplay + 30s respawn cooldown we cycle through
// the whole pool in ~30 minutes of night-time, well past any realistic
// tombstone window. Prior value was 5, which caused fast recycling and
// `syncEntity failed because the id provided is already in use` throws that
// spammed the log stream. See src/server/ghostSystem.ts spawnGhost().
const ghostPool = createSyncIdPool(3_000_000, 64)
export const getNextGhostSyncId = ghostPool.next.bind(ghostPool)
export const recycleGhostSyncId = ghostPool.recycle.bind(ghostPool)

// ── Sync IDs ──

export enum SyncIds {
  FLAG = 1,
  COUNTDOWN = 200,
  LEADERBOARD = 201,
  VISITOR_ANALYTICS = 202,
  ALLTIME_LEADERBOARD = 203,
  MONTHLY_LEADERBOARD = 204,
  MONTHLY_VISITOR_ANALYTICS = 205
}

// ── Portal components (must be registered before engine seals) ──

export const PortalData = engine.defineComponent('portal-data', {
  doorLeft: Schemas.Entity,
  doorRight: Schemas.Entity,
  state: Schemas.Number,
  openCount: Schemas.Array(Schemas.String),
  ajarCount: Schemas.Array(Schemas.String),
  closeCount: Schemas.Array(Schemas.String),
})

export const PortalLayer = engine.defineComponent('portal-layer', {
  baseWorldX: Schemas.Number,
  baseWorldY: Schemas.Number,
  baseWorldZ: Schemas.Number,
  baseLocalX: Schemas.Number,
  baseLocalY: Schemas.Number,
  localZ: Schemas.Number,
  parallaxStrength: Schemas.Number,
  parallaxLimit: Schemas.Number,
  lerpSpeed: Schemas.Number,
  currentOffsetX: Schemas.Number,
  currentOffsetY: Schemas.Number,
  baseScale: Schemas.Number,
  distanceScaleFactor: Schemas.Number,
  portalRotX: Schemas.Number,
  portalRotY: Schemas.Number,
  portalRotZ: Schemas.Number,
  portalRotW: Schemas.Number,
})
