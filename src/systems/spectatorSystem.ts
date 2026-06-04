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
const CASTLE_CENTER = Vector3.create(250.75, 11, 255.5)
const CAM_MOVE_SPEED = 40
const CAM_MIN_Y = 10
const CAM_MAX_Y = 150
const SCENE_W = 512
const SCENE_D = 512
const FREE_CAM_SPEED = 50

// Follow-orbit settings
const FOLLOW_DEFAULT_DIST = 35  // default orbit distance from target
const FOLLOW_DEFAULT_HEIGHT = 25  // default height above target
const FOLLOW_MIN_DIST = 8
const FOLLOW_MAX_DIST = 80
const FOLLOW_LERP = 3.0  // smoothing for look-at target tracking

// ── Orbit State ──
let camPosX = 256
let camPosY = 80
let camPosZ = 256

// ── Free Move State ──
let freeCamX = 256
let freeCamY = 50
let freeCamZ = 256
let freeYaw = 0 // radians

// ── Follow-orbit State ──
// Camera orbits around the target at (followAngle, followDist, followHeight)
let followAngle = Math.PI  // radians, 0 = +Z from target
let followDist = FOLLOW_DEFAULT_DIST
let followHeight = FOLLOW_DEFAULT_HEIGHT
// Smoothed look-at target position
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
  createScope({ x: 215.1, y: 12.1, z: 293.3 }, 180)
  createScope({ x: 228.7, y: 17.1, z: 299.8 }, 300)
  createScope({ x: 259.7, y: 47.1, z: 303.9 }, 0)
  createScope({ x: 250, y: 17.1, z: 215.6 }, 0)

  // Look-at target entity (position updated per mode)
  lookTargetEntity = engine.addEntity()
  Transform.create(lookTargetEntity, { position: Vector3.create(CASTLE_CENTER.x, CASTLE_CENTER.y, CASTLE_CENTER.z) })

  // Virtual camera
  spectatorCamEntity = engine.addEntity()
  Transform.create(spectatorCamEntity, { position: Vector3.create(camPosX, camPosY, camPosZ) })
  VirtualCamera.create(spectatorCamEntity, {
    lookAtEntity: lookTargetEntity,
    defaultTransition: { transitionMode: VirtualCamera.Transition.Speed(50.0) }
  })

  registerSystem(spectatorMovementSystem)
}

function enterSpectatorMode() {
  spectatorState.active = true
  spectatorState.mode = 'orbit'
  spectatorState.followPlayerId = null
  spectatorState.followPlayerName = ''
  spectatorState.playerPickerOpen = false

  // Reset orbit cam
  camPosX = 256; camPosY = 120; camPosZ = 170
  // Reset free cam
  freeCamX = 256; freeCamY = 50; freeCamZ = 200; freeYaw = 0
  // Reset follow-orbit
  followAngle = Math.PI; followDist = FOLLOW_DEFAULT_DIST; followHeight = FOLLOW_DEFAULT_HEIGHT
  followLookX = 256; followLookY = 10; followLookZ = 256

  // Point look target at castle
  const lt = Transform.getMutable(lookTargetEntity)
  lt.position = Vector3.create(CASTLE_CENTER.x, CASTLE_CENTER.y, CASTLE_CENTER.z)

  updateCamTransformForMode()
  MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = spectatorCamEntity
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: true })
  })
}

export function exitSpectatorMode() {
  if (!spectatorState.active) return
  spectatorState.active = false
  spectatorState.playerPickerOpen = false
  exitGracePeriod = 1.0

  MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined as any
  if (InputModifier.has(engine.PlayerEntity)) {
    InputModifier.deleteFrom(engine.PlayerEntity)
  }
}

/** Switch spectator mode (called from UI) */
export function setSpectatorMode(mode: SpectatorMode) {
  if (!spectatorState.active) return
  spectatorState.mode = mode
  spectatorState.playerPickerOpen = false

  if (mode === 'orbit') {
    // Re-center orbit on castle
    camPosX = 256; camPosY = 120; camPosZ = 170
    const lt = Transform.getMutable(lookTargetEntity)
    lt.position = Vector3.create(CASTLE_CENTER.x, CASTLE_CENTER.y, CASTLE_CENTER.z)
  } else if (mode === 'flag') {
    // Will snap to flag on next frame
  } else if (mode === 'player') {
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
  updateCamTransformForMode()
}

/** Select a player to follow (called from UI) */
export function selectFollowPlayer(userId: string, name: string) {
  spectatorState.followPlayerId = userId
  spectatorState.followPlayerName = name
  spectatorState.playerPickerOpen = false
}

// ── Get flag world position ──
// When carried, the flag entity's Transform doesn't move (it's avatar-attached),
// so we follow the carrier's avatar position instead.
function getFlagPosition(): { x: number; y: number; z: number } | null {
  for (const [entity, flag] of engine.getEntitiesWith(Flag, Transform)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      // Follow the carrier's avatar
      const carrierPos = getPlayerAvatarPosition(flag.carrierPlayerId)
      if (carrierPos) return carrierPos
    }
    const t = Transform.get(entity)
    return { x: t.position.x, y: t.position.y, z: t.position.z }
  }
  return null
}

// ── Get a player's avatar entity & position by userId ──
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

function updateCamTransformForMode() {
  let pos: { x: number; y: number; z: number }
  if (spectatorState.mode === 'orbit') {
    pos = clampCam(camPosX, camPosY, camPosZ)
    camPosX = pos.x; camPosY = pos.y; camPosZ = pos.z
    // Push away from look-at if too close
    const dx = pos.x - CASTLE_CENTER.x
    const dz = pos.z - CASTLE_CENTER.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < 5 && dist > 0.01) {
      pos.x = CASTLE_CENTER.x + (dx / dist) * 5
      pos.z = CASTLE_CENTER.z + (dz / dist) * 5
      camPosX = pos.x; camPosZ = pos.z
    }
  } else {
    // flag & player modes: compute camera pos from orbit params around look-at
    const rawX = followLookX + Math.sin(followAngle) * followDist
    const rawZ = followLookZ + Math.cos(followAngle) * followDist
    const rawY = followLookY + followHeight
    pos = clampCam(rawX, rawY, rawZ)
  }
  const t = Transform.getMutable(spectatorCamEntity)
  t.position = Vector3.create(pos.x, pos.y, pos.z)
}

function spectatorMovementSystem(dt: number) {
  if (exitGracePeriod > 0) exitGracePeriod -= dt
  if (!spectatorState.active) return

  // Exit with 1 key
  if (inputSystem.isTriggered(InputAction.IA_ACTION_3, PointerEventType.PET_DOWN)) {
    exitSpectatorMode()
    return
  }

  const mode = spectatorState.mode

  if (mode === 'orbit') {
    updateOrbitMode(dt)
  } else if (mode === 'flag') {
    updateFollowFlagMode(dt)
  } else if (mode === 'player') {
    updateFollowPlayerMode(dt)
  }
}

// ── ORBIT MODE (existing behavior) ──
function updateOrbitMode(dt: number) {
  const dx = CASTLE_CENTER.x - camPosX
  const dz = CASTLE_CENTER.z - camPosZ
  const dist = Math.sqrt(dx * dx + dz * dz)
  const forwardX = dist > 0.1 ? dx / dist : 0
  const forwardZ = dist > 0.1 ? dz / dist : 1
  const rightX = forwardZ
  const rightZ = -forwardX

  const strafeFactor = Math.max(0.15, Math.min(1, (dist - 5) / 35))
  const strafeSpeed = CAM_MOVE_SPEED * strafeFactor

  if (inputSystem.isPressed(InputAction.IA_FORWARD) && dist > 5) {
    camPosX += forwardX * CAM_MOVE_SPEED * dt
    camPosZ += forwardZ * CAM_MOVE_SPEED * dt
  }
  if (inputSystem.isPressed(InputAction.IA_BACKWARD)) {
    camPosX -= forwardX * CAM_MOVE_SPEED * dt
    camPosZ -= forwardZ * CAM_MOVE_SPEED * dt
  }
  if (inputSystem.isPressed(InputAction.IA_LEFT)) {
    camPosX -= rightX * strafeSpeed * dt
    camPosZ -= rightZ * strafeSpeed * dt
  }
  if (inputSystem.isPressed(InputAction.IA_RIGHT)) {
    camPosX += rightX * strafeSpeed * dt
    camPosZ += rightZ * strafeSpeed * dt
  }
  if (inputSystem.isPressed(InputAction.IA_PRIMARY)) camPosY += CAM_MOVE_SPEED * dt
  if (inputSystem.isPressed(InputAction.IA_SECONDARY)) camPosY -= CAM_MOVE_SPEED * dt

  // Look-at stays at castle
  const lt = Transform.getMutable(lookTargetEntity)
  lt.position = Vector3.create(CASTLE_CENTER.x, CASTLE_CENTER.y, CASTLE_CENTER.z)

  updateCamTransformForMode()
}

// ── Shared orbit-follow logic for flag & player modes ──
function updateFollowOrbit(dt: number, targetPos: { x: number; y: number; z: number } | null) {
  if (!targetPos) {
    // No target — orbit castle center
    targetPos = { x: CASTLE_CENTER.x, y: CASTLE_CENTER.y, z: CASTLE_CENTER.z }
  }

  // Smooth the look-at target so camera doesn't jerk
  const lerpF = Math.min(1, FOLLOW_LERP * dt)
  followLookX += (targetPos.x - followLookX) * lerpF
  followLookY += (targetPos.y - followLookY) * lerpF
  followLookZ += (targetPos.z - followLookZ) * lerpF

  // Orbit controls: A/D rotate, W/S zoom, E/F height
  if (inputSystem.isPressed(InputAction.IA_LEFT))  followAngle -= 1.5 * dt
  if (inputSystem.isPressed(InputAction.IA_RIGHT)) followAngle += 1.5 * dt
  if (inputSystem.isPressed(InputAction.IA_FORWARD))  followDist = Math.max(FOLLOW_MIN_DIST, followDist - CAM_MOVE_SPEED * dt)
  if (inputSystem.isPressed(InputAction.IA_BACKWARD)) followDist = Math.min(FOLLOW_MAX_DIST, followDist + CAM_MOVE_SPEED * dt)
  if (inputSystem.isPressed(InputAction.IA_PRIMARY))   followHeight += CAM_MOVE_SPEED * dt
  if (inputSystem.isPressed(InputAction.IA_SECONDARY)) followHeight = Math.max(2, followHeight - CAM_MOVE_SPEED * dt)

  // Update look-at entity
  const lt = Transform.getMutable(lookTargetEntity)
  lt.position = Vector3.create(followLookX, followLookY + 1.5, followLookZ)

  updateCamTransformForMode()
}

// ── FOLLOW FLAG MODE ──
function updateFollowFlagMode(dt: number) {
  updateFollowOrbit(dt, getFlagPosition())
}

// ── FOLLOW PLAYER MODE ──
function updateFollowPlayerMode(dt: number) {
  const targetPos = spectatorState.followPlayerId
    ? getPlayerAvatarPosition(spectatorState.followPlayerId)
    : null
  updateFollowOrbit(dt, targetPos)
}
