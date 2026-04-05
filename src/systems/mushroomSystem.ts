import {
  engine, Transform, GltfContainer, Entity, AudioSource,
  Raycast, RaycastResult, RaycastQueryType,
  MeshRenderer, Material, Billboard, BillboardMode, MaterialTransparencyMode
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4, Color3 } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { Flag } from '../shared/components'
import { getPlayer } from '@dcl/sdk/players'
import { showShield, hideShield, showShieldForPlayer, hideShieldForPlayer, hideAllShields } from './shieldSystem'

// ── Constants ──
const MUSHROOM_MODEL = 'assets/scene/Models/mushroom_03.glb'
const MUSHROOM_COUNT = 1
const MUSHROOM_PICKUP_RADIUS = 0.5
// Shield lasts until hit or round end (no time limit)
const MUSHROOM_Y_OFFSET = 0.0   // Raise mushroom above ground so it's not buried

// ── Beacon constants (red, matching flag beacon style) ──
const BEACON_HEIGHT = 110
const BEACON_Y_OFFSET = 5.0
const BEACON_INNER_WIDTH = 0.5
const BEACON_OUTER_WIDTH = 2.0
const BEACON_INNER_ALPHA = 0.35
const BEACON_OUTER_ALPHA = 0.1
const BEACON_EMISSIVE_INNER = 1.0
const BEACON_EMISSIVE_OUTER = 0.6
const BEACON_PULSE_SPEED = 2.5
const BEACON_PULSE_RANGE = 0.15
const BEACON_COLOR = { r: 1, g: 0.15, b: 0.15 } // Red

// Scene bounds (10×15 parcels = 160×240m)
const SCENE_MIN_X = 2
const SCENE_MAX_X = 158
const SCENE_MIN_Z = 2
const SCENE_MAX_Z = 238
const RAY_START_Y = 100  // Cast from high above
const WATER_Y = 0.577    // Y level of water planes

// Water plane bounds (position ± halfSize, base patch = 16m, scaled)
// Water 1: pos(47.01, z=88.22), scale(3.3, 5.5), rot -60deg
// Water 2: pos(71.01, z=168.47), scale(4.08, 6.81), no rotation
// Using generous AABB to cover rotated planes
const WATER_ZONES = [
  { cx: 47.01, cz: 88.22, hx: 3.3 * 8 + 8, hz: 5.5 * 8 + 8 },   // Water_2 (rotated, oversized AABB)
  { cx: 71.01, cz: 168.47, hx: 4.08 * 8, hz: 6.81 * 8 },          // Water
]

// ── Helpers ──
function isServerConnected(): boolean {
  return [...engine.getEntitiesWith(Flag)].length > 0
}

// ── State ──
interface MushroomVisual {
  id: number
  entity: Entity
  rayEntity: Entity | null
  placed: boolean  // true once raycast found a surface
  x: number
  z: number
}

// ── Boost sound ──
let boostSoundEntity: Entity | null = null
function playBoostSound(): void {
  if (!boostSoundEntity) {
    boostSoundEntity = engine.addEntity()
    Transform.create(boostSoundEntity, { position: Vector3.create(0, 0, 0) })
    AudioSource.create(boostSoundEntity, {
      audioClipUrl: 'assets/sounds/boost.mp3',
      playing: false,
      loop: false,
      volume: 1.0,
      global: true
    })
  }
  const a = AudioSource.getMutable(boostSoundEntity)
  a.playing = false
  a.currentTime = 0
  a.playing = true
}

// ── Shield break sound ──
let shieldBreakSoundEntity: Entity | null = null
function playShieldBreakSound(): void {
  if (!shieldBreakSoundEntity) {
    shieldBreakSoundEntity = engine.addEntity()
    Transform.create(shieldBreakSoundEntity, { position: Vector3.create(0, 0, 0) })
    AudioSource.create(shieldBreakSoundEntity, {
      audioClipUrl: 'assets/sounds/shield-break.mp3',
      playing: false,
      loop: false,
      volume: 1.0,
      global: true
    })
  }
  const a = AudioSource.getMutable(shieldBreakSoundEntity)
  a.playing = false
  a.currentTime = 0
  a.playing = true
}

const mushrooms: MushroomVisual[] = []
const pickedUpIds = new Set<number>()  // Prevent sending duplicate pickup requests
let messagesRegistered = false
let positionsRequested = false
let shieldActive = false

// ── Beacon state ──
let beaconInner: Entity | null = null
let beaconOuter: Entity | null = null
let beaconPulseTime = 0

function setupMushroomBeacon(): void {
  if (beaconInner) return // already set up

  const HIDDEN = Vector3.create(0, -200, 0)
  const GRADIENT_TEXTURE = Material.Texture.Common({ src: 'images/beacon-gradient.png' })
  const ALPHA_TEXTURE = Material.Texture.Common({ src: 'images/beacon-alpha.png' })
  const c = BEACON_COLOR

  beaconInner = engine.addEntity()
  Transform.create(beaconInner, { position: HIDDEN, scale: Vector3.create(BEACON_INNER_WIDTH, BEACON_HEIGHT, 1) })
  MeshRenderer.setPlane(beaconInner)
  Billboard.create(beaconInner, { billboardMode: BillboardMode.BM_Y })
  Material.setPbrMaterial(beaconInner, {
    texture: GRADIENT_TEXTURE,
    alphaTexture: ALPHA_TEXTURE,
    albedoColor: Color4.create(c.r, c.g, c.b, BEACON_INNER_ALPHA),
    emissiveColor: Color3.create(c.r, c.g, c.b),
    emissiveIntensity: BEACON_EMISSIVE_INNER,
    transparencyMode: MaterialTransparencyMode.MTM_AUTO,
    castShadows: false
  })

  beaconOuter = engine.addEntity()
  Transform.create(beaconOuter, { position: HIDDEN, scale: Vector3.create(BEACON_OUTER_WIDTH, BEACON_HEIGHT, 1) })
  MeshRenderer.setPlane(beaconOuter)
  Billboard.create(beaconOuter, { billboardMode: BillboardMode.BM_Y })
  Material.setPbrMaterial(beaconOuter, {
    texture: GRADIENT_TEXTURE,
    alphaTexture: ALPHA_TEXTURE,
    albedoColor: Color4.create(c.r, c.g, c.b, BEACON_OUTER_ALPHA),
    emissiveColor: Color3.create(c.r, c.g, c.b),
    emissiveIntensity: BEACON_EMISSIVE_OUTER,
    transparencyMode: MaterialTransparencyMode.MTM_AUTO,
    castShadows: false
  })

  console.log('[Mushroom] 🍄 Red beacon created')
}

// ── Message registration ──
function registerMushroomMessages(): void {
  if (messagesRegistered) return
  messagesRegistered = true

  // Server sends mushroom spawn positions
  room.onMessage('mushroomPositions', (data) => {
    const positions: { id: number, x: number, z: number }[] = JSON.parse((data as any).mushroomsJson || '[]')
    console.log('[Mushroom] Received', positions.length, 'mushroom positions from server')

    // Always clear existing mushrooms before spawning new ones
    for (const m of mushrooms) {
      if (m.rayEntity) engine.removeEntity(m.rayEntity!)
      engine.removeEntity(m.entity)
    }
    mushrooms.length = 0
    pickedUpIds.clear()

    // Create mushrooms and start raycasting to find surfaces
    for (const pos of positions) {
      const entity = engine.addEntity()
      // Start hidden underground until raycast finds surface
      Transform.create(entity, {
        position: Vector3.create(pos.x, -100, pos.z),
        scale: Vector3.create(0.25, 0.25, 0.25),
        rotation: Quaternion.fromEulerDegrees(0, Math.random() * 360, 0)
      })
      GltfContainer.create(entity, {
        src: MUSHROOM_MODEL,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })

      // Create raycast entity to find surface
      const rayEntity = engine.addEntity()
      Transform.create(rayEntity, {
        position: Vector3.create(pos.x, RAY_START_Y, pos.z)
      })
      Raycast.create(rayEntity, {
        direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
        maxDistance: 200,
        queryType: RaycastQueryType.RQT_HIT_FIRST,
        continuous: false
      })

      mushrooms.push({
        id: pos.id,
        entity,
        rayEntity,
        placed: false,
        x: pos.x,
        z: pos.z
      })
    }
  })

  // Server says a mushroom was picked up
  room.onMessage('mushroomPickedUp', (data) => {
    const mid = (data as any).id as number
    const pid = (data as any).playerId as string
    console.log('[Mushroom] Mushroom', mid, 'picked up by', pid)
    playBoostSound()
    // Remove the mushroom visual
    for (let i = mushrooms.length - 1; i >= 0; i--) {
      if (mushrooms[i].id === mid) {
        if (mushrooms[i].rayEntity) engine.removeEntity(mushrooms[i].rayEntity!)
        engine.removeEntity(mushrooms[i].entity)
        mushrooms.splice(i, 1)
        break
      }
    }
  })

  // Server grants shield to a player
  room.onMessage('mushroomShield', (data) => {
    const pid = (data as any).playerId as string
    const me = getPlayer()
    if (!me?.userId || me.userId.toLowerCase() !== pid?.toLowerCase()) return
    shieldActive = true
    console.log('[Mushroom] 🍄🛡️ Shield active until hit or round end')
    showShield()
  })

  // Server says shield was consumed (blocked a hit)
  room.onMessage('shieldConsumed', (data) => {
    const pid = (data as any).playerId as string
    const me = getPlayer()
    if (!me?.userId || me.userId.toLowerCase() !== pid?.toLowerCase()) return
    shieldActive = false
    console.log('[Mushroom] 🛡️ Shield consumed!')
    hideShield()
    playShieldBreakSound()
  })

  // Broadcast: show/hide shield on any player (including self for other clients)
  room.onMessage('playerShieldActive', (data) => {
    const pid = (data as any).playerId as string
    const active = (data as any).active as number
    // Skip local player — already handled by mushroomShield/shieldConsumed
    const me = getPlayer()
    if (me?.userId?.toLowerCase() === pid.toLowerCase()) return
    if (active) {
      showShieldForPlayer(pid)
    } else {
      hideShieldForPlayer(pid)
    }
  })
}

// ── Process pending raycasts ──
function processMushroomRaycasts(): void {
  for (const m of mushrooms) {
    if (m.placed || !m.rayEntity) continue

    const result = RaycastResult.getOrNull(m.rayEntity)
    if (result) {
      // Use hit Y if raycast found a surface, otherwise check water zones, then fall back to ground (Y=0)
      let hitY: number
      if (result.hits.length > 0) {
        hitY = result.hits[0].position!.y
      } else {
        // Check if mushroom is over a water zone
        const overWater = WATER_ZONES.some(w =>
          Math.abs(m.x - w.cx) < w.hx && Math.abs(m.z - w.cz) < w.hz
        )
        hitY = overWater ? WATER_Y : 0
      }
      const t = Transform.getMutable(m.entity)
      t.position = Vector3.create(m.x, hitY + MUSHROOM_Y_OFFSET, m.z)
      console.log('[Mushroom] Placed mushroom', m.id, 'at', m.x.toFixed(1), hitY.toFixed(1), m.z.toFixed(1), result.hits.length > 0 ? '(raycast hit)' : '(ground fallback)')
      // Clean up ray entity
      engine.removeEntity(m.rayEntity)
      m.rayEntity = null
      m.placed = true
    }
  }
}

// ── Beacon positioning ──
function updateMushroomBeacon(dt: number): void {
  if (!beaconInner || !beaconOuter) return

  beaconPulseTime += dt
  const pulse = 1 + BEACON_PULSE_RANGE * Math.sin(beaconPulseTime * BEACON_PULSE_SPEED)

  // Find the first placed mushroom to attach beacon to
  const target = mushrooms.find(m => m.placed)
  if (target) {
    const mPos = Transform.get(target.entity).position
    const beaconY = mPos.y + BEACON_Y_OFFSET + BEACON_HEIGHT / 2

    const innerT = Transform.getMutable(beaconInner)
    innerT.position = Vector3.create(mPos.x, beaconY, mPos.z)
    innerT.scale = Vector3.create(BEACON_INNER_WIDTH * pulse, BEACON_HEIGHT, 1)

    const outerT = Transform.getMutable(beaconOuter)
    outerT.position = Vector3.create(mPos.x, beaconY, mPos.z)
    outerT.scale = Vector3.create(BEACON_OUTER_WIDTH * (2 - pulse), BEACON_HEIGHT, 1)
  } else {
    const HIDDEN = Vector3.create(0, -200, 0)
    Transform.getMutable(beaconInner).position = HIDDEN
    Transform.getMutable(beaconOuter).position = HIDDEN
  }
}

// ── Client system (called every frame) ──
export function mushroomClientSystem(dt: number): void {
  registerMushroomMessages()
  // Request mushroom positions from server once
  if (!positionsRequested && isServerConnected()) {
    positionsRequested = true
    room.send('requestMushroomPositions', { t: 0 })
  }

  processMushroomRaycasts()

  // Shield is removed by shieldConsumed message or round end (no time expiry)

  // Check proximity for pickup (send to server)
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  for (const m of mushrooms) {
    if (!m.placed) continue
    const mPos = Transform.get(m.entity).position
    const dx = playerPos.x - mPos.x
    const dz = playerPos.z - mPos.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < MUSHROOM_PICKUP_RADIUS && !pickedUpIds.has(m.id)) {
      pickedUpIds.add(m.id)
      room.send('pickupMushroom', { id: m.id })
    }
  }
}

/** Returns true if the local player currently has a mushroom shield. */
export function hasMushroomShield(): boolean {
  return shieldActive
}

/** Clear shield on round end */
export function clearMushroomShield(): void {
  shieldActive = false
  hideAllShields()
  console.log('[Mushroom] 🛡️ All shields cleared (round end)')
}
