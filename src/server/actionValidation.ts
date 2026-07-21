export interface Point3 { x: number; y: number; z: number }

export function isWithinDistance(a: Point3, b: Point3, radius: number): boolean {
  if (radius < 0) return false
  const values = [a.x, a.y, a.z, b.x, b.y, b.z, radius]
  if (!values.every(Number.isFinite)) return false
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz <= radius * radius
}

export function isRitualClaimTimely(startedAtMs: number | undefined, nowMs: number): boolean {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return false
  const elapsed = nowMs - (startedAtMs as number)
  return elapsed >= 31_000 && elapsed <= 120_000
}

/** Invalidate active rituals as soon as their authoritative position leaves the allowed area. */
export function invalidateRitualsOutsideAllowedArea(
  ritualStarts: Map<string, number>,
  isPlayerAllowed: (playerId: string) => boolean
): number {
  let invalidated = 0
  for (const playerId of ritualStarts.keys()) {
    if (!isPlayerAllowed(playerId)) {
      ritualStarts.delete(playerId)
      invalidated++
    }
  }
  return invalidated
}

/** Consume a ritual exactly once and validate both elapsed time and current position. */
export function consumeTrackedRitualClaim(
  ritualStarts: Map<string, number>,
  playerId: string,
  nowMs: number,
  isPlayerAllowed: () => boolean
): boolean {
  const ritualStart = ritualStarts.get(playerId)
  ritualStarts.delete(playerId)
  return isRitualClaimTimely(ritualStart, nowMs) && isPlayerAllowed()
}

export interface TrackedRitualStart {
  ritualStarts: Map<string, number>
  playerId: string
  beganAtMs: number
  isPlayerAllowed: () => boolean
  validateEligibility: () => Promise<boolean>
  maximumAgeMs?: number
}

/**
 * Register first, then perform slow eligibility work. This intentionally returns a
 * promise without being `async`, so tracking is visible synchronously to server systems.
 */
export function beginTrackedRitual(options: TrackedRitualStart): Promise<boolean> {
  const maximumAgeMs = options.maximumAgeMs ?? 120_000
  if (!options.isPlayerAllowed()) return Promise.resolve(false)

  const existing = options.ritualStarts.get(options.playerId)
  if (existing !== undefined && options.beganAtMs - existing <= maximumAgeMs) {
    return Promise.resolve(false)
  }

  options.ritualStarts.set(options.playerId, options.beganAtMs)
  const clearIfCurrent = () => {
    if (options.ritualStarts.get(options.playerId) === options.beganAtMs) {
      options.ritualStarts.delete(options.playerId)
    }
  }

  let validation: Promise<boolean>
  try {
    validation = options.validateEligibility()
  } catch (error) {
    clearIfCurrent()
    return Promise.reject(error)
  }

  return validation.then(
    eligible => {
      const stillTracked = options.ritualStarts.get(options.playerId) === options.beganAtMs
      if (!eligible || !stillTracked) clearIfCurrent()
      return eligible && stillTracked
    },
    error => {
      clearIfCurrent()
      throw error
    }
  )
}
