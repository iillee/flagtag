import { engine, Entity, Transform, AudioSource, GltfContainer, LightSource } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import { isMobile } from '@dcl/sdk/platform'
import { registerSystem } from './systemManager'

const ORB_TRIGGER_RADIUS = 0.9
const ORB_LAND_OFFSET = 3
const TELEPORT_COOLDOWN = 1.0
const ORB_SCALE = 0.7
const ORB_SPIN_SPEED_Y = 0.5
const ORB_SPIN_SPEED_X = 0.3
const ORB_BOB_SPEED = 2.0
const ORB_BOB_RANGE = 0.075

interface OrbPair {
  positions: { x: number; y: number; z: number }[]
  orbEntities: Entity[]      // the d20 body (parent for spin/bob)
  wireEntities: Entity[]     // wireframe overlay (child of orb)
  soundEntities: Entity[]
  wasInside: boolean[]
  cooldown: number
}

function createOrbPair(
  positions: { x: number; y: number; z: number }[],
  color: Color3,
  model: string,
  wireModel: string
): OrbPair {
  const orbEntities: Entity[] = []
  const wireEntities: Entity[] = []
  const soundEntities: Entity[] = []

  for (const pos of positions) {
    const baseY = pos.y + 1

    // ── D20 body ──
    const orb = engine.addEntity()
    Transform.create(orb, {
      position: Vector3.create(pos.x, baseY, pos.z),
      scale: Vector3.create(ORB_SCALE, ORB_SCALE, ORB_SCALE),
      rotation: Quaternion.fromEulerDegrees(0, 0, 0)
    })
    GltfContainer.create(orb, { src: model })

    // ── Wireframe edges (child of orb — spins with it) ──
    const wire = engine.addEntity()
    Transform.create(wire, {
      parent: orb,
      position: Vector3.Zero(),
      scale: Vector3.create(1.02, 1.02, 1.02) // slightly larger so edges sit on surface
    })
    GltfContainer.create(wire, { src: wireModel })

    // ── Point light (skip on mobile to reduce glow) ──
    if (!isMobile()) {
      const light = engine.addEntity()
      Transform.create(light, { parent: orb, position: Vector3.Zero() })
      LightSource.create(light, { type: LightSource.Type.Point({}), color, intensity: 150, range: 12 })
    }

    orbEntities.push(orb)
    wireEntities.push(wire)

    // ── Sound ──
    const snd = engine.addEntity()
    Transform.create(snd, { position: Vector3.create(pos.x, baseY, pos.z) })
    AudioSource.create(snd, { audioClipUrl: 'assets/sounds/teleport.mp3', playing: false, loop: false, volume: 1, global: false })
    soundEntities.push(snd)
  }

  return { positions, orbEntities, wireEntities, soundEntities, wasInside: positions.map(() => false), cooldown: 0 }
}

/**
 * Creates teleport orb pairs and registers the teleportation + spin/bob system.
 */
export function setupTeleportOrbs(): void {
  const mobile = isMobile()
  const orbPairs: OrbPair[] = [
    createOrbPair(
      [{ x: 460.5, y: 2.3, z: 396.7 }, { x: 446.56, y: 52.25, z: 443.5 }],
      Color3.create(1.0, 0.45, 0.0),
      mobile ? 'assets/models/d20-gold-mobile.glb' : 'assets/models/d20-gold.glb',
      mobile ? 'assets/models/d20-wire-gold-mobile.glb' : 'assets/models/d20-wire-gold.glb'
    ),
    createOrbPair(
      [{ x: 394, y: 1.5, z: 430 }, { x: 396.3, y: 2.3, z: 353.3 }],
      Color3.create(0.05, 0.3, 1.0),
      mobile ? 'assets/models/d20-blue-mobile.glb' : 'assets/models/d20-blue.glb',
      mobile ? 'assets/models/d20-wire-blue-mobile.glb' : 'assets/models/d20-wire-blue.glb'
    ),
  ]

  let orbPulseTime = 0
  registerSystem((dt: number) => {
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
            // Single createOrReplace with playing:true ensures a fresh restart every time
            AudioSource.createOrReplace(snd, { audioClipUrl: 'assets/sounds/teleport.mp3', playing: true, loop: false, volume: 1, global: false })
          }
          pair.cooldown = TELEPORT_COOLDOWN
          void movePlayerTo({ newRelativePosition: Vector3.create(dest.x + ORB_LAND_OFFSET, dest.y + 1, dest.z) })
        }
        pair.wasInside[i] = isInside
      }
    }

    // Spin and bob all orbs
    orbPulseTime += dt
    for (const pair of orbPairs) {
      for (let i = 0; i < pair.orbEntities.length; i++) {
        const orb = pair.orbEntities[i]
        if (Transform.has(orb)) {
          const t = Transform.getMutable(orb)
          const baseY = pair.positions[i].y + 1
          t.position.y = baseY + ORB_BOB_RANGE * Math.sin(orbPulseTime * ORB_BOB_SPEED)
          t.rotation = Quaternion.fromEulerDegrees(
            orbPulseTime * ORB_SPIN_SPEED_X * 57.3,
            orbPulseTime * ORB_SPIN_SPEED_Y * 57.3,
            0
          )
        }
      }
    }
  })
}
