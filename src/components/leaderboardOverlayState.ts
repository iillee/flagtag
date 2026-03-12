import { engine, Schemas } from '@dcl/sdk/ecs'

const LeaderboardOverlayStateSchema = {
  visible: Schemas.Boolean
}

export const LeaderboardOverlayState = engine.defineComponent(
  'ctf-leaderboard-overlay',
  LeaderboardOverlayStateSchema,
  { visible: false }
)

let overlayEntity: ReturnType<typeof engine.addEntity> | null = null

function setOverlayEntity(entity: ReturnType<typeof engine.addEntity>) {
  overlayEntity = entity
}

function getEntity() {
  if (overlayEntity === null) return null
  if (!LeaderboardOverlayState.has(overlayEntity)) return null
  return overlayEntity
}

export function getLeaderboardOverlayVisible(): boolean {
  const e = getEntity()
  if (!e) return false
  return LeaderboardOverlayState.get(e).visible
}

export function setLeaderboardOverlayVisible(visible: boolean) {
  const e = getEntity()
  if (!e) return
  const mutable = LeaderboardOverlayState.getMutable(e)
  mutable.visible = visible
}

export function toggleLeaderboardOverlay() {
  const e = getEntity()
  if (!e) return
  const mutable = LeaderboardOverlayState.getMutable(e)
  mutable.visible = !mutable.visible
}

export function createLeaderboardOverlayEntity() {
  const entity = engine.addEntity()
  LeaderboardOverlayState.create(entity, { visible: false })
  setOverlayEntity(entity)
  return entity
}
