import {
  engine, Transform, inputSystem, InputAction, PointerEventType,
  GltfContainer, AudioSource,
  VirtualCamera, MainCamera, InputModifier, pointerEventsSystem,
  PlayerIdentityData
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'

import { spectatorState, type SpectatorMode } from '../shared/clientState'
import { registerSystem } from './systemManager'
import { Flag, FlagState } from '../shared/components'
import { getPlayersWithHoldTimes, getCurrentFlagCarrierUserId } from '../gameState/flagHoldTime'

// ── Constants ──
const CASTLE_CENTER = Vector3.create(420.75, 11, 397.5)
const CAM_MOVE_SPEED = 40
const CAM_MIN_Y = 10
const CAM_MAX_Y = 150
const SCENE_W = 512
const SCENE_D = 512

// Follow-orbit settings
const FOLLOW_DEFAULT_DIST = 35
const FOLLOW_DEFAULT_HEIGHT = 25
const FOLLOW_MIN_DIST = 8
const FOLLOW_MAX_DIST = 80
const FOLLOW_LERP = 3.0

// ── Follow-orbit State ──
let followAngle = Math.PI
let followDist = FOLLOW_DEFAULT_DIST
let followHeight = FOLLOW_DEFAULT_HEIGHT
let followLookX = 256
let followLookY = 10
let followLookZ = 256

// ── Entities ──
let spectatorCamEntity: ReturnType<typeof engine.addEntity>
let lookTargetEntity: ReturnType<typeof engine.addEntity>
let binocularsSoundEntity: ReturnType<typeof engine.addEntity> | null = null

let exitGracePeriod = 0

function playBinocularsSound() {
  if (!binocularsSoundEntity) {
    binocularsSoundEntity = engine.addEntity()
    Transform.create(binocularsSoundEntity, { position: Vector3.create(0, 0, 0) })
    AudioSource.create(binocularsSoundEntity, {
      audioClipUrl: 'assets/sounds/binoculars.mp3',
      playing: false, loop: false, volume: 1.0, global: true
    })
  }
  AudioSource.createOrReplace(binocularsSoundEntity, {
    audioClipUrl: 'assets/sounds/binoculars.mp3',
    playing: true, loop: false, volume: 1, global: true
  })
}

export function isSpectatorMode(): boolean {
  return spectatorState.active
}

export function isSpectatorTransitioning(): boolean {
  return exitGracePeriod > 0
}

// ── Scope placement helper ──
function createScope(pos: { x: number; y: number; z: number }, rotY: number) {
  const entity = engine.addEntity()
  Transform.create(entity, {
    position: Vector3.create(pos.x, pos.y, pos.z),
    scale: Vector3.create(4.5, 4.5, 4.5),
    rotation: Quaternion.fromEulerDegrees(0, rotY, 0)
  })
  GltfContainer.create(entity, {
    src: 'assets/models/scope.glb',
    visibleMeshesCollisionMask: 3,
    invisibleMeshesCollisionMask: 0
  })
  pointerEventsSystem.onPointerDown(
    { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Spectate', maxDistance: 12 } },
    () => { if (!spectatorState.active) { playBinocularsSound(); enterSpectatorMode() } }
  )
}

export function setupSpectator() {
  // Place scopes
  createScope({ x: 385.1, y: 12.1, z: 435.3 }, 180)
  createScope({ x: 398.7, y: 17.1, z: 441.8 }, 300)
  createScope({ x: 429.7, y: 47.1, z: 445.9 }, 0)
  createScope({ x: 420, y: 17.1, z: 357.6 }, 0)

  // Look-at target entity
  lookTargetEntity = engine.addEntity()
  Transform.create(lookTargetEntity, { position: Vector3.create(CASTLE_CENTER.x, CASTLE_CENTER.y, CASTLE_CENTER.z) })

  // Virtual camera
  spectatorCamEntity = engine.addEntity()
  Transform.create(spectatorCamEntity, { position: Vector3.create(426, 80, 398) })
  VirtualCamera.create(spectatorCamEntity, {
    lookAtEntity: lookTargetEntity,
    defaultTransition: { transitionMode: VirtualCamera.Transition.Speed(50.0) }
  })

  registerSystem(spectatorMovementSystem)
}

function enterSpectatorMode() {
  spectatorState.active = true
  spectatorState.mode = 'flag'
  spectatorState.followPlayerId = null
  spectatorState.followPlayerName = ''
  spectatorState.playerPickerOpen = false

  // Reset follow-orbit
  followAngle = Math.PI
  followDist = FOLLOW_DEFAULT_DIST
  followHeight = FOLLOW_DEFAULT_HEIGHT
  followLookX = 256; followLookY = 10; followLookZ = 256

  // Point look target at castle initially
  const lt = Transform.getMutable(lookTargetEntity)
  lt.position = Vector3.create(CASTLE_CENTER.x, CASTLE_CENTER.y, CASTLE_CENTER.z)

  updateCamTransform()
  MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = spectatorCamEntity
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: true })
  })
}

/** Switch spectator mode (called from UI) */
export function setSpectatorMode(mode: SpectatorMode) {
  if (!spectatorState.active) return
  spectatorState.mode = mode
  spectatorState.playerPickerOpen = false

  if (mode === 'player') {
    spectatorState.playerPickerOpen = true
    // Auto-select flag carrier if any
    const carrier = getCurrentFlagCarrierUserId()
    if (carrier) {
      const players = getPlayersWithHoldTimes()
      const p = players.find(pl => pl.userId.toLowerCase() === carrier.toLowerCase())
      if (p) {
        spectatorState.followPlayerId = p.userId
        spectatorState.followPlayerName = p.name
        spectatorState.playerPickerOpen = false
      }
    }
  }
  updateCamTransform()
}

/** Select a player to follow (called from UI) */
export function selectFollowPlayer(userId: string, name: string) {
  spectatorState.followPlayerId = userId
  spectatorState.followPlayerName = name
  spectatorState.playerPickerOpen = false
}

export function exitSpectatorMode() {
  if (!spectatorState.active) return
  spectatorState.active = false
  spectatorState.playerPickerOpen = false
  exitGracePeriod = 1.0

  try {
    MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined as any
  } catch (_e) { /* camera entity may not have MainCamera on mobile */ }
  try {
    if (InputModifier.has(engine.PlayerEntity)) {
      InputModifier.deleteFrom(engine.PlayerEntity)
    }
  } catch (_e) { /* guard against missing component */ }
}

// ── Get flag world position ──
function getFlagPosition(): { x: number; y: number; z: number } | null {
  for (const [entity, flag] of engine.getEntitiesWith(Flag, Transform)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      const carrierPos = getPlayerAvatarPosition(flag.carrierPlayerId)
      if (carrierPos) return carrierPos
    }
    const t = Transform.get(entity)
    return { x: t.position.x, y: t.position.y, z: t.position.z }
  }
  return null
}

function getPlayerAvatarPosition(userId: string): { x: number; y: number; z: number } | null {
  for (const [entity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    const pid = PlayerIdentityData.get(entity)
    if (pid.address.toLowerCase() === userId.toLowerCase()) {
      const t = Transform.get(entity)
      return { x: t.position.x, y: t.position.y, z: t.position.z }
    }
  }
  return null
}

// ── Camera transform helpers ──
function clampCam(x: number, y: number, z: number) {
  return {
    x: Math.max(5, Math.min(SCENE_W - 5, x)),
    y: Math.max(CAM_MIN_Y, Math.min(CAM_MAX_Y, y)),
    z: Math.max(5, Math.min(SCENE_D - 5, z))
  }
}

function updateCamTransform() {
  const rawX = followLookX + Math.sin(followAngle) * followDist
  const rawZ = followLookZ + Math.cos(followAngle) * followDist
  const rawY = followLookY + followHeight
  const pos = clampCam(rawX, rawY, rawZ)
  const t = Transform.getMutable(spectatorCamEntity)
  t.position = Vector3.create(pos.x, pos.y, pos.z)
}

function spectatorMovementSystem(dt: number) {
  if (exitGracePeriod > 0) exitGracePeriod -= dt
  if (!spectatorState.active) return



  const mode = spectatorState.mode

  // Get target position based on mode
  let targetPos: { x: number; y: number; z: number } | null = null
  if (mode === 'player' && spectatorState.followPlayerId) {
    targetPos = getPlayerAvatarPosition(spectatorState.followPlayerId)
  }
  if (!targetPos) {
    targetPos = getFlagPosition()
  }
  if (!targetPos) {
    targetPos = { x: CASTLE_CENTER.x, y: CASTLE_CENTER.y, z: CASTLE_CENTER.z }
  }

  // Smooth the look-at target
  const lerpF = Math.min(1, FOLLOW_LERP * dt)
  followLookX += (targetPos.x - followLookX) * lerpF
  followLookY += (targetPos.y - followLookY) * lerpF
  followLookZ += (targetPos.z - followLookZ) * lerpF

  // Orbit controls: A/D rotate, W/S zoom, E/F height
  const ORBIT_SPEED = 0.75
  if (inputSystem.isPressed(InputAction.IA_LEFT))  followAngle += ORBIT_SPEED * dt
  if (inputSystem.isPressed(InputAction.IA_RIGHT)) followAngle -= ORBIT_SPEED * dt
  if (inputSystem.isPressed(InputAction.IA_FORWARD))  followDist = Math.max(FOLLOW_MIN_DIST, followDist - followDist * ORBIT_SPEED * dt)
  if (inputSystem.isPressed(InputAction.IA_BACKWARD)) followDist = Math.min(FOLLOW_MAX_DIST, followDist + followDist * ORBIT_SPEED * dt)
  if (inputSystem.isPressed(InputAction.IA_PRIMARY))   followHeight += followHeight * ORBIT_SPEED * dt
  if (inputSystem.isPressed(InputAction.IA_SECONDARY)) followHeight = Math.max(2, followHeight - followHeight * ORBIT_SPEED * dt)

  // Update look-at entity
  const lt = Transform.getMutable(lookTargetEntity)
  lt.position = Vector3.create(followLookX, followLookY + 1.5, followLookZ)

  updateCamTransform()
}
