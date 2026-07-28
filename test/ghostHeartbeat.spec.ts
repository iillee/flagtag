/**
 * Tests for src/shared/ghostHeartbeat.ts — the pure logic behind the
 * invisible-ghost fallback-visual channel.
 */
import {
  serializeGhostHeartbeat, parseGhostHeartbeat, decideFallbackAction,
  GHOST_HEARTBEAT_STALE_MS,
  type GhostHeartbeatEntry
} from '../src/shared/ghostHeartbeat'

describe('serializeGhostHeartbeat / parseGhostHeartbeat', () => {
  it('round-trips a normal payload', () => {
    const entries: GhostHeartbeatEntry[] = [
      { id: 42, x: 100.5, y: 50.25, z: 200.75 },
      { id: 43, x: -1, y: 0, z: 1 }
    ]
    expect(parseGhostHeartbeat(serializeGhostHeartbeat(entries))).toEqual(entries)
  })

  it('returns [] for malformed JSON without throwing', () => {
    expect(parseGhostHeartbeat('not json')).toEqual([])
    expect(parseGhostHeartbeat('')).toEqual([])
    expect(parseGhostHeartbeat('{"not":"an array"}')).toEqual([])
  })

  it('filters out entries with missing or non-finite fields', () => {
    const json = JSON.stringify([
      { id: 1, x: 0, y: 0, z: 0 },                       // valid
      { id: 'nope', x: 0, y: 0, z: 0 },                  // bad id
      { id: 2, x: NaN, y: 0, z: 0 },                     // NaN
      { id: 3, x: Infinity, y: 0, z: 0 },                // Infinity
      { id: 4, x: 0, y: 0 },                             // missing z
      null,                                              // null entry
      'string entry',                                    // wrong type
      { id: 5, x: 1, y: 2, z: 3 }                        // valid
    ])
    expect(parseGhostHeartbeat(json)).toEqual([
      { id: 1, x: 0, y: 0, z: 0 },
      { id: 5, x: 1, y: 2, z: 3 }
    ])
  })
})

describe('decideFallbackAction', () => {
  const entry: GhostHeartbeatEntry = { id: 10, x: 1, y: 2, z: 3 }
  const now = 1_000_000

  it('does nothing when CRDT has a ghost and no fallback exists', () => {
    expect(decideFallbackAction({
      crdtGhostCount: 1, heartbeat: [entry], currentFallbackId: null,
      nowMs: now, lastHeartbeatMs: now
    })).toEqual({ kind: 'noop' })
  })

  it('destroys the fallback the moment CRDT delivers a real ghost', () => {
    expect(decideFallbackAction({
      crdtGhostCount: 1, heartbeat: [entry], currentFallbackId: 10,
      nowMs: now, lastHeartbeatMs: now
    })).toEqual({ kind: 'destroy' })
  })

  it('creates a fallback when CRDT is empty and heartbeat is fresh', () => {
    expect(decideFallbackAction({
      crdtGhostCount: 0, heartbeat: [entry], currentFallbackId: null,
      nowMs: now, lastHeartbeatMs: now
    })).toEqual({ kind: 'create', entry })
  })

  it('updates the same fallback across heartbeats with matching id', () => {
    const moved = { ...entry, x: 5 }
    expect(decideFallbackAction({
      crdtGhostCount: 0, heartbeat: [moved], currentFallbackId: 10,
      nowMs: now, lastHeartbeatMs: now
    })).toEqual({ kind: 'update', entry: moved })
  })

  it('recreates when the heartbeat id changes (ghost died + respawned)', () => {
    const different = { ...entry, id: 11 }
    expect(decideFallbackAction({
      crdtGhostCount: 0, heartbeat: [different], currentFallbackId: 10,
      nowMs: now, lastHeartbeatMs: now
    })).toEqual({ kind: 'create', entry: different })
  })

  it('destroys the fallback when heartbeat goes stale', () => {
    expect(decideFallbackAction({
      crdtGhostCount: 0, heartbeat: [entry], currentFallbackId: 10,
      nowMs: now, lastHeartbeatMs: now - GHOST_HEARTBEAT_STALE_MS - 1
    })).toEqual({ kind: 'destroy' })
  })

  it('destroys the fallback when heartbeat reports zero ghosts', () => {
    expect(decideFallbackAction({
      crdtGhostCount: 0, heartbeat: [], currentFallbackId: 10,
      nowMs: now, lastHeartbeatMs: now
    })).toEqual({ kind: 'destroy' })
  })

  it('is a noop when there is nothing to render and nothing to tear down', () => {
    expect(decideFallbackAction({
      crdtGhostCount: 0, heartbeat: [], currentFallbackId: null,
      nowMs: now, lastHeartbeatMs: 0
    })).toEqual({ kind: 'noop' })
  })

  it('keeps rendering the fallback right at the staleness boundary', () => {
    expect(decideFallbackAction({
      crdtGhostCount: 0, heartbeat: [entry], currentFallbackId: 10,
      nowMs: now, lastHeartbeatMs: now - GHOST_HEARTBEAT_STALE_MS
    })).toEqual({ kind: 'update', entry })
  })
})
