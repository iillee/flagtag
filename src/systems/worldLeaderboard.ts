/**
 * worldLeaderboard.ts — In-world 3D leaderboard display.
 *
 * Two clickable tabs: "Daily Wins" and "Top 10" (all-time).
 * Uses TextShape entities positioned at the Artwork Info board location.
 * Updates every 2 seconds from synced CRDT leaderboard data.
 */
import {
  engine, Entity, Transform, TextShape, TextAlignMode,
  pointerEventsSystem, InputAction, MeshRenderer, MeshCollider, Material, ColliderLayer,
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { getLeaderboardEntries, getAllTimeLeaderboardEntries } from '../gameState/roundsWon'
import { registerThrottled } from './systemManager'

// ── Board config ──
// Pulled 0.5m perpendicular (sideways) from the wall surface
const BOARD_POS = Vector3.create(212.991, 7.467, 245.812)
const BOARD_ROT = Quaternion.fromEulerDegrees(0, -19, 0)

const GOLD = Color4.create(1, 0.84, 0, 1)
const WHITE = Color4.create(1, 1, 1, 1)
const MUTED = Color4.create(0.7, 0.7, 0.75, 1)
const TAB_ACTIVE_BG = Color4.create(0.25, 0.25, 0.3, 0.9)
const TAB_INACTIVE_BG = Color4.create(0.12, 0.12, 0.15, 0.7)

// ── State ──
let activeTab: 'daily' | 'alltime' = 'alltime'
let pageOffset = 0
let lastRenderedText = ''

// ── Entities ──
let parentEntity: Entity
let titleEntity: Entity
let rankEntities: Entity[] = []
let nameEntities: Entity[] = []
let winsEntities: Entity[] = []

let dailyTabEntity: Entity
let dailyTabLabel: Entity
let alltimeTabEntity: Entity
let alltimeTabLabel: Entity
let prevBtnEntity: Entity
let prevBtnLabel: Entity
let nextBtnEntity: Entity
let nextBtnLabel: Entity
let pageLabel: Entity

const MAX_ROWS = 10

export function setupWorldLeaderboard(): void {
  // Parent at board location
  parentEntity = engine.addEntity()
  Transform.create(parentEntity, {
    position: BOARD_POS,
    rotation: BOARD_ROT,
  })

  // Title
  titleEntity = engine.addEntity()
  Transform.create(titleEntity, {
    position: Vector3.create(0, 5.6, 0.08),
    parent: parentEntity,
  })
  TextShape.create(titleEntity, {
    text: 'LEADERBOARD',
    fontSize: 6,
    textColor: GOLD,
    outlineColor: Color4.Black(),
    outlineWidth: 0.08,
    textAlign: TextAlignMode.TAM_TOP_CENTER,
  })

  // Tab buttons
  const dailyTab = createTabButton('DAILY', Vector3.create(-1.8, 4.0, 0.06), true)
  dailyTabEntity = dailyTab.box
  dailyTabLabel = dailyTab.label

  const alltimeTab = createTabButton('ALL TIME', Vector3.create(1.8, 4.0, 0.06), false)
  alltimeTabEntity = alltimeTab.box
  alltimeTabLabel = alltimeTab.label

  // Click handlers
  pointerEventsSystem.onPointerDown(
    { entity: dailyTabEntity, opts: { button: InputAction.IA_POINTER, hoverText: 'Daily Wins', maxDistance: 20 } },
    () => { if (activeTab !== 'daily') { activeTab = 'daily'; pageOffset = 0; lastRenderedText = ''; updateBoard() } }
  )
  pointerEventsSystem.onPointerDown(
    { entity: alltimeTabEntity, opts: { button: InputAction.IA_POINTER, hoverText: 'All Time', maxDistance: 20 } },
    () => { if (activeTab !== 'alltime') { activeTab = 'alltime'; pageOffset = 0; lastRenderedText = ''; updateBoard() } }
  )

  // Leaderboard rows — 3 columns: rank, name, wins
  const COL_RANK_X = -3.2
  const COL_NAME_X = -2.4
  const COL_WINS_X = 2.6
  const ROW_START_Y = 3.2
  const ROW_SPACING = 0.5

  for (let i = 0; i < MAX_ROWS; i++) {
    const y = ROW_START_Y - i * ROW_SPACING
    const baseProps = { fontSize: 3, textColor: WHITE, outlineColor: Color4.Black(), outlineWidth: 0.05, textAlign: TextAlignMode.TAM_MIDDLE_LEFT }

    const rank = engine.addEntity()
    Transform.create(rank, { position: Vector3.create(COL_RANK_X, y, 0.08), parent: parentEntity })
    TextShape.create(rank, { ...baseProps, text: '' })
    rankEntities.push(rank)

    const name = engine.addEntity()
    Transform.create(name, { position: Vector3.create(COL_NAME_X, y, 0.08), parent: parentEntity })
    TextShape.create(name, { ...baseProps, text: '' })
    nameEntities.push(name)

    const wins = engine.addEntity()
    Transform.create(wins, { position: Vector3.create(COL_WINS_X, y, 0.08), parent: parentEntity })
    TextShape.create(wins, { ...baseProps, text: '' })
    winsEntities.push(wins)
  }

  // Navigation buttons (small circles with arrows)
  const NAV_Y = ROW_START_Y - MAX_ROWS * ROW_SPACING - 0.4

  const prevNav = createNavButton('<', Vector3.create(-1.0, NAV_Y, 0.06))
  prevBtnEntity = prevNav.box
  prevBtnLabel = prevNav.label

  const nextNav = createNavButton('>', Vector3.create(1.0, NAV_Y, 0.06))
  nextBtnEntity = nextNav.box
  nextBtnLabel = nextNav.label

  pageLabel = engine.addEntity()
  Transform.create(pageLabel, { position: Vector3.create(0, NAV_Y, 0.08), parent: parentEntity })
  TextShape.create(pageLabel, {
    text: '',
    fontSize: 2.5,
    textColor: MUTED,
    outlineColor: Color4.Black(),
    outlineWidth: 0.05,
    textAlign: TextAlignMode.TAM_MIDDLE_CENTER,
  })

  pointerEventsSystem.onPointerDown(
    { entity: prevBtnEntity, opts: { button: InputAction.IA_POINTER, hoverText: 'Previous Page', maxDistance: 20 } },
    () => { if (pageOffset > 0) { pageOffset -= MAX_ROWS; lastRenderedText = ''; updateBoard() } }
  )
  pointerEventsSystem.onPointerDown(
    { entity: nextBtnEntity, opts: { button: InputAction.IA_POINTER, hoverText: 'Next Page', maxDistance: 20 } },
    () => {
      const allEntries = activeTab === 'daily' ? getLeaderboardEntries() : getAllTimeLeaderboardEntries()
      if (pageOffset + MAX_ROWS < allEntries.length) { pageOffset += MAX_ROWS; lastRenderedText = ''; updateBoard() }
    }
  )

  // Auto-refresh system (every 2s)
  registerThrottled((_dt: number) => {
    updateBoard()
  }, 2.0)

  updateBoard()
}

function createTabButton(label: string, localPos: Vector3, isActive: boolean): { box: Entity; label: Entity } {
  const box = engine.addEntity()
  Transform.create(box, {
    position: localPos,
    scale: Vector3.create(3, 0.8, 0.1),
    parent: parentEntity,
  })
  MeshRenderer.setBox(box)
  MeshCollider.setBox(box, ColliderLayer.CL_POINTER)
  Material.setPbrMaterial(box, {
    albedoColor: isActive ? TAB_ACTIVE_BG : TAB_INACTIVE_BG,
  })

  const labelEnt = engine.addEntity()
  Transform.create(labelEnt, {
    position: Vector3.create(0, 0, -0.6),
    scale: Vector3.create(1 / 3, 1 / 0.8, 1),
    parent: box,
  })
  TextShape.create(labelEnt, {
    text: label,
    fontSize: 4,
    textColor: isActive ? GOLD : MUTED,
    outlineColor: Color4.Black(),
    outlineWidth: 0.06,
    textAlign: TextAlignMode.TAM_MIDDLE_CENTER,
  })

  return { box, label: labelEnt }
}

function createNavButton(arrow: string, localPos: Vector3): { box: Entity; label: Entity } {
  const box = engine.addEntity()
  Transform.create(box, {
    position: localPos,
    scale: Vector3.create(0.7, 0.7, 0.1),
    parent: parentEntity,
  })
  MeshRenderer.setSphere(box)
  MeshCollider.setSphere(box, ColliderLayer.CL_POINTER)
  Material.setPbrMaterial(box, { albedoColor: TAB_INACTIVE_BG })

  const labelEnt = engine.addEntity()
  Transform.create(labelEnt, {
    position: Vector3.create(0, 0, -0.6),
    scale: Vector3.create(1 / 0.7, 1 / 0.7, 1),
    parent: box,
  })
  TextShape.create(labelEnt, {
    text: arrow,
    fontSize: 4,
    textColor: WHITE,
    outlineColor: Color4.Black(),
    outlineWidth: 0.06,
    textAlign: TextAlignMode.TAM_MIDDLE_CENTER,
  })

  return { box, label: labelEnt }
}

function updateBoard(): void {
  const allEntries = activeTab === 'daily' ? getLeaderboardEntries() : getAllTimeLeaderboardEntries()

  // Clamp page offset
  if (pageOffset >= allEntries.length) pageOffset = Math.max(0, allEntries.length - MAX_ROWS)
  if (pageOffset < 0) pageOffset = 0

  const top = allEntries.slice(pageOffset, pageOffset + MAX_ROWS)

  // Skip update if nothing changed
  const newText = activeTab + '|' + pageOffset + '|' + top.map(e => `${e.name}:${e.roundsWon}`).join(',')
  if (newText === lastRenderedText) return
  lastRenderedText = newText

  // Title
  TextShape.getMutable(titleEntity).text = 'LEADERBOARD'

  // Tab styling
  Material.setPbrMaterial(dailyTabEntity, { albedoColor: activeTab === 'daily' ? TAB_ACTIVE_BG : TAB_INACTIVE_BG })
  Material.setPbrMaterial(alltimeTabEntity, { albedoColor: activeTab === 'alltime' ? TAB_ACTIVE_BG : TAB_INACTIVE_BG })
  TextShape.getMutable(dailyTabLabel).textColor = activeTab === 'daily' ? GOLD : MUTED
  TextShape.getMutable(alltimeTabLabel).textColor = activeTab === 'alltime' ? GOLD : MUTED

  // Rows — 3 columns
  for (let i = 0; i < MAX_ROWS; i++) {
    const rankTs = TextShape.getMutable(rankEntities[i])
    const nameTs = TextShape.getMutable(nameEntities[i])
    const winsTs = TextShape.getMutable(winsEntities[i])
    if (i < top.length) {
      const entry = top[i]
      const r = pageOffset + i + 1
      const color = r === 1 ? GOLD : r <= 3 ? Color4.create(0.9, 0.9, 0.95, 1) : WHITE
      const displayName = entry.name.length > 18 ? entry.name.slice(0, 16) + '..' : entry.name

      rankTs.text = `${r}.`
      rankTs.textColor = color
      nameTs.text = displayName
      nameTs.textColor = color
      winsTs.text = `${entry.roundsWon}`
      winsTs.textColor = color
    } else {
      rankTs.text = ''
      nameTs.text = ''
      winsTs.text = ''
    }
  }

  // Nav buttons — show/hide based on whether there are more pages
  const hasPrev = pageOffset > 0
  const hasNext = pageOffset + MAX_ROWS < allEntries.length
  const totalPages = Math.ceil(allEntries.length / MAX_ROWS)
  const currentPage = Math.floor(pageOffset / MAX_ROWS) + 1

  TextShape.getMutable(prevBtnLabel).textColor = hasPrev ? WHITE : MUTED
  Material.setPbrMaterial(prevBtnEntity, { albedoColor: hasPrev ? TAB_INACTIVE_BG : Color4.create(0.08, 0.08, 0.1, 0.4) })
  TextShape.getMutable(nextBtnLabel).textColor = hasNext ? WHITE : MUTED
  Material.setPbrMaterial(nextBtnEntity, { albedoColor: hasNext ? TAB_INACTIVE_BG : Color4.create(0.08, 0.08, 0.1, 0.4) })
  TextShape.getMutable(pageLabel).text = totalPages > 1 ? `${currentPage} / ${totalPages}` : ''
}
