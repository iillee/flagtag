/**
 * In-memory store of validated client-reported player positions.
 * Leaf module: imports only the pure shared validators, so serverState may use it.
 */
import {
  acceptReportedPosition,
  isFreshReportedPosition,
  type ReportedPos
} from '../shared/reportedPosition'

const reportedPositions = new Map<string, ReportedPos>()
const reportRejectCounts = new Map<string, number>()
let fallbackReads = 0
let positionLogHook: ((reason: string) => void) | undefined

export function setPlayerPositionLogHook(fn: (reason: string) => void): void {
  positionLogHook = fn
}

export function notifyPlayerPositionLog(reason: string): void {
  positionLogHook?.(reason)
}

export function countFreshReportedPositions(now: number = Date.now()): number {
  let fresh = 0
  for (const pos of reportedPositions.values()) {
    if (isFreshReportedPosition(pos, now)) fresh += 1
  }
  return fresh
}


function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

export function noteClientPosition(address: string, x?: number, y?: number, z?: number, now: number = Date.now()): void {
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return
  const addr = address.toLowerCase()
  const decision = acceptReportedPosition(reportedPositions.get(addr), x, y, z, now)
  if (!decision.ok) {
    bump(reportRejectCounts, decision.reason)
    return
  }
  reportedPositions.set(addr, decision.pos)
}

export function getFreshReportedPosition(address: string, now: number = Date.now()): ReportedPos | null {
  const pos = reportedPositions.get(address.toLowerCase())
  if (!isFreshReportedPosition(pos, now)) return null
  return pos ?? null
}

export function getFreshReportedAddresses(now: number = Date.now()): string[] {
  const out: string[] = []
  for (const [addr, pos] of reportedPositions) {
    if (isFreshReportedPosition(pos, now)) out.push(addr)
  }
  return out
}

export function pruneStaleReportedPositions(now: number = Date.now(), maxAgeMs: number = 10_000): void {
  for (const [addr, pos] of reportedPositions) {
    if (now - pos.t > maxAgeMs) reportedPositions.delete(addr)
  }
}

export function notePositionFallback(): void {
  fallbackReads += 1
}

export function takeReportedPositionStats(now: number = Date.now()): Record<string, number> {
  let fresh = 0
  for (const pos of reportedPositions.values()) {
    if (isFreshReportedPosition(pos, now)) fresh += 1
  }
  const stats: Record<string, number> = {
    reportedFresh: fresh,
    reportedStored: reportedPositions.size,
    positionFallbackReads: fallbackReads
  }
  for (const [key, count] of reportRejectCounts) {
    stats[`reportPlayerPos:${key}`] = count
  }
  fallbackReads = 0
  reportRejectCounts.clear()
  return stats
}