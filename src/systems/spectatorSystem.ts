import {
  engine, Transform, inputSystem, InputAction, PointerEventType,
  GltfContainer, AudioSource,
  VirtualCamera, MainCamera, InputModifier, pointerEventsSystem
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'

// ── Castle center (target for look-at) ──
const CASTLE_CENTER = Vector3.create(250.75, 11, 255.5)

// ── Spectator State ──
let isSpectating = false
let camPosX = 256  // center of 512m scene
let camPosY = 80   // high up
let camPosZ = 256  // center of 512m scene

const CAM_MOVE_SPEED = 40  // meters per second
const CAM_MIN_Y = 10
const CAM_MAX_Y = 150

// Scene bounds
const SCENE_W = 512
const SCENE_D = 512

let spectatorCamEntity: ReturnType<typeof engine.addEntity>
let spectatorOrbEntity: ReturnType<typeof engine.addEntity>
let binocularsSoundEntity: ReturnType<typeof engine.addEntity> | null = null

function playBinocularsSound() {
  if (!binocularsSoundEntity) {
    binocularsSoundEntity = engine.addEntity()
    Transform.create(binocularsSoundEntity, { position: Vector3.create(0, 0, 0) })
    AudioSource.create(binocularsSoundEntity, {
      audioClipUrl: 'assets/sounds/binoculars.mp3',
      playing: false,
      loop: false,
      volume: 1.0,
      global: true
    })
  }
  const a = AudioSource.getMutable(binocularsSoundEntity)
  a.playing = false
  a.currentTime = 0
  a.playing = true
}

let exitGracePeriod = 0

export function isSpectatorMode(): boolean {
  return isSpectating
}

export function isSpectatorTransitioning(): boolean {
  return exitGracePeriod > 0
}

export function setupSpectator() {
  // ── Create the clickable spectator orb ──
  // Place it near scene spawn / center-ish, visible and inviting
  spectatorOrbEntity = engine.addEntity()
  Transform.create(spectatorOrbEntity, {
    position: Vector3.create(215.1, 12.1, 293.3),
    scale: Vector3.create(4.5, 4.5, 4.5),
    rotation: Quaternion.fromEulerDegrees(0, 180, 0)
  })
  GltfContainer.create(spectatorOrbEntity, {
    src: 'assets/models/scope.glb',
    visibleMeshesCollisionMask: 3,
    invisibleMeshesCollisionMask: 0
  })

  pointerEventsSystem.onPointerDown(
    { entity: spectatorOrbEntity, opts: { button: InputAction.IA_POINTER, hoverText: 'Spectate', maxDistance: 12 } },
    () => {
      if (!isSpectating) { playBinocularsSound(); enterSpectatorMode() }
    }
  )

  // Second scope at different location
  const spectatorOrb2 = engine.addEntity()
  Transform.create(spectatorOrb2, {
    position: Vector3.create(228.7, 17.1, 299.8),
    scale: Vector3.create(4.5, 4.5, 4.5),
    rotation: Quaternion.fromEulerDegrees(0, 300, 0)
  })
  GltfContainer.create(spectatorOrb2, {
    src: 'assets/models/scope.glb',
    visibleMeshesCollisionMask: 3,
    invisibleMeshesCollisionMask: 0
  })
  pointerEventsSystem.onPointerDown(
    { entity: spectatorOrb2, opts: { button: InputAction.IA_POINTER, hoverText: 'Spectate', maxDistance: 12 } },
    () => {
      if (!isSpectating) { playBinocularsSound(); enterSpectatorMode() }
    }
  )

  // Third scope
  const spectatorOrb3 = engine.addEntity()
  Transform.create(spectatorOrb3, {
    position: Vector3.create(259.7, 47.1, 303.9),
    scale: Vector3.create(4.5, 4.5, 4.5),
    rotation: Quaternion.fromEulerDegrees(0, 0, 0)
  })
  GltfContainer.create(spectatorOrb3, {
    src: 'assets/models/scope.glb',
    visibleMeshesCollisionMask: 3,
    invisibleMeshesCollisionMask: 0
  })
  pointerEventsSystem.onPointerDown(
    { entity: spectatorOrb3, opts: { button: InputAction.IA_POINTER, hoverText: 'Spectate', maxDistance: 12 } },
    () => {
      if (!isSpectating) { playBinocularsSound(); enterSpectatorMode() }
    }
  )

  // Fourth scope
  const spectatorOrb4 = engine.addEntity()
  Transform.create(spectatorOrb4, {
    position: Vector3.create(250, 17.1, 215.6),
    scale: Vector3.create(4.5, 4.5, 4.5),
    rotation: Quaternion.fromEulerDegrees(0, 0, 0)
  })
  GltfContainer.create(spectatorOrb4, {
    src: 'assets/models/scope.glb',
    visibleMeshesCollisionMask: 3,
    invisibleMeshesCollisionMask: 0
  })
  pointerEventsSystem.onPointerDown(
    { entity: spectatorOrb4, opts: { button: InputAction.IA_POINTER, hoverText: 'Spectate', maxDistance: 12 } },
    () => {
      if (!isSpectating) { playBinocularsSound(); enterSpectatorMode() }
    }
  )

  // ── Create look-at target (castle center) ──
  const lookTarget = engine.addEntity()
  Transform.create(lookTarget, { position: CASTLE_CENTER })

  // ── Create the VirtualCamera entity ──
  spectatorCamEntity = engine.addEntity()
  Transform.create(spectatorCamEntity, {
    position: Vector3.create(camPosX, camPosY, camPosZ)
  })
  VirtualCamera.create(spectatorCamEntity, {
    lookAtEntity: lookTarget,
    defaultTransition: { transitionMode: VirtualCamera.Transition.Speed(50.0) }
  })

  // ── Spectator movement system ──
  engine.addSystem(spectatorMovementSystem)
}

function enterSpectatorMode() {
  isSpectating = true

  // Reset camera to overview position – far enough back to see the whole castle
  camPosX = 256
  camPosY = 120
  camPosZ = 170

  updateCamTransform()

  // Activate virtual camera
  MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = spectatorCamEntity

  // Freeze player movement so WASD only moves the camera
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({
      disableAll: true
    })
  })
}

export function exitSpectatorMode() {
  if (!isSpectating) return
  isSpectating = false
  exitGracePeriod = 1.0 // hide UI for 1s while camera returns

  // Deactivate virtual camera
  MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined as any

  // Restore player movement
  if (InputModifier.has(engine.PlayerEntity)) {
    InputModifier.deleteFrom(engine.PlayerEntity)
  }
}

function updateCamTransform() {
  // Soft clamp to keep camera away from scene boundary walls
  camPosX = Math.max(5, Math.min(SCENE_W - 5, camPosX))
  camPosZ = Math.max(5, Math.min(SCENE_D - 5, camPosZ))
  camPosY = Math.max(CAM_MIN_Y, Math.min(CAM_MAX_Y, camPosY))

  // Push camera out if too close to the look-at origin
  const dxC = camPosX - CASTLE_CENTER.x
  const dzC = camPosZ - CASTLE_CENTER.z
  const distC = Math.sqrt(dxC * dxC + dzC * dzC)
  const MIN_CAM_DIST = 5
  if (distC < MIN_CAM_DIST && distC > 0.01) {
    camPosX = CASTLE_CENTER.x + (dxC / distC) * MIN_CAM_DIST
    camPosZ = CASTLE_CENTER.z + (dzC / distC) * MIN_CAM_DIST
  }

  const t = Transform.getMutable(spectatorCamEntity)
  t.position = Vector3.create(camPosX, camPosY, camPosZ)
}

function spectatorMovementSystem(dt: number) {
  if (exitGracePeriod > 0) exitGracePeriod -= dt
  if (!isSpectating) return

  // Exit with 1 key
  if (inputSystem.isTriggered(InputAction.IA_ACTION_3, PointerEventType.PET_DOWN)) {
    exitSpectatorMode()
    return
  }

  // Compute forward/right relative to castle target (like DCL camera)
  const dx = CASTLE_CENTER.x - camPosX
  const dz = CASTLE_CENTER.z - camPosZ
  const dist = Math.sqrt(dx * dx + dz * dz)
  const forwardX = dist > 0.1 ? dx / dist : 0
  const forwardZ = dist > 0.1 ? dz / dist : 1
  // Right is perpendicular to forward (rotated 90° clockwise)
  const rightX = forwardZ
  const rightZ = -forwardX

  // Limit orbit speed when close to castle to prevent spinning out of control.
  // At dist >= 40 use full speed; below that, scale down linearly (min 15% speed).
  const MIN_DIST = 5
  const FULL_SPEED_DIST = 40
  const strafeFactor = Math.max(0.15, Math.min(1, (dist - MIN_DIST) / (FULL_SPEED_DIST - MIN_DIST)))
  const strafeSpeed = CAM_MOVE_SPEED * strafeFactor

  // W = toward castle, S = away, A/D = strafe around it
  // Only move toward castle if beyond minimum distance
  if (inputSystem.isPressed(InputAction.IA_FORWARD) && dist > MIN_DIST) {
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

  // E = up, F = down
  if (inputSystem.isPressed(InputAction.IA_PRIMARY)) {
    camPosY += CAM_MOVE_SPEED * dt
  }
  if (inputSystem.isPressed(InputAction.IA_SECONDARY)) {
    camPosY -= CAM_MOVE_SPEED * dt
  }

  updateCamTransform()
}
