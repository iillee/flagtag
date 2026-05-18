// ── Game Constants ──
// All tuning values and spawn points in one place.

// ── Flag ──

export const FLAG_BASE_POSITION = { x: 230, y: 13, z: 258 }

export const FLAG_SPAWN_POINTS = [
  { x: 228.4, y: 2.6, z: 192.5 },    // Spawn Point 1
  { x: 217, y: 8.25, z: 258 },        // Spawn Point 2
  { x: 211.2, y: 13, z: 305.4 }       // Spawn Point 3
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
