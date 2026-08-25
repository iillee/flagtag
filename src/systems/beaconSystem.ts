import {
  engine, Transform, MeshRenderer, Material, Billboard,
  BillboardMode, MaterialTransparencyMode
} from '@dcl/sdk/ecs'
import { Vector3, Color4, Color3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { getFlagAuthoritativeWorldPos } from './flagSystem'
import { Flag, FlagState } from '../shared/components'
import { getPlayerEntityPosition } from '../shared/playerEntities'

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

// ── Last known carrier position ──
// On mobile, remote avatars stream in on-demand. When another player picks up
// the flag, their PlayerIdentityData/Transform may not yet be present on this
// client — causing getCarrierWorldPos() to return null and the beacon to
// vanish. Fall back to the beacon's last known world position until the
// carrier's avatar streams in.
let lastWorldPos: Vector3 | null = null

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
 * This lookup is where the duplicate-avatar-entity problem was first diagnosed: a lingering
 * recycled/reissued PlayerIdentityData (same address on 2+ entities — the P3 pattern from
 * hammurabi PR #64) made a first-match scan return a STALE entity frozen at the old avatar's
 * last position. That was the "beacon teleports to spawn for one player" bug — only the client
 * holding the duplicate saw it, and only while Carried, the sole branch that uses this lookup
 * (Dropped/AtBase come from authoritative flag fields).
 *
 * The max-id rule that fixed it is no longer written out here; it now lives behind
 * `resolvePlayerEntity`, alongside the seven other lookups that were still taking first match
 * and therefore still resolving to the corpse. That module's header carries the full argument,
 * including why max-id is itself unsound and what a real fix requires.
 */
function getCarrierWorldPos(carrierPlayerId: string): Vector3 | null {
  // Check if the local player is the carrier. Must stay ahead of the resolver: the local
  // avatar is engine.PlayerEntity, whose position this client knows exactly, rather than
  // through a comms-replicated copy of it.
  const local = getPlayer()
  if (local?.userId?.toLowerCase() === carrierPlayerId && Transform.has(engine.PlayerEntity)) {
    return Transform.get(engine.PlayerEntity).position
  }

  // Otherwise by wallet address (multiplayer).
  return getPlayerEntityPosition(carrierPlayerId)
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
      // Flag is carried - use carrier's world position + flag offset.
      // On mobile, remote avatars stream in on-demand, so the carrier's
      // Transform may not be present yet immediately after a pickup. Fall
      // back to the last known beacon position so the beacon stays visible
      // instead of disappearing.
      const carrierPos = getCarrierWorldPos(flag.carrierPlayerId)
      if (carrierPos) {
        worldPos = Vector3.create(
          carrierPos.x + FLAG_CARRY_OFFSET.x,
          carrierPos.y + FLAG_CARRY_OFFSET.y,
          carrierPos.z + FLAG_CARRY_OFFSET.z
        )
      } else if (lastWorldPos) {
        worldPos = lastWorldPos
      } else {
        break // no carrier and no cached position — hide
      }
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
    lastWorldPos = worldPos
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