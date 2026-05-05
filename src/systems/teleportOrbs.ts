import { engine, Entity, Transform, AudioSource, MeshRenderer, Material, MaterialTransparencyMode, LightSource } from '@dcl/sdk/ecs'
import { Vector3, Color3, Color4 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'

const ORB_TRIGGER_RADIUS = 1.5
const ORB_LAND_OFFSET = 3
const TELEPORT_COOLDOWN = 1.0
const ORB_BASE_SCALE = 1.2
const ORB_PULSE_SPEED = 3.0
const ORB_PULSE_RANGE = 0.15

interface OrbPair {
  positions: { x: number; y: number; z: number }[]
  orbEntities: Entity[]
  soundEntities: Entity[]
  wasInside: boolean[]
  cooldown: number
}

function createOrbPair(
  positions: { x: number; y: number; z: number }[],
  color: Color3,
  albedo: Color4
): OrbPair {
  const orbEntities: Entity[] = []
  const soundEntities: Entity[] = []

  for (const pos of positions) {
    const baseY = pos.y + 1
    const orb = engine.addEntity()
    Transform.create(orb, {
      position: Vector3.create(pos.x, baseY, pos.z),
      scale: Vector3.create(ORB_BASE_SCALE, ORB_BASE_SCALE, ORB_BASE_SCALE)
    })
    MeshRenderer.setSphere(orb)
    Material.setPbrMaterial(orb, {
      albedoColor: albedo,
      emissiveColor: color,
      emissiveIntensity: 4.0,
      roughness: 0.2,
      metallic: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
    })
    const light = engine.addEntity()
    Transform.create(light, { parent: orb, position: Vector3.Zero() })
    LightSource.create(light, { type: LightSource.Type.Point({}), color, intensity: 150, range: 12 })
    orbEntities.push(orb)

    const snd = engine.addEntity()
    Transform.create(snd, { position: Vector3.create(pos.x, baseY, pos.z) })
    AudioSource.create(snd, { audioClipUrl: 'assets/sounds/teleport.mp3', playing: false, loop: false, volume: 1, global: false })
    soundEntities.push(snd)
  }

  return { positions, orbEntities, soundEntities, wasInside: positions.map(() => false), cooldown: 0 }
}

/**
 * Creates teleport orb pairs and registers the teleportation + pulse system.
 */
export function setupTeleportOrbs(): void {
  const orbPairs: OrbPair[] = [
    createOrbPair(
      [{ x: 290.5, y: 2.6, z: 254.7 }, { x: 276.56, y: 52.25, z: 301.5 }],
      Color3.create(1.0, 0.45, 0.05),   // Orange
      Color4.create(1.0, 0.4, 0.0, 0.85)
    ),
    createOrbPair(
      [{ x: 224, y: 2.0, z: 288 }, { x: 226.3, y: 2.8, z: 211.3 }],
      Color3.create(0.05, 0.3, 1.0),    // Blue
      Color4.create(0.0, 0.2, 1.0, 0.85)
    ),
  ]

  let orbPulseTime = 0
  engine.addSystem((dt: number) => {
    if (!Transform.has(engine.PlayerEntity)) return
    const playerPos = Transform.get(engine.PlayerEntity).position

    for (const pair of orbPairs) {
      if (pair.cooldown > 0) pair.cooldown -= dt

      for (let i = 0; i < pair.positions.length; i++) {
        const orbPos = pair.positions[i]
        const dist = Vector3.distance(playerPos, Vector3.create(orbPos.x, orbPos.y + 1, orbPos.z))
        const isInside = dist < ORB_TRIGGER_RADIUS

        if (isInside && !pair.wasInside[i] && pair.cooldown <= 0) {
          const destIndex = i === 0 ? 1 : 0
          const dest = pair.positions[destIndex]
          for (const snd of pair.soundEntities) {
            const a = AudioSource.getMutable(snd)
            a.currentTime = 0
            a.playing = true
          }
          pair.cooldown = TELEPORT_COOLDOWN
          void movePlayerTo({ newRelativePosition: Vector3.create(dest.x + ORB_LAND_OFFSET, dest.y + 1, dest.z) })
        }
        pair.wasInside[i] = isInside
      }
    }

    // Pulse all orbs
    orbPulseTime += dt
    const pulse = 1 + ORB_PULSE_RANGE * Math.sin(orbPulseTime * ORB_PULSE_SPEED)
    const s = ORB_BASE_SCALE * pulse
    for (const pair of orbPairs) {
      for (const orb of pair.orbEntities) {
        if (Transform.has(orb)) {
          Transform.getMutable(orb).scale = Vector3.create(s, s, s)
        }
      }
    }
  })
}
