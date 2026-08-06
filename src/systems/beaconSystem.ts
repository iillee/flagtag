import {
  engine, Transform, MeshRenderer, Material, Billboard,
  BillboardMode, MaterialTransparencyMode, PlayerIdentityData,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color4, Color3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { getFlagAuthoritativeWorldPos } from './flagSystem'
import { Flag, FlagState } from '../shared/components'

// ── Configuration ──
const BEACON_HEIGHT = 110
const BEACON_Y_OFFSET = 5.0   // raise base above the flag model top (high enough to clear carried flag)
const INNER_WIDTH = 0.5
const OUTER_WIDTH = 2.0
const INNER_ALPHA = 0.7
const OUTER_ALPHA = 0.35
const EMISSIVE_INNER = 3.0
const EMISSIVE_OUTER = 2.0
const PULSE_SPEED = 2.5
const PULSE_RANGE = 0.15 // scale oscillates ±15%

// Beacon color — gold to match particles
const BEACON_COLOR = { r: 1, g: 0.84, b: 0 }

// Flag carry offset
const FLAG_CARRY_OFFSET = { x: 0, y: 0.4, z: 0 }

// ── State ──
let innerBeacon: ReturnType<typeof engine.addEntity>
let outerBeacon: ReturnType<typeof engine.addEntity>
let pulseTime = 0

// ── Water sinking blink ──
const BLINK_DURATION = 3.0 // total blink period (matches server delay)
const BLINK_COUNT = 6      // number of on/off cycles
let blinkTimer = 0
let blinkActive = false

export function setupBeacon(): void {
  console.log('[Beacon] Setting up beacon light pillar system')
  const HIDDEN = Vector3.create(0, -200, 0)
  
  console.log('[Beacon] Loading textures: beacon-gradient.png, beacon-alpha.png')

  innerBeacon = engine.addEntity()
  Transform.create(innerBeacon, {
    position: HIDDEN,
    scale: Vector3.create(INNER_WIDTH, BEACON_HEIGHT, 1)
  })
  MeshRenderer.setPlane(innerBeacon)
  Billboard.create(innerBeacon, { billboardMode: BillboardMode.BM_Y })

  outerBeacon = engine.addEntity()
  Transform.create(outerBeacon, {
    position: HIDDEN,
    scale: Vector3.create(OUTER_WIDTH, BEACON_HEIGHT, 1)
  })
  MeshRenderer.setPlane(outerBeacon)
  Billboard.create(outerBeacon, { billboardMode: BillboardMode.BM_Y })

  const GRADIENT_TEXTURE = Material.Texture.Common({ src: 'assets/images/beacon-gradient.png' })
  const ALPHA_TEXTURE = Material.Texture.Common({ src: 'assets/images/beacon-alpha.png' })
  const c = BEACON_COLOR

  Material.setPbrMaterial(innerBeacon, {
    texture: GRADIENT_TEXTURE,
    alphaTexture: ALPHA_TEXTURE,
    albedoColor: Color4.create(c.r, c.g, c.b, INNER_ALPHA),
    emissiveColor: Color3.create(c.r, c.g, c.b),
    emissiveIntensity: EMISSIVE_INNER,
    transparencyMode: MaterialTransparencyMode.MTM_AUTO,
    castShadows: false
  })

  Material.setPbrMaterial(outerBeacon, {
    texture: GRADIENT_TEXTURE,
    alphaTexture: ALPHA_TEXTURE,
    albedoColor: Color4.create(c.r, c.g, c.b, OUTER_ALPHA),
    emissiveColor: Color3.create(c.r, c.g, c.b),
    emissiveIntensity: EMISSIVE_OUTER,
    transparencyMode: MaterialTransparencyMode.MTM_AUTO,
    castShadows: false
  })
  
  console.log('[Beacon] Beacon system setup complete - inner and outer beacons created')
}

/** Find the world position of the flag carrier.
 *
 * Duplicate-avatar-entity aware: when a recycled/reissued PlayerIdentityData
 * lingers on this client (same address on 2+ entities — the P3 pattern from
 * hammurabi PR #64), taking the first match by iteration order can return a
 * STALE entity whose Transform is frozen at the old avatar's last position.
 * That caused the "beacon teleports to spawn for one player" bug: only the
 * client with the duplicate saw it, only while Carried (the sole branch that
 * uses this lookup — Dropped/AtBase come from authoritative flag fields).
 *
 * Mirrors the selectNewestPerAddress pattern PR #22 established server-side
 * for the same defect class. Higher entity id == newer version, so we pick
 * the max id among matches — the live one — and read its Transform.
 */
function getCarrierWorldPos(carrierPlayerId: string): Vector3 | null {
  // Check if the local player is the carrier
  const local = getPlayer()
  if (local?.userId?.toLowerCase() === carrierPlayerId && Transform.has(engine.PlayerEntity)) {
    return Transform.get(engine.PlayerEntity).position
  }

  // Check by wallet address (used in multiplayer). Take the NEWEST entity id
  // among all matches — see block comment above.
  let newestEntity: Entity | null = null
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === carrierPlayerId) {
      if (newestEntity === null || (entity as number) > (newestEntity as number)) {
        newestEntity = entity
      }
    }
  }
  if (newestEntity !== null) {
    return Transform.get(newestEntity).position
  }

  return null
}

export function startBeaconBlink(): void {
  blinkActive = true
  blinkTimer = 0
}

export function beaconClientSystem(dt: number): void {
  pulseTime += dt
  const pulse = 1 + PULSE_RANGE * Math.sin(pulseTime * PULSE_SPEED)

  // Advance blink timer
  if (blinkActive) {
    blinkTimer += dt
    if (blinkTimer >= BLINK_DURATION) {
      blinkActive = false
      blinkTimer = 0
    }
  }

  let worldPos: Vector3 | null = null

  // First try to find server flag (multiplayer)
  for (const [flagEntity, flag] of engine.getEntitiesWith(Flag, Transform)) {
    // Source of truth for "is carried": carrierPlayerId alone. Using flag.state
    // as well causes desync during the CRDT window where state and
    // carrierPlayerId disagree (state=Dropped stale but carrierPlayerId=X
    // already set, or vice versa). In that window the else branch pinned
    // the beacon to the flag entity's stale Transform — different per client,
    // making the beacon appear "detached" until the next steal forced a resync.
    if (flag.carrierPlayerId) {
      // Flag is carried - use carrier's world position + flag offset
      const carrierPos = getCarrierWorldPos(flag.carrierPlayerId)
      if (!carrierPos) break // carrier not found yet, skip this frame (beacon hidden)
      worldPos = Vector3.create(
        carrierPos.x + FLAG_CARRY_OFFSET.x,
        carrierPos.y + FLAG_CARRY_OFFSET.y,
        carrierPos.z + FLAG_CARRY_OFFSET.z
      )
    } else {
      // Dropped or at base — ask flagSystem for the authoritative world
      // position (analytic during fall, validated Flag.dropAnchor*/base*
      // fields at rest). Deliberately does NOT touch the server-synced
      // flag entity's Transform, which has proven unreliable across many
      // playtests. If null (flag not ready), skip — beacon stays hidden.
      const authPos = getFlagAuthoritativeWorldPos()
      if (!authPos) break
      worldPos = authPos
    }
    break // only one flag
  }

  if (worldPos) {
    const beaconY = worldPos.y + BEACON_Y_OFFSET + BEACON_HEIGHT / 2

    // During blink phase, blinks accelerate for urgency
    let visible = true
    if (blinkActive) {
      const progress = blinkTimer / BLINK_DURATION // 0→1
      // Frequency increases from ~2 Hz to ~6 Hz
      const freq = 2 + progress * 4
      visible = Math.sin(blinkTimer * freq * Math.PI * 2) > 0
    }

    if (visible) {
      const innerT = Transform.getMutable(innerBeacon)
      innerT.position = Vector3.create(worldPos.x, beaconY, worldPos.z)
      innerT.scale = Vector3.create(INNER_WIDTH * pulse, BEACON_HEIGHT, 1)

      const outerT = Transform.getMutable(outerBeacon)
      outerT.position = Vector3.create(worldPos.x, beaconY, worldPos.z)
      outerT.scale = Vector3.create(OUTER_WIDTH * (2 - pulse), BEACON_HEIGHT, 1)
    } else {
      const HIDDEN = Vector3.create(0, -200, 0)
      Transform.getMutable(innerBeacon).position = HIDDEN
      Transform.getMutable(outerBeacon).position = HIDDEN
    }

  } else {
    // Hide beacons if no flag found
    const HIDDEN = Vector3.create(0, -200, 0)
    Transform.getMutable(innerBeacon).position = HIDDEN
    Transform.getMutable(outerBeacon).position = HIDDEN
  }
}