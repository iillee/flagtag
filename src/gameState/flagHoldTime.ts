import { engine, PlayerIdentityData } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/players'
import { PlayerFlagHoldTime, Flag, FlagState, CountdownTimer } from '../shared/components'
import { room } from '../shared/messages'

/** Players in the scene (userId -> display name). Updated via onEnterScene / onLeaveScene. */
const playersInScene = new Map<string, string>()

/**
 * Permanent name cache — never evicted. Stores the best-known display name
 * for every player seen this session. Used to resolve leaderboard names
 * even after players leave the scene.
 */
const knownPlayerNames = new Map<string, string>()
// Track previous sort order so ties preserve existing positions (no flickering)
const previousRank = new Map<string, number>()

function isRealName(name: string): boolean {
  return name.length > 0 && !name.startsWith('0x')
}

export function addPlayer(userId: string, name: string): void {
  const key = userId.toLowerCase()
  const localPlayer = getPlayer()
  const isLocal = localPlayer && localPlayer.userId.toLowerCase() === key

  // For remote players, verify they have a PlayerIdentityData entity.
  // onEnterScene can fire from stale CRDT data for players not truly present.
  if (!isLocal) {
    let found = false
    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
      if (identity.address.toLowerCase() === key) { found = true; break }
    }
    if (!found) {
      console.log('[FlagHoldTime] Rejected stale onEnterScene for', key.slice(0, 8))
      return
    }
  }

  playersInScene.set(key, name)
  // Cache the name permanently if it's a real display name
  if (isRealName(name)) {
    knownPlayerNames.set(key, name)
  }
}

export function removePlayer(userId: string): void {
  playersInScene.delete(userId.toLowerCase())
  // knownPlayerNames is NOT cleared — names persist for leaderboard
}

/** Get the best-known display name for a userId (scene > cache > null). */
export function getKnownPlayerName(userId: string): string | null {
  const key = userId.toLowerCase()
  const sceneName = playersInScene.get(key)
  if (sceneName && isRealName(sceneName)) return sceneName
  return knownPlayerNames.get(key) ?? null
}

/**
 * Client-side name resolution system.
 * Periodically scans all players in the scene via getPlayer() and updates
 * the local name cache when a real display name is resolved. This catches
 * names that weren't ready when onEnterScene first fired.
 *
 * For the LOCAL player, it also sends registerName to the server so that
 * leaderboard/visitor data gets updated. For OTHER players, the client-side
 * cache is sufficient since UI applies overrides at render time.
 */
let nameResolvTimer = 0
const NAME_RESOLVE_INTERVAL = 2.0 // seconds between scans

export function nameResolverSystem(dt: number): void {
  nameResolvTimer += dt
  if (nameResolvTimer < NAME_RESOLVE_INTERVAL) return
  nameResolvTimer = 0

  const localPlayer = getPlayer()
  const localUserId = localPlayer?.userId?.toLowerCase() ?? ''

  // Build set of players actually present in the scene (from engine entities)
  const presentPlayers = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const userId = identity.address
    if (!userId) continue
    const key = userId.toLowerCase()
    presentPlayers.add(key)

    // Name resolution: try to resolve unknown names
    if (!knownPlayerNames.has(key)) {
      const data = getPlayer({ userId })
      if (data && isRealName(data.name)) {
        knownPlayerNames.set(key, data.name)

        if (playersInScene.has(key)) {
          playersInScene.set(key, data.name)
        }

        if (key === localUserId) {
          room.send('registerName', { name: data.name })
        }
      }
    }
  }

  // Reconciliation: remove stale entries from playersInScene that no longer
  // have a PlayerIdentityData entity. onLeaveScene can miss disconnects/teleports,
  // so this periodic cleanup prevents ghost names on the scoreboard.
  // Always keep the local player (their own entity is always present).
  for (const [userId] of playersInScene) {
    const key = userId.toLowerCase()
    if (key === localUserId) continue
    if (!presentPlayers.has(key)) {
      playersInScene.delete(userId)
      console.log('[FlagHoldTime] Reconciliation: removed stale player', key.slice(0, 8), 'from playersInScene')
    }
  }

  // Re-add: any player present in PlayerIdentityData but missing from playersInScene.
  // addPlayer() rejects a joiner whose PlayerIdentityData entity hasn't arrived yet,
  // so under CRDT congestion such a joiner would otherwise be absent from the
  // scoreboard/spectator list all session. Mirror addPlayer with a resolved name
  // (or the address as placeholder — UI resolves the real name at render time).
  for (const key of presentPlayers) {
    if (playersInScene.has(key)) continue
    // Placeholder must be the short id, not the full 42-char address: the render fallback
    // is `getKnownPlayerName() || name || slice(0,8)`, so a truthy full-address `name` would
    // display the whole 0x… string on the scoreboard until the real name resolves.
    playersInScene.set(key, getKnownPlayerName(key) ?? key.slice(0, 8))
    console.log('[FlagHoldTime] Reconciliation: re-added present player', key.slice(0, 8), 'to playersInScene')
  }
}

/** For UI: list of players with hold times from synced component. */
// ── Client-side interpolation for smooth scoreboard counting ──
// The server syncs hold time every ~0.2s via CRDT. Between updates, we locally
// extrapolate the carrier's score so the UI counts up smoothly every frame.
let lastCarrierId = ''
let lastCarrierSyncedSeconds = 0
let interpolationStartTime = 0
// Highest value shown for EACH player this round. Hold time only accumulates within a
// round, so displayed rows must be monotonic until the round ends: when
// PlayerFlagHoldTime CRDT updates stall (the documented saturation class), the raw
// synced value can sit at 0 while interpolation was showing the real count — without
// this clamp the row visibly resets to 0 the instant the carry ends (steal/drop/death).
// Cleared ONLY on the WS round-end signal (cinematic snapshot), never on CRDT
// zero-detection, which cannot distinguish "reset to 0" from "stalled at 0".
const lastShownSeconds = new Map<string, number>()
// When the flagHeartbeat last re-anchored interpolation with an authoritative total.
// Guards the round-reset detection below from misreading a stalled CRDT (0) as a reset.
let lastAuthoritativeAnchorMs = 0
// While set (Date.now() < this), the server's heartbeat reported NO carrier — a
// CRDT-derived carrier within this window is a stale Flag entity, and interpolating
// for it would inflate their row (and the clamp would lock the overshoot in).
let serverReportsNoCarrierUntil = 0
// Edge detection for the synced countdown's round-end flag (round-end clamp backstop).
let prevRoundEndTriggered = false

/**
 * Called by flagSystem on every flagHeartbeat with the server's authoritative view:
 * the carrier ('' when nobody carries) and their hold total (WS path — works even
 * when the PlayerFlagHoldTime CRDT is stalled).
 */
export function applyServerHoldTime(carrierId: string, seconds: number): void {
  const key = (carrierId || '').toLowerCase()
  if (!key) {
    // Server says nobody is carrying: suppress interpolation for any stale
    // CRDT-derived carrier until the next heartbeat can say otherwise.
    serverReportsNoCarrierUntil = Date.now() + 6000
    return
  }
  serverReportsNoCarrierUntil = 0
  if (!Number.isFinite(seconds) || seconds < 0) return
  if ((lastShownSeconds.get(key) ?? 0) < seconds) lastShownSeconds.set(key, seconds)
  if (key === lastCarrierId && seconds > lastCarrierSyncedSeconds) {
    lastCarrierSyncedSeconds = seconds
    interpolationStartTime = Date.now()
    lastAuthoritativeAnchorMs = Date.now()
  }
}

// Server-confirmed carrier — used as fallback when CRDT Flag state is stale.
// Set by flagSystem when pickupConfirmed arrives, cleared when CRDT catches up or drop confirmed.
let confirmedCarrierIdForInterpolation = ''
let confirmedCarrierTimestamp = 0

/** Called by flagSystem when pickupConfirmed message arrives. */
export function setConfirmedCarrier(carrierId: string): void {
  confirmedCarrierIdForInterpolation = carrierId.toLowerCase()
  confirmedCarrierTimestamp = Date.now()
}

/** Called by flagSystem when CRDT confirms Carried state or a drop is confirmed. */
export function clearConfirmedCarrier(): void {
  confirmedCarrierIdForInterpolation = ''
  confirmedCarrierTimestamp = 0
}

/**
 * Called every frame (from a system) to keep interpolation state fresh.
 * Tracks when the carrier or their synced seconds change.
 * Also detects round resets (all scores drop to 0) to prevent stale interpolation.
 */
export function updateHoldTimeInterpolation(): void {
  // Scan ALL Flag entities and pick the carried one's carrier (mirrors
  // getCurrentFlagCarrierUserId). An orphaned/duplicate Flag entity ordered
  // first must not make us see "no carrier".
  let currentCarrierId = ''
  for (const [, flag] of engine.getEntitiesWith(Flag)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      currentCarrierId = flag.carrierPlayerId.toLowerCase()
      break
    }
  }

  // The heartbeat said nobody is carrying — a CRDT-derived carrier in this window is
  // a stale Flag entity; interpolating for them would inflate their row and the
  // monotonic clamp would lock the overshoot in for the rest of the round.
  if (currentCarrierId && Date.now() < serverReportsNoCarrierUntil) {
    currentCarrierId = ''
  }

  // Round-end backstop independent of the respawnPlayers WS message: the synced
  // countdown flips roundEndTriggered at round end — on that edge, clear the
  // round-scoped display clamp even if the WS snapshot path was missed.
  for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
    if (timer.roundEndTriggered && !prevRoundEndTriggered) lastShownSeconds.clear()
    prevRoundEndTriggered = timer.roundEndTriggered
    break
  }

  // If CRDT doesn't show a carrier but the server confirmed one recently (< 3s ago),
  // trust the confirmation so interpolation doesn't reset during the CRDT gap.
  if (!currentCarrierId && confirmedCarrierIdForInterpolation) {
    if (Date.now() - confirmedCarrierTimestamp < 3000) {
      currentCarrierId = confirmedCarrierIdForInterpolation
    } else {
      // Grace expired — clear stale confirmation
      confirmedCarrierIdForInterpolation = ''
      confirmedCarrierTimestamp = 0
    }
  }

  if (currentCarrierId !== lastCarrierId) {
    // Carrier changed — reset interpolation. The per-player lastShownSeconds clamp is
    // deliberately NOT touched here: it's what keeps the ex-carrier's row from
    // collapsing to a stalled CRDT value.
    lastCarrierId = currentCarrierId
    lastCarrierSyncedSeconds = 0
    interpolationStartTime = Date.now()
  }

  if (currentCarrierId) {
    // Read the latest synced seconds for the carrier
    let maxSynced = 0
    for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
      if (data.playerId.toLowerCase() === currentCarrierId) {
        maxSynced = Math.max(maxSynced, data.seconds)
      }
    }
    // Detect round reset: if server synced value drops below our last known value,
    // the round was reset. Re-anchor interpolation to the new (lower) value.
    // Skip while a recent heartbeat anchor is active: with a stalled CRDT, maxSynced
    // is 0 while the heartbeat anchored us to the real total — that's a stall, not a
    // reset, and true round resets are handled by the WS respawnPlayers path anyway.
    if (maxSynced < lastCarrierSyncedSeconds && Date.now() - lastAuthoritativeAnchorMs > 6000) {
      lastCarrierSyncedSeconds = maxSynced
      interpolationStartTime = Date.now()
      // A LOWER value actually arrived (CRDT is flowing, not stalled) with no recent
      // heartbeat contradicting it — treat as a true reset: also drop the display
      // clamp so rows can fall to the new server truth. Backstop for a client that
      // missed the respawnPlayers round-end signal.
      lastShownSeconds.clear()
    }
    // When server sends a new value, re-anchor our interpolation
    if (maxSynced > lastCarrierSyncedSeconds) {
      lastCarrierSyncedSeconds = maxSynced
      interpolationStartTime = Date.now()
    }
  }
}

// ── Cinematic snapshot: freeze scoreboard during round-end cinematic ──
let _cinematicSnapshot: { userId: string; name: string; seconds: number }[] | null = null

/** Snapshot current scores for display during cinematic. Call BEFORE CRDT resets arrive. */
export function snapshotScoresForCinematic(): void {
  // Force a fresh computation (bypass cache)
  _holdTimeCacheTime = 0
  _cinematicSnapshot = getPlayersWithHoldTimes().map(p => ({ ...p }))
  // Round is over (WS respawnPlayers path) — the round-scoped display clamp resets
  // AFTER the snapshot captured the best-known values, so next round starts from 0.
  lastShownSeconds.clear()
  console.log('[FlagHoldTime] Cinematic snapshot:', _cinematicSnapshot.length, 'players')
}

/** Provide final scores from winnersJson as fallback if snapshot was missed. */
export function snapshotScoresFromWinners(winners: { userId: string; name: string; seconds: number }[]): void {
  // If no existing snapshot, seed from CRDT first
  if (!_cinematicSnapshot) {
    _cinematicSnapshot = getPlayersWithHoldTimes().map(p => ({ ...p }))
  }
  // Merge server's authoritative scores into snapshot (top 3 are accurate)
  for (const w of winners) {
    const key = w.userId.toLowerCase()
    const existing = _cinematicSnapshot.find(p => p.userId.toLowerCase() === key)
    if (existing) {
      existing.seconds = w.seconds
    } else {
      _cinematicSnapshot.push({ ...w })
    }
  }
  // Round is over — reset the round-scoped display clamp (see snapshotScoresForCinematic).
  lastShownSeconds.clear()
  console.log('[FlagHoldTime] Cinematic snapshot merged with server winners:', winners.length, 'updated')
}

/** Clear the cinematic snapshot (scores reset to live CRDT). */
export function clearCinematicSnapshot(): void {
  _cinematicSnapshot = null
  // Fresh round baseline — everything shown from here on belongs to the new round.
  lastShownSeconds.clear()
}

/** Get frozen scores if in cinematic, null otherwise. */
export function getCinematicSnapshot(): { userId: string; name: string; seconds: number }[] | null {
  return _cinematicSnapshot
}

// Cached result — recomputed at most every 250ms to keep UI render loop lightweight
let _cachedHoldTimes: { userId: string; name: string; seconds: number }[] = []
let _holdTimeCacheTime = 0
const HOLD_TIME_CACHE_MS = 250

export function getPlayersWithHoldTimes(): { userId: string; name: string; seconds: number }[] {
  const now = Date.now()
  if (now - _holdTimeCacheTime < HOLD_TIME_CACHE_MS) return _cachedHoldTimes
  _holdTimeCacheTime = now
  // Build lookup from synced hold-time entities, keyed by lowercase playerId.
  // If duplicates exist (shouldn't after server cleanup), SUM them — but if
  // ANY entity for a player has seconds=0, treat the whole player as 0
  // (the server reset scores to 0 at round end; stale entities must not override).
  const synced = new Map<string, number>()
  const entityCount = new Map<string, number>()
  const zeroCount = new Map<string, number>()
  for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    const key = data.playerId.toLowerCase()
    entityCount.set(key, (entityCount.get(key) ?? 0) + 1)
    if (data.seconds === 0) zeroCount.set(key, (zeroCount.get(key) ?? 0) + 1)
    const existing = synced.get(key) ?? 0
    synced.set(key, Math.max(existing, data.seconds))
  }
  // Only force to 0 when ALL entities for a player are 0 (round reset).
  // If a mix of 0 and non-zero exists (orphaned duplicate), keep the max.
  for (const [key, total] of entityCount) {
    if ((zeroCount.get(key) ?? 0) === total) {
      synced.set(key, 0)
    }
  }

  // Client-side interpolation: add elapsed time since last CRDT update for the current carrier.
  // Start interpolating from 0 immediately on pickup so the scoreboard counts from 1, not 2.
  // Skip interpolation only if the server has reset scores to 0 (round end) AND we had a
  // non-zero synced value before (meaning a true reset, not just a fresh pickup).
  if (lastCarrierId) {
    const carrierSynced = synced.get(lastCarrierId) ?? 0
    const elapsedSec = (Date.now() - interpolationStartTime) / 1000
    const interpolated = lastCarrierSyncedSeconds + elapsedSec
    // Only apply if we haven't been reset to 0 by the server mid-round
    if (carrierSynced > 0 || lastCarrierSyncedSeconds === 0) {
      synced.set(lastCarrierId, Math.max(carrierSynced, interpolated))
    }
  }

  // Per-player monotonic clamp for the round (see lastShownSeconds): a row never
  // shows less than we've already shown. This is what stops the "score resets to 0
  // when the flag is stolen/dropped/carrier dies" artifact — the ex-carrier's row
  // holds its interpolated value instead of collapsing to a stalled CRDT 0, and
  // self-corrects upward when real values arrive (CRDT catch-up or heartbeat).
  for (const [key, value] of synced) {
    const shown = lastShownSeconds.get(key) ?? 0
    if (value > shown) lastShownSeconds.set(key, value)
    else if (shown > value) synced.set(key, shown)
  }

  // Build result ONLY from players currently in the scene.
  // We no longer include "synced-but-not-in-scene" players because the server
  // now cleans up hold-time entities for disconnected players at round end,
  // and showing stale ghost entries was causing the duplicate name bug.
  const seen = new Set<string>()
  const result: { userId: string; name: string; seconds: number; rawSeconds: number }[] = []
  for (const [userId, name] of playersInScene) {
    const key = userId.toLowerCase()
    if (seen.has(key)) continue  // Defensive dedup
    seen.add(key)

    const raw = synced.get(key) ?? 0
    const displayName = getKnownPlayerName(userId) || name || userId.slice(0, 8)
    result.push({
      userId,
      name: displayName,
      seconds: Math.floor(raw),
      rawSeconds: raw
    })
  }

  // Sort by floored seconds (what the user sees) so sub-second interpolation
  // jitter doesn't cause visible reordering.  Ties preserve previous order
  // (whoever was higher first stays higher) to prevent flickering.
  result.sort((a, b) => {
    const floorDiff = Math.floor(b.rawSeconds) - Math.floor(a.rawSeconds)
    if (floorDiff !== 0) return floorDiff
    // Tie: preserve previous rank order (lower rank index = higher position)
    const prevA = previousRank.get(a.userId.toLowerCase()) ?? 9999
    const prevB = previousRank.get(b.userId.toLowerCase()) ?? 9999
    return prevA - prevB
  })

  // Update previous rank for next frame
  previousRank.clear()
  result.forEach((p, i) => previousRank.set(p.userId.toLowerCase(), i))
  _cachedHoldTimes = result
  return result
}

/** Who is currently holding the flag. Null if no one is carrying. */
export function getCurrentFlagCarrierUserId(): string | null {
  for (const [, flag] of engine.getEntitiesWith(Flag)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      return flag.carrierPlayerId
    }
  }
  return null
}
