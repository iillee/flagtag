/**
 * interiorSystem.ts — Interior room prototype.
 *
 * A single room high in the sky (Y=180) with a fixed overhead VirtualCamera.
 * Players click a door to fade-in, teleport up, and enter the room.
 * Clicking the exit door fades out and returns them to their original position.
 */
import {
  engine, Entity, Transform, MeshRenderer, MeshCollider, Material,
  Animator, Tween, TweenSequence, EasingFunction,
  GltfContainer, VirtualCamera, MainCamera, CameraModeArea, CameraType,
  pointerEventsSystem, InputAction, AudioSource, VisibilityComponent,
  TriggerArea, triggerAreaEventsSystem,
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import { registerSystem } from './systemManager'
import { setCinematicFade, cinematicState } from '../ui'
import { setInteriorBypass, setWaterSurfaceY } from './waterSystem'
import { room } from '../shared/messages'
import { Flag, FlagState } from '../shared/components'
import { getPlayer } from '@dcl/sdk/players'
import { INTERIOR_COIN_LOCATIONS } from '../shared/coinLocations'
import {
  INTERIOR_CENTER,
  INTERIOR_ROTATION_DEG,
  rotateAroundInteriorCenter,
} from '../shared/interiorGeometry'

// ── Config ──

/** Position of the entry door in the world (the wooden door entity 708) */
const ENTRY_DOOR_POS = Vector3.create(352.56, 50.26, 353.49)
const ENTRY_DOOR_INTERACT_DIST = 6

/** Interior room center — dedicated interior level at Y=0, with plenty of room for many interiors */
const ROOM_CENTER = Vector3.create(INTERIOR_CENTER.x, INTERIOR_CENTER.y, INTERIOR_CENTER.z)
const ROOM_SIZE = 10       // meters square
const ROOM_WALL_H = 4      // wall height
const ROOM_FLOOR_Y = ROOM_CENTER.y - 0.05

/** Room rotation in degrees (clockwise positive) */
const ROOM_ROT_DEG = INTERIOR_ROTATION_DEG

/** Rotate a world position around ROOM_CENTER on the XZ plane */
function rotPos(x: number, y: number, z: number): { x: number; y: number; z: number } {
  return rotateAroundInteriorCenter(x, y, z)
}

/** Y-axis rotation quaternion for the room angle */
const ROOM_QUAT = Quaternion.fromEulerDegrees(0, ROOM_ROT_DEG, 0)
function combineRot(base: { x: number; y: number; z: number; w: number }) {
  return Quaternion.multiply(ROOM_QUAT, base)
}

/** Camera offset from room center (west + elevated for isometric 3/4 view). Y is RELATIVE to ROOM_CENTER.y. */
const CAM_OFFSET_RAW = Vector3.create(-6, 10.4, 0)
const CAM_OFFSET = rotPos(ROOM_CENTER.x + CAM_OFFSET_RAW.x, ROOM_CENTER.y + CAM_OFFSET_RAW.y, ROOM_CENTER.z + CAM_OFFSET_RAW.z)

/** Player spawn inside the vestibule (west side), facing east into the room */
const _spawnRaw = rotPos(ROOM_CENTER.x - ROOM_SIZE / 2 - 0.5, ROOM_CENTER.y, ROOM_CENTER.z)
const ROOM_SPAWN = Vector3.create(_spawnRaw.x, _spawnRaw.y, _spawnRaw.z)
const ROOM_SPAWN_LOOK = Vector3.create(ROOM_CENTER.x, ROOM_CENTER.y + 1, ROOM_CENTER.z)

// ── State ──

let isInInterior = false
export function getIsInInterior(): boolean { return isInInterior }
let savedReturnPos: { x: number; y: number; z: number } | null = null
let fadeState: 'none' | 'fading-in' | 'fading-out' = 'none'
let fadeTimer = 0
const FADE_DURATION = 0.5

// ── Entities ──
let interiorCam: Entity
let roomEntities: Entity[] = []
let exitDoorEntity: Entity
let entryClickEntity: Entity
let cameraModeArea: Entity
let initialized = false

function createWall(x: number, y: number, z: number, sx: number, sy: number, sz: number): Entity {
  const wall = engine.addEntity()
  const rp = rotPos(x, y, z)
  Transform.create(wall, {
    position: Vector3.create(rp.x, rp.y, rp.z),
    scale: Vector3.create(sx, sy, sz),
    rotation: ROOM_QUAT,
  })
  MeshRenderer.setBox(wall)
  MeshCollider.setBox(wall)
  Material.setPbrMaterial(wall, {
    albedoColor: Color4.create(0.35, 0.3, 0.25, 1),
    roughness: 0.9,
    metallic: 0.0,
  })
  roomEntities.push(wall)
  return wall
}

function buildRoom(): void {
  const cx = ROOM_CENTER.x
  const cy = ROOM_CENTER.y
  const cz = ROOM_CENTER.z
  const half = ROOM_SIZE / 2
  const wallY = cy + ROOM_WALL_H / 2

  // Floor (center doesn't move, just needs rotation)
  const floor = engine.addEntity()
  Transform.create(floor, {
    position: Vector3.create(cx, ROOM_FLOOR_Y, cz),
    scale: Vector3.create(ROOM_SIZE, 0.1, ROOM_SIZE),
    rotation: ROOM_QUAT,
  })
  MeshRenderer.setBox(floor)
  MeshCollider.setBox(floor)
  Material.setPbrMaterial(floor, {
    albedoColor: Color4.create(0.4, 0.35, 0.28, 1),
    roughness: 0.95,
  })
  roomEntities.push(floor)

  // Skirt helper (defined early so vestibule can use it)
  const SKIRT_EXT = 13.5
  const SKIRT_Y = cy + ROOM_WALL_H + 0.05
  const skirtColor = Color4.create(0.04, 0.04, 0.05, 1)
  const skirtMat = { albedoColor: skirtColor, roughness: 1, metallic: 0 }
  const skirtWidth = ROOM_SIZE + SKIRT_EXT * 2

  function addSkirt(x: number, z: number, sx: number, sz: number) {
    const e = engine.addEntity()
    const rp = rotPos(x, SKIRT_Y, z)
    Transform.create(e, { position: Vector3.create(rp.x, rp.y, rp.z), scale: Vector3.create(sx, 0.05, sz), rotation: ROOM_QUAT })
    MeshRenderer.setBox(e); Material.setPbrMaterial(e, skirtMat)
    roomEntities.push(e)
  }

  // Walls: north, south, east (solid), west (split for vestibule)
  // North wall
  createWall(cx, wallY, cz + half, ROOM_SIZE, ROOM_WALL_H, 0.2)
  // South wall
  createWall(cx, wallY, cz - half, ROOM_SIZE, ROOM_WALL_H, 0.2)
  // East wall
  createWall(cx + half, wallY, cz, 0.2, ROOM_WALL_H, ROOM_SIZE)

  // West wall — two halves with gap for vestibule entrance
  const VEST_WIDTH = 2
  const westSideH = (ROOM_SIZE - VEST_WIDTH) / 2
  createWall(cx - half, wallY, cz + VEST_WIDTH / 2 + westSideH / 2, 0.2, ROOM_WALL_H, westSideH)
  createWall(cx - half, wallY, cz - VEST_WIDTH / 2 - westSideH / 2, 0.2, ROOM_WALL_H, westSideH)

  // ── Vestibule — small indent extending 2m west from west wall center ──
  const VEST_DEPTH = 2
  const vestX = cx - half - VEST_DEPTH / 2

  // Vestibule floor
  const vestFloor = engine.addEntity()
  const vfp = rotPos(vestX, ROOM_FLOOR_Y, cz)
  Transform.create(vestFloor, {
    position: Vector3.create(vfp.x, vfp.y, vfp.z),
    scale: Vector3.create(VEST_DEPTH, 0.1, VEST_WIDTH + 0.4),
    rotation: ROOM_QUAT,
  })
  MeshRenderer.setBox(vestFloor); MeshCollider.setBox(vestFloor)
  Material.setPbrMaterial(vestFloor, { albedoColor: Color4.create(0.4, 0.35, 0.28, 1), roughness: 0.95 })
  roomEntities.push(vestFloor)

  // Vestibule north wall
  createWall(vestX, wallY, cz + VEST_WIDTH / 2, VEST_DEPTH, ROOM_WALL_H, 0.2)
  // Vestibule south wall
  createWall(vestX, wallY, cz - VEST_WIDTH / 2, VEST_DEPTH, ROOM_WALL_H, 0.2)
  // Vestibule west wall (exit end)
  const vestWestX = cx - half - VEST_DEPTH
  createWall(vestWestX, wallY, cz, 0.2, ROOM_WALL_H, VEST_WIDTH + 0.4)

  // Vestibule skirt planes (3 sides: west, north, south) — 5m
  const VEST_SKIRT = 5
  addSkirt(vestWestX - VEST_SKIRT / 2, cz, VEST_SKIRT, VEST_WIDTH + VEST_SKIRT * 2)
  addSkirt(vestX, cz + VEST_WIDTH / 2 + VEST_SKIRT / 2, VEST_DEPTH, VEST_SKIRT)
  addSkirt(vestX, cz - VEST_WIDTH / 2 - VEST_SKIRT / 2, VEST_DEPTH, VEST_SKIRT)

  // Exit trigger area — walk into the vestibule west wall to exit
  exitDoorEntity = engine.addEntity()
  const etp = rotPos(vestWestX, cy + 1.2, cz)
  Transform.create(exitDoorEntity, {
    position: Vector3.create(etp.x, etp.y, etp.z),
    scale: Vector3.create(0.8, 2.4, VEST_WIDTH),
    rotation: ROOM_QUAT,
  })
  TriggerArea.setBox(exitDoorEntity)
  triggerAreaEventsSystem.onTriggerEnter(exitDoorEntity, () => {
    exitInterior()
  })
  roomEntities.push(exitDoorEntity)

  // Isometric 3/4 camera (west of room, looking east)
  interiorCam = engine.addEntity()
  const lookTarget = engine.addEntity()
  Transform.create(lookTarget, { position: Vector3.create(cx, cy + 1, cz) })
  Transform.create(interiorCam, {
    position: Vector3.create(CAM_OFFSET.x, CAM_OFFSET.y, CAM_OFFSET.z),
  })
  VirtualCamera.create(interiorCam, {
    lookAtEntity: lookTarget,
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.3) },
  })
  roomEntities.push(interiorCam)
  roomEntities.push(lookTarget)

  // Main room skirts (4 sides)
  // East
  addSkirt(cx + half + SKIRT_EXT / 2, cz, SKIRT_EXT, ROOM_SIZE)
  // West — two pieces flanking the vestibule opening
  const vestHalfW = VEST_WIDTH / 2
  addSkirt(cx - half - SKIRT_EXT / 2, cz + vestHalfW + (half - vestHalfW) / 2, SKIRT_EXT, half - vestHalfW)
  addSkirt(cx - half - SKIRT_EXT / 2, cz - vestHalfW - (half - vestHalfW) / 2, SKIRT_EXT, half - vestHalfW)
  // North
  addSkirt(cx, cz + half + SKIRT_EXT / 2, skirtWidth, SKIRT_EXT)
  // South
  addSkirt(cx, cz - half - SKIRT_EXT / 2, skirtWidth, SKIRT_EXT)

  // Camera mode area — force 3rd person inside the room
  cameraModeArea = engine.addEntity()
  Transform.create(cameraModeArea, {
    position: Vector3.create(cx, cy + ROOM_WALL_H / 2, cz),
    rotation: ROOM_QUAT,
  })
  CameraModeArea.create(cameraModeArea, {
    area: Vector3.create(ROOM_SIZE + 2, ROOM_WALL_H + 4, ROOM_SIZE + 2),
    mode: CameraType.CT_THIRD_PERSON,
  })
  roomEntities.push(cameraModeArea)

  // ── Treasure coins ──
  const COIN_SRC = 'assets/asset-packs/doubloon/Coin_01/Coin_01.glb'
  for (const pos of INTERIOR_COIN_LOCATIONS) {
    const coin = engine.addEntity()
    Transform.create(coin, {
      position: Vector3.create(pos.x, pos.y, pos.z),
      scale: Vector3.create(10, 10, 10),
      rotation: combineRot(Quaternion.fromEulerDegrees(90, 0, 0)),
    })
    GltfContainer.create(coin, { src: COIN_SRC })
    roomEntities.push(coin)
  }
  console.log('[Interior] Spawned', INTERIOR_COIN_LOCATIONS.length, 'treasure coins')

  // ── Lever (placed at room center, code-managed) ──
  const leverEntity = engine.addEntity()
  const leverPos = rotPos(ROOM_CENTER.x, ROOM_CENTER.y, ROOM_CENTER.z)
  Transform.create(leverEntity, {
    position: Vector3.create(leverPos.x, leverPos.y, leverPos.z),
    scale: Vector3.create(1, 1, 1),
    rotation: ROOM_QUAT,
  })
  GltfContainer.create(leverEntity, {
    src: 'assets/asset-packs/pirate_lever/lever_pirates.glb',
    visibleMeshesCollisionMask: 1,
    invisibleMeshesCollisionMask: 3,
  })
  Animator.create(leverEntity, {
    states: [
      { clip: 'activate', playing: false, loop: false },
      { clip: 'deactivate', playing: false, loop: false },
    ]
  })
  roomEntities.push(leverEntity)
  _leverEntity = leverEntity
  console.log('[Interior] Lever placed at room center')
}

function buildEntryTrigger(): void {
  // Find the wooden door entity placed in the composite and attach click to it directly
  const DOOR_SRC = 'assets/asset-packs/wooden_door/Door_Wood_01/Door_Wood_01.glb'
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const gltf = GltfContainer.get(entity)
    if (gltf.src === DOOR_SRC) {
      entryClickEntity = entity
      // Ensure it has a pointer collider
      GltfContainer.createOrReplace(entity, {
        ...gltf,
        visibleMeshesCollisionMask: 1,
        invisibleMeshesCollisionMask: 3,
      })
      pointerEventsSystem.onPointerDown(
        {
          entity,
          opts: { button: InputAction.IA_POINTER, hoverText: 'Enter', maxDistance: ENTRY_DOOR_INTERACT_DIST },
        },
        () => { enterInterior() }
      )
      console.log('[Interior] Attached enter trigger to wooden door entity')
      return
    }
  }
  console.error('[Interior] Wooden door not found, creating fallback click entity')
  // Fallback: invisible clickable box
  entryClickEntity = engine.addEntity()
  Transform.create(entryClickEntity, {
    position: Vector3.create(ENTRY_DOOR_POS.x, ENTRY_DOOR_POS.y + 1.2, ENTRY_DOOR_POS.z),
    scale: Vector3.create(2.5, 3.5, 1.2),
  })
  MeshCollider.setBox(entryClickEntity)
  pointerEventsSystem.onPointerDown(
    {
      entity: entryClickEntity,
      opts: { button: InputAction.IA_POINTER, hoverText: 'Enter', maxDistance: ENTRY_DOOR_INTERACT_DIST },
    },
    () => { enterInterior() }
  )
}

// ── Enter / Exit ──

function enterInterior(): void {
  if (isInInterior || fadeState !== 'none') return
  if (cinematicState.showing) return // don't allow during round-end cinematic

  // Play door sound (local)
  if (entryClickEntity) {
    AudioSource.createOrReplace(entryClickEntity, {
      audioClipUrl: 'assets/sounds/door.mp3',
      playing: true, loop: false, volume: 1.0, global: true
    })
  }

  // Drop the flag if carrying
  const localUserId = getPlayer()?.userId ?? ''
  for (const [, flag] of engine.getEntitiesWith(Flag)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId === localUserId) {
      room.send('requestDrop', { t: 0 })
      break
    }
  }

  // Save return position
  const playerPos = Transform.get(engine.PlayerEntity).position
  savedReturnPos = { x: playerPos.x, y: playerPos.y, z: playerPos.z }

  fadeState = 'fading-in'
  fadeTimer = 0
}

function exitInterior(): void {
  if (!isInInterior || fadeState !== 'none') return

  fadeState = 'fading-out'
  fadeTimer = 0
}

function activateInteriorCamera(): void {
  MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = interiorCam
}

function deactivateInteriorCamera(): void {
  const mc = MainCamera.getMutable(engine.CameraEntity)
  mc.virtualCameraEntity = undefined as any
}

// ── System ──

function interiorFadeSystem(dt: number): void {
  if (fadeState === 'none') return

  fadeTimer += dt

  if (fadeState === 'fading-in') {
    // Phase 1: fade to black
    if (fadeTimer <= FADE_DURATION) {
      setCinematicFade(fadeTimer / FADE_DURATION)
    }
    // Phase 2: at full black, teleport
    else if (fadeTimer <= FADE_DURATION + 0.15) {
      if (!isInInterior) {
        isInInterior = true
        setInteriorBypass(true)
        void movePlayerTo({ newRelativePosition: ROOM_SPAWN, cameraTarget: ROOM_SPAWN_LOOK })
        activateInteriorCamera()
      }
    }
    // Phase 3: fade from black
    else if (fadeTimer <= FADE_DURATION * 2 + 0.15) {
      const t = (fadeTimer - FADE_DURATION - 0.15) / FADE_DURATION
      setCinematicFade(1 - t)
    }
    // Done
    else {
      setCinematicFade(0)
      fadeState = 'none'
    }
  }

  if (fadeState === 'fading-out') {
    if (fadeTimer <= FADE_DURATION) {
      setCinematicFade(fadeTimer / FADE_DURATION)
    } else if (fadeTimer <= FADE_DURATION + 0.15) {
      if (isInInterior) {
        isInInterior = false
        setInteriorBypass(false)
        deactivateInteriorCamera()
        const ret = savedReturnPos ?? ENTRY_DOOR_POS
        void movePlayerTo({ newRelativePosition: { x: ret.x, y: ret.y, z: ret.z + 1 } })
        savedReturnPos = null
      }
    } else if (fadeTimer <= FADE_DURATION * 2 + 0.15) {
      const t = (fadeTimer - FADE_DURATION - 0.15) / FADE_DURATION
      setCinematicFade(1 - t)
    } else {
      setCinematicFade(0)
      fadeState = 'none'
    }
  }
}

// ── Safety: if round-end cinematic fires while in interior, eject the player ──
function interiorSafetySystem(_dt: number): void {
  if (isInInterior && cinematicState.showing) {
    isInInterior = false
    setInteriorBypass(false)
    deactivateInteriorCamera()
    fadeState = 'none'
    savedReturnPos = null
    // Cinematic system will handle teleporting to podium/audience
  }
}

// ── Init ──

export function setupInteriorSystem(): void {
  if (initialized) return
  initialized = true

  buildRoom()
  buildEntryTrigger()

  registerSystem(interiorFadeSystem)
  registerSystem(interiorSafetySystem)

  // Wire up the lever to raise/lower water
  setupWaterRise()

  console.log('[Interior] Room built at Y=180, entry door wired')
}

// ══════════════════════════════════════════════════════════════════════
// WATER RISE — lever toggles water rising from 1.58m to 16m over 60s
// Local-only visual effect (only the player who pulled the lever sees it)
// ══════════════════════════════════════════════════════════════════════

const WATER_BASE_Y = 49.58
const WATER_MAX_Y = 56
const WATER_RISE_DURATION = 120  // seconds to go from base to max

type WaterCyclePhase = 'idle' | 'rising' | 'peak' | 'lowering'
let waterPhase: WaterCyclePhase = 'idle'
let waterPeakTimer = 0
const WATER_PEAK_HOLD = 60  // seconds to hold at peak

let waterEntity: Entity | null = null
let _leverEntity: Entity | null = null
let waterRiseSoundEntity: Entity | null = null

const WATER_CENTER_X = 400
const WATER_CENTER_Z = 400
const WATER_DIAMETER = 800  // meters (full scene)

function buildCircularWater(): void {
  // Hide the composite water GLB
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const gltf = GltfContainer.get(entity)
    if (gltf.src.includes('WaterPatchFull')) {
      VisibilityComponent.createOrReplace(entity, { visible: false })
      console.log('[Interior] Hid composite water entity')
      break
    }
  }

  // Flat square as water surface (covers entire scene)
  waterEntity = engine.addEntity()
  Transform.create(waterEntity, {
    position: Vector3.create(WATER_CENTER_X, WATER_BASE_Y, WATER_CENTER_Z),
    scale: Vector3.create(WATER_DIAMETER - 64, 0.02, WATER_DIAMETER - 64),
  })
  MeshRenderer.setCylinder(waterEntity, 0.5, 0.5)
  Material.setPbrMaterial(waterEntity, {
    albedoColor: Color4.create(0.55, 0.75, 0.78, 1.0),
    roughness: 1.0,
    metallic: 0.0,
    specularIntensity: 0.0,
  })
  // Bottom layer — opaque seafloor tint just above ground
  const waterFloor = engine.addEntity()
  Transform.create(waterFloor, {
    position: Vector3.create(WATER_CENTER_X, WATER_BASE_Y - 0.3, WATER_CENTER_Z),
    scale: Vector3.create(WATER_DIAMETER, 0.02, WATER_DIAMETER),
  })
  MeshRenderer.setCylinder(waterFloor, 0.5, 0.5)
  Material.setPbrMaterial(waterFloor, {
    albedoColor: Color4.create(0.624, 0.804, 0.765, 1.0),
    emissiveColor: Color4.create(0.0, 0.0, 0.0),
    emissiveIntensity: 0.0,
    roughness: 0.5,
    metallic: 0.0,
  })

  console.log('[Interior] Created circular water surface, diameter:', WATER_DIAMETER, 'm')
}

function tweenWaterTo(targetY: number, durationSec: number): void {
  if (!waterEntity) return
  const pos = Transform.get(waterEntity).position
  const currentY = pos.y
  if (Math.abs(currentY - targetY) < 0.01) return

  // Remove existing tweens
  if (TweenSequence.has(waterEntity)) TweenSequence.deleteFrom(waterEntity)
  if (Tween.has(waterEntity)) Tween.deleteFrom(waterEntity)

  Tween.createOrReplace(waterEntity, {
    mode: Tween.Mode.Move({
      start: Vector3.create(pos.x, currentY, pos.z),
      end: Vector3.create(pos.x, targetY, pos.z),
    }),
    duration: Math.max(500, durationSec * 1000),
    easingFunction: EasingFunction.EF_LINEAR,
  })
}

function startWaterCycle(): void {
  if (waterPhase !== 'idle') return  // already in cycle
  waterPhase = 'rising'
  tweenWaterTo(WATER_MAX_Y, WATER_RISE_DURATION)
  // Play lever
  if (_leverEntity) {
    AudioSource.createOrReplace(_leverEntity, {
      audioClipUrl: 'assets/asset-packs/pirate_lever/sound.mp3',
      playing: true, loop: false, volume: 1.0, global: false
    })
    if (Animator.has(_leverEntity)) {
      Animator.playSingleAnimation(_leverEntity, 'activate', true)
    }
  }
  // Start water rise sound (global, looping)
  if (!waterRiseSoundEntity) {
    waterRiseSoundEntity = engine.addEntity()
    Transform.create(waterRiseSoundEntity, { position: Vector3.create(378, 52, 350) })
  }
  AudioSource.createOrReplace(waterRiseSoundEntity, {
    audioClipUrl: 'assets/sounds/waterrise.mp3',
    playing: true, loop: true, volume: 0.075, global: true
  })
  console.log('[Interior] Water cycle started — RISING')
}

function waterCycleSystem(dt: number): void {
  if (!waterEntity || waterPhase === 'idle') return

  const waterY = Transform.get(waterEntity).position.y

  if (waterPhase === 'rising' && waterY >= WATER_MAX_Y - 0.05) {
    waterPhase = 'peak'
    waterPeakTimer = WATER_PEAK_HOLD
    // Stop water rise sound during peak hold
    if (waterRiseSoundEntity) {
      AudioSource.createOrReplace(waterRiseSoundEntity, {
        audioClipUrl: 'assets/sounds/waterrise.mp3',
        playing: false, loop: true, volume: 0.075, global: true
      })
    }
    console.log('[Interior] Water at peak — holding for', WATER_PEAK_HOLD, 's')
  } else if (waterPhase === 'peak') {
    waterPeakTimer -= dt
    if (waterPeakTimer <= 0) {
      waterPhase = 'lowering'
      tweenWaterTo(WATER_BASE_Y, WATER_RISE_DURATION)
      // Play lever back
      if (_leverEntity) {
        AudioSource.createOrReplace(_leverEntity, {
          audioClipUrl: 'assets/asset-packs/pirate_lever/sound.mp3',
          playing: true, loop: false, volume: 1.0, global: false
        })
        if (Animator.has(_leverEntity)) {
          Animator.playSingleAnimation(_leverEntity, 'deactivate', true)
        }
      }
      // Resume water rise sound for lowering
      if (waterRiseSoundEntity) {
        AudioSource.createOrReplace(waterRiseSoundEntity, {
          audioClipUrl: 'assets/sounds/waterrise.mp3',
          playing: true, loop: true, volume: 0.075, global: true
        })
      }
      console.log('[Interior] Water LOWERING')
    }
  } else if (waterPhase === 'lowering' && waterY <= WATER_BASE_Y + 0.05) {
    waterPhase = 'idle'
    // Stop water rise sound when cycle complete
    if (waterRiseSoundEntity) {
      AudioSource.createOrReplace(waterRiseSoundEntity, {
        audioClipUrl: 'assets/sounds/waterrise.mp3',
        playing: false, loop: true, volume: 0.075, global: true
      })
    }
    console.log('[Interior] Water cycle complete — idle')
  }
}

/** Sync the drown mechanic with the rising water level + underwater overlay */
let isUnderwater = false
export function getIsUnderwater(): boolean { return isUnderwater }

function waterLevelSyncSystem(_dt: number): void {
  if (!waterEntity) return
  const waterY = Transform.get(waterEntity).position.y
  setWaterSurfaceY(waterY)

  if (!Transform.has(engine.PlayerEntity)) return
  const playerY = Transform.get(engine.PlayerEntity).position.y
  isUnderwater = waterY > WATER_BASE_Y + 0.1 && playerY < waterY - 2.0
}

function setupWaterRise(): void {
  if (!_leverEntity) {
    console.error('[Interior] Lever entity not set!')
    return
  }

  buildCircularWater()
  if (!waterEntity) {
    console.log('[Interior] Water entity not created!')
    return
  }

  pointerEventsSystem.onPointerDown(
    {
      entity: _leverEntity,
      opts: { button: InputAction.IA_POINTER, hoverText: 'Pull Lever', maxDistance: 20 },
    },
    () => {
      if (waterPhase !== 'idle') return
      // Broadcast to all players (including self)
      room.send('waterLeverPulled', { t: Date.now() })
    }
  )

  // All clients listen for the lever pull message
  room.onMessage('waterLeverPulled', () => {
    startWaterCycle()
  })

  registerSystem(waterCycleSystem)
  registerSystem(waterLevelSyncSystem)
  console.log('[Interior] Lever wired to water rise (synced)')
}
