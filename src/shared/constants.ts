// ── Game Constants ──
// All tuning values and spawn points in one place.

// ── Flag ──

export const FLAG_BASE_POSITION = { x: 352, y: 61, z: 352 }

export const FLAG_SPAWN_POINTS = [
  { x: 350.4, y: 50.6, z: 286.5 },    // Spawn Point 1
  { x: 339, y: 56.25, z: 352 },        // Spawn Point 2
  { x: 333.2, y: 61, z: 399.4 }       // Spawn Point 3
] as const

/**
 * Get a random spawn point for flag respawn.
 * Used at round end to prevent spawn camping.
 */
export function getRandomSpawnPoint(): { x: number; y: number; z: number } {
  const index = Math.floor(Math.random() * FLAG_SPAWN_POINTS.length)
  const spawnPoint = { ...FLAG_SPAWN_POINTS[index] }
  console.log(`[SpawnSystem] Flag spawning at point ${index + 1}/3: (${spawnPoint.x}, ${spawnPoint.y}, ${spawnPoint.z})`)
  return spawnPoint
}

// ── Round Timer ──

/** Round length in minutes; aligned to 5-minute UTC boundaries. */
export const ROUND_LENGTH_MINUTES = 5

// ── Proximity Steal ──

/** Radius for proximity steal (meters). */
export const PROXIMITY_STEAL_RADIUS = 1.8
/** Immunity duration after stealing/picking up flag (ms). */
export const STEAL_IMMUNITY_MS = 3000
/**
 * How long a lightning-struck player is dead: frozen with input disabled, then teleported to
 * spawn. Shared because the SERVER decides who is struck (roundManager sends `lightningStrike`)
 * and must keep them out of steal candidacy while their client has them frozen.
 *
 * The server's exclusion is deliberately LONGER than this — it adds
 * `LIGHTNING_EXCLUSION_MARGIN_MS` (see `checkProximitySteal` in `src/server/flagLogic.ts`),
 * because the server's clock starts when it sends the message and the client's when it arrives,
 * so windows sized identically would be offset by one-way latency.
 */
export const LIGHTNING_RESPAWN_DURATION_SEC = 10.0

/**
 * How long a drowned player is dead: frozen with input disabled, then teleported to spawn.
 * Owned by `waterSystem.ts` (which counts it down by `dt`) and shared for the same reason as
 * the lightning duration above — the server must keep a frozen player out of steal candidacy,
 * and here it learns of the death only from the client's `deathPenalty` report.
 *
 * Lives here rather than as a module-local in `waterSystem.ts` because it is now read from two
 * files: a local copy is what produced the 8.5s-vs-10s mismatch that let the server re-admit a
 * still-frozen player. `DEATH_STEAL_EXCLUSION_MS` in `src/server/flagLogic.ts` derives from
 * this, so changing the freeze moves the exclusion with it.
 */
export const DROWN_RESPAWN_DURATION_SEC = 10.0

// ── Scene floor ──

/** Y of the invisible collider plane below the lifted scene (players can walk on it).
 * The main terrain sits above this; the interior room level is at Y=0. */
export const SCENE_FLOOR_Y = 48

/** Minimum landing Y for a dropped item (trap/bomb) based on its drop height.
 * Guards against a failed/unreported ground raycast sinking items to Y=0 under the
 * lifted terrain, while still allowing drops on the interior room level at Y=0. */
export function dropFloorY(dropY: number): number {
  return dropY > SCENE_FLOOR_Y ? SCENE_FLOOR_Y : 0
}

// ── Trap (banana) ──

/** How long a trap stays on the ground before despawning (seconds). */
export const TRAP_LIFETIME_SEC = 15
/** Cooldown between trap drops (seconds). */
export const TRAP_COOLDOWN_SEC = 5
/** Max traps one player can have on the ground at once. */
export const TRAP_MAX_ACTIVE = 3
/** Radius for trap trigger (meters). */
export const TRAP_TRIGGER_RADIUS = 2.0

// ── Projectile (boomerang) ──

/** Cooldown between projectile fires (seconds). */
export const PROJECTILE_COOLDOWN_SEC = 1.0
/** Max projectiles one player can have in flight at once. */
export const PROJECTILE_MAX_ACTIVE = 1
/** Speed of projectile (meters per second). */
export const PROJECTILE_SPEED = 30
/** Max range if no wall is detected (meters). */
export const PROJECTILE_MAX_RANGE = 50
/** Radius for projectile hitting a player (meters). */
export const PROJECTILE_HIT_RADIUS = 2.0
/** Max time a projectile can exist (seconds) — safety net. */
export const PROJECTILE_LIFETIME_SEC = 8

// ── Bomb ──

/** Bomb fuse time before explosion (seconds). */
export const BOMB_FUSE_SEC = 5
/** Bomb cooldown between drops (seconds). */
export const BOMB_COOLDOWN_SEC = 10
/** Bomb explosion radius (meters). */
export const BOMB_EXPLOSION_RADIUS = 6
/** Bomb stagger duration (ms) — longer than banana. */
export const BOMB_STAGGER_MS = 3000
/**
 * Minimum drop height to trigger impact explosion (meters).
 * Must clear the highest reachable jump: with the mushroom boost (1.5x jump) a normal
 * jump peaks well above 2m, so at 2 every mid-jump bomb drop skipped the fuse and
 * exploded on landing (reported as "bombs firing immediately with no fuse"). 6m means
 * only deliberate high drops (updraft/ledge dives) impact-explode.
 */
export const BOMB_IMPACT_HEIGHT = 6

// ── Ghost ──

/** Ghost detection radius (meters) — starts homing when player is within this. */
export const GHOST_DETECT_RADIUS = 20
/** Ghost base speed (m/s). */
export const GHOST_SPEED = 3
/** Ghost fast speed when close (m/s). */
export const GHOST_FAST_SPEED = 5
/** Distance at which ghost speeds up (meters). */
export const GHOST_FAST_DIST = 8
/** Ghost hit radius — staggers player on contact (meters). */
export const GHOST_HIT_RADIUS = 1.5
/** Ghost spawn interval (seconds). */
export const GHOST_SPAWN_INTERVAL = 20
/** Max active ghosts. */
export const GHOST_MAX_ACTIVE = 5
