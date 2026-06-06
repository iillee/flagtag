import { Color4 } from '@dcl/sdk/math'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { Flag } from '../shared/components'
import { registerSystem, registerThrottled } from '../systems/systemManager'

// ═══════════════════════════════════════════════════════════
// COLOR PALETTE
// ═══════════════════════════════════════════════════════════
export const WHITE = Color4.create(1, 1, 1, 1)
export const BRIGHT_WHITE = Color4.create(1, 1, 1, 1)
export const MUTED = Color4.create(0.82, 0.82, 0.85, 1)
export const LIGHT_GREY = Color4.create(0.72, 0.72, 0.75, 1)
export const GREY = Color4.create(0.62, 0.62, 0.68, 1)
export const CLOSE_GREY = Color4.create(0.4, 0.4, 0.45, 1)

export const GOLD = Color4.create(1, 0.84, 0, 1)
export const BRIGHT_GOLD = Color4.create(1, 0.9, 0.1, 1)
export const SILVER = Color4.create(0.75, 0.78, 0.82, 1)
export const BRONZE = Color4.create(0.8, 0.5, 0.2, 1)

export const CORAL_RED = Color4.create(1, 0.5, 0.45, 1)

export const PANEL_BG = Color4.create(0.1, 0.1, 0.1, 0.92)
/** Nearly-invisible background that blocks click-through to 3D world */
export const PANEL_BG_SEMI = Color4.create(0.08, 0.08, 0.1, 0.87)

// ═══════════════════════════════════════════════════════════
// UI SCALE
// ═══════════════════════════════════════════════════════════
const UI_ADJUST_PRESETS = [
  { label: 'Small',  mult: 0.85 },
  { label: 'Medium', mult: 1.0  },
  { label: 'Large',  mult: 1.2  },
]
let uiAdjustIndex = 0
let autoBaseScale = 1.0

// System that reads screen size and computes auto base scale + cached scale
registerThrottled(() => {
  const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  if (canvas && canvas.width > 0) {
    const raw = Math.min(canvas.width / 1920, canvas.height / 1080)
    autoBaseScale = Math.max(0.6, Math.min(1.6, raw))
  }
  cachedScale = autoBaseScale * UI_ADJUST_PRESETS[uiAdjustIndex].mult
}, 0.5)

let cachedScale = 1.0

export function getUIScale(): number { return cachedScale }
export function getUIScaleLabel(): string { return UI_ADJUST_PRESETS[uiAdjustIndex].label }
export function cycleUIScale() {
  uiAdjustIndex = (uiAdjustIndex + 1) % UI_ADJUST_PRESETS.length
  cachedScale = autoBaseScale * UI_ADJUST_PRESETS[uiAdjustIndex].mult
}

/** Scale a pixel value by current UI scale. Cached per frame. */
export function S(px: number): number {
  return Math.round(px * cachedScale)
}

// ═══════════════════════════════════════════════════════════
// LAYOUT CONSTANTS
// ═══════════════════════════════════════════════════════════
export const _PANEL_WIDTH = 240
export const _ROW_HEIGHT = 32
export const VISITORS_PER_PAGE = 9
export const LEADERBOARD_PER_PAGE = 12
export const _TITLE_FONT = 20
export const _ROW_FONT = 15
export const _PADDING = 14
export const _BORDER_RADIUS = 18
export const _ICON_FONT_QUESTION = 22
export const _ICON_FONT_ANALYTICS = 20
export const _ABILITY_BTN_SIZE = 74
export const _ABILITY_ICON_SIZE = 54
export const _OVERLAY_PANEL_WIDTH = 820
export const _OVERLAY_PANEL_HEIGHT = 476

// ═══════════════════════════════════════════════════════════
// FORMATTERS & HELPERS
// ═══════════════════════════════════════════════════════════
export function getServerConnectionStatus(): 'Y' | 'N' {
  return [...engine.getEntitiesWith(Flag)].length > 0 ? 'Y' : 'N'
}

export function formatCountdown(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h === 0) return `${m}:${s.toString().padStart(2, '0')}`
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export function formatUTCTime(): string {
  return new Date().toUTCString().slice(17, 25)
}

export function formatUTCDate(): string {
  const now = new Date()
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = now.getUTCDate().toString().padStart(2, '0')
  const year = now.getUTCFullYear().toString().slice(2)
  return `${month}/${day}/${year}`
}

export function formatUTCMonth(): string {
  const now = new Date()
  return `${String(now.getUTCMonth() + 1).padStart(2, '0')}/${now.getUTCFullYear()}`
}

export function formatPlaytime(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

export function formatVisitorTime(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

// ═══════════════════════════════════════════════════════════
// BOT DETECTION & VISITOR SORTING
// ═══════════════════════════════════════════════════════════
export type VisitorEntry = { userId: string; name: string; isOnline: boolean; totalSeconds: number }
export type VisitorOrSeparator = VisitorEntry & { _isSeparator?: boolean }

export function isLikelyBot(v: VisitorEntry): boolean {
  const name = v.name.trim()
  const isUnnamed = name === '' || /^0x[0-9a-fA-F]+$/i.test(name)
  return isUnnamed && v.totalSeconds <= 1
}

// Two-slot cache for daily/monthly visitor sorting
let _visitorCache1: { input: VisitorEntry[]; result: VisitorOrSeparator[] } = { input: [], result: [] }
let _visitorCache2: { input: VisitorEntry[]; result: VisitorOrSeparator[] } = { input: [], result: [] }

export function sortVisitorsWithBotSection(raw: VisitorEntry[]): VisitorOrSeparator[] {
  if (raw === _visitorCache1.input) return _visitorCache1.result
  if (raw === _visitorCache2.input) return _visitorCache2.result
  _visitorCache2 = _visitorCache1
  _visitorCache1 = { input: raw, result: [] }

  const realUsers: VisitorEntry[] = []
  const bots: VisitorEntry[] = []
  for (const v of raw) {
    if (isLikelyBot(v)) bots.push(v)
    else realUsers.push(v)
  }
  const sorter = (a: VisitorEntry, b: VisitorEntry) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  }
  realUsers.sort(sorter)
  bots.sort(sorter)
  const result: VisitorOrSeparator[] = [...realUsers]
  if (bots.length > 0) {
    result.push({ userId: '__sep__', name: '', isOnline: false, totalSeconds: 0, _isSeparator: true })
    result.push(...bots)
  }
  _visitorCache1.result = result
  return result
}

// ═══════════════════════════════════════════════════════════
// LEADERBOARD SORTING (with tie-breaking)
// ═══════════════════════════════════════════════════════════
const roundWinAchievementTime = new Map<string, number>()
let lastKnownWins = new Map<string, number>()
let _lastLbInput: any[] = []
let _lastLbSorted: any[] = []

export function getSortedLeaderboardEntries(entries: any[]): any[] {
  if (entries === _lastLbInput && _lastLbSorted.length > 0) return _lastLbSorted
  _lastLbInput = entries

  const now = Date.now()
  if (entries.length === 0 && lastKnownWins.size > 0) {
    roundWinAchievementTime.clear()
    lastKnownWins.clear()
  }
  entries.forEach(entry => {
    const key = entry.userId
    const currentWins = entry.roundsWon
    const lastKnown = lastKnownWins.get(key) || 0
    if (currentWins > lastKnown) {
      roundWinAchievementTime.set(key, now)
      lastKnownWins.set(key, currentWins)
    }
    if (!roundWinAchievementTime.has(key)) {
      roundWinAchievementTime.set(key, now)
    }
  })
  _lastLbSorted = [...entries].sort((a, b) => {
    if (a.roundsWon !== b.roundsWon) return b.roundsWon - a.roundsWon
    const timeA = roundWinAchievementTime.get(a.userId) || now
    const timeB = roundWinAchievementTime.get(b.userId) || now
    return timeA - timeB
  })
  return _lastLbSorted
}
