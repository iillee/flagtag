/**
 * boomboxSystem.ts — Click boombox to toggle music mute.
 * When music is playing, animated rings radiate outward from the boombox.
 */
import {
  engine, Entity, Transform, MeshRenderer, Material,
  GltfContainer, pointerEventsSystem, InputAction, AudioSource
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { musicEntity } from '../index'
import { musicState } from '../ui/uiState'

const BOOMBOX_SRC = 'assets/asset-packs/boombox/Boombox_01/Boombox_01.glb'

// Music ring config
const RING_COUNT = 3
const RING_SPEED = 1.8        // units/sec expansion
const RING_MAX_SCALE = 5.0
const RING_INTERVAL = 0.8     // seconds between spawns
const RING_COLOR = Color4.create(1, 0.84, 0, 0.25) // gold, more transparent

let boomboxEntity: Entity | null = null
let boomboxPos = Vector3.create(0, 0, 0)
let initialized = false
let waitTimer = 0

// Ring state
interface Ring {
  entity: Entity
  age: number
}
const rings: Ring[] = []
let ringSpawnTimer = 0

function spawnRing(): void {
  const e = engine.addEntity()
  Transform.create(e, {
    position: Vector3.create(boomboxPos.x, boomboxPos.y, boomboxPos.z),
    scale: Vector3.create(0.3, 0.02, 0.3),
  })
  MeshRenderer.setCylinder(e, 0.5, 0.5)
  Material.setPbrMaterial(e, {
    albedoColor: RING_COLOR,
    emissiveColor: Color4.create(1, 0.84, 0, 1),
    emissiveIntensity: 2,
    transparencyMode: 2
  })
  rings.push({ entity: e, age: 0 })
}

function setupBoombox(): void {
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const gltf = GltfContainer.get(entity)
    if (gltf.src === BOOMBOX_SRC) {
      boomboxEntity = entity
      boomboxPos = { ...Transform.get(entity).position }

      // Add click handler
      pointerEventsSystem.onPointerDown(
        {
          entity,
          opts: {
            button: InputAction.IA_POINTER,
            hoverText: musicState.muted ? '♪ Unmute' : '♪ Mute',
            maxDistance: 12
          }
        },
        () => {
          
          musicState.muted = !musicState.muted
          try {
            const audio = AudioSource.getMutable(musicEntity)
            audio.volume = musicState.muted ? 0 : 0.0984375
          } catch {}
          // Update hover text
          pointerEventsSystem.onPointerDown(
            {
              entity: entity,
              opts: {
                button: InputAction.IA_POINTER,
                hoverText: musicState.muted ? '♪ Unmute' : '♪ Mute',
                maxDistance: 12
              }
            },
            arguments.callee as any
          )
        }
      )

      // Enable collider so pointer events work
      GltfContainer.createOrReplace(entity, {
        src: BOOMBOX_SRC,
        visibleMeshesCollisionMask: 1, // CL_POINTER
        invisibleMeshesCollisionMask: 3
      })

      console.log('[Boombox] Found boombox at', boomboxPos.x.toFixed(1), boomboxPos.y.toFixed(1), boomboxPos.z.toFixed(1))
      initialized = true
      return
    }
  }
}

export function boomboxSystem(dt: number): void {
  waitTimer += dt
  if (!initialized) {
    if (waitTimer < 3) return
    setupBoombox()
    if (!initialized) return
  }

  const muted = musicState.muted

  // Spawn rings when not muted
  if (!muted) {
    ringSpawnTimer += dt
    if (ringSpawnTimer >= RING_INTERVAL && rings.length < RING_COUNT) {
      spawnRing()
      ringSpawnTimer = 0
    }
  } else {
    ringSpawnTimer = 0
  }

  // Update rings
  for (let i = rings.length - 1; i >= 0; i--) {
    const ring = rings[i]
    ring.age += dt

    const scale = 0.3 + ring.age * RING_SPEED
    const lifeProgress = scale / RING_MAX_SCALE
    const alpha = Math.max(0, 0.25 * (1 - lifeProgress))

    if (scale >= RING_MAX_SCALE || muted) {
      engine.removeEntity(ring.entity)
      rings.splice(i, 1)
      continue
    }

    const t = Transform.getMutable(ring.entity)
    t.scale = Vector3.create(scale, 0.02, scale)
    t.position.y = boomboxPos.y + ring.age * 0.3

    Material.setPbrMaterial(ring.entity, {
      albedoColor: Color4.create(1, 0.84, 0, alpha),
      emissiveColor: Color4.create(1, 0.84, 0, 1),
      emissiveIntensity: 2 * (1 - lifeProgress),
      transparencyMode: 2
    })
  }
}
