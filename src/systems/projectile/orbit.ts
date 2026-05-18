/**
 * Green orbit visual — boomerang circles around the player.
 */
import { engine, Transform, GltfContainer } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import {
  orbit, cooldown, localThrow, ORBIT_VISUAL_RADIUS, ORBIT_DURATION_MS,
  ORBIT_VISUAL_SPEED, ORBIT_RAMP_MS, PROJECTILE_SCALE
} from './state'
import { attachProjectileSound, stopProjectileSound } from './sound'
import { getBoomerangModelSrc } from '../../gameState/boomerangColor'
import { updateHandBoomerangVisibility } from './handVisual'
import { getPlayerForward } from './utils'

/** Returns true if the local player's green orbit is currently active. */
export function isOrbitActive(): boolean { return orbit.active }

export function startOrbitVisual(): void {
  if (orbit.entity === null) {
    orbit.entity = engine.addEntity()
    Transform.create(orbit.entity, { position: Vector3.Zero(), scale: Vector3.Zero() })
    GltfContainer.create(orbit.entity, {
      src: getBoomerangModelSrc(),
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    attachProjectileSound(orbit.entity)
  } else {
    if (GltfContainer.has(orbit.entity)) {
      GltfContainer.getMutable(orbit.entity).src = getBoomerangModelSrc()
    }
    attachProjectileSound(orbit.entity)
  }
  orbit.active = true
  orbit.startMs = Date.now()
  orbit.endMs = orbit.startMs + ORBIT_DURATION_MS
  const { dirX, dirZ } = getPlayerForward()
  orbit.startAngle = Math.atan2(dirX, dirZ) * (180 / Math.PI)
  localThrow.active = true
  localThrow.sawVisual = true
  updateHandBoomerangVisibility()
}

/** Trigger early ramp-down — boomerang returns to player over ORBIT_RAMP_MS */
export function endOrbitEarly(): void {
  if (!orbit.active) return
  const now = Date.now()
  const remaining = orbit.endMs - now
  if (remaining <= ORBIT_RAMP_MS) return
  orbit.endMs = now + ORBIT_RAMP_MS
}

export function stopOrbitVisual(): void {
  orbit.active = false
  if (orbit.entity !== null && Transform.has(orbit.entity)) {
    Transform.getMutable(orbit.entity).scale = Vector3.Zero()
    stopProjectileSound(orbit.entity)
  }
  if (orbit.wallRayEntity !== null) {
    engine.removeEntity(orbit.wallRayEntity)
    orbit.wallRayEntity = null
  }
  localThrow.active = false
  localThrow.sawVisual = false
  localThrow.startMs = 0
  cooldown.lastFireTime = Date.now()
  cooldown.extraCooldown = 3
  updateHandBoomerangVisibility()
}

export function updateOrbitVisual(_dt: number): void {
  if (!orbit.active || orbit.entity === null) return

  const now = Date.now()
  const elapsed = now - orbit.startMs
  if (now > orbit.endMs) {
    stopOrbitVisual()
    return
  }

  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  const timeUntilEnd = orbit.endMs - now
  let radiusFrac = 1.0
  if (elapsed < ORBIT_RAMP_MS) {
    radiusFrac = elapsed / ORBIT_RAMP_MS
  } else if (timeUntilEnd < ORBIT_RAMP_MS) {
    radiusFrac = timeUntilEnd / ORBIT_RAMP_MS
  }
  radiusFrac = radiusFrac * radiusFrac * (3 - 2 * radiusFrac) // smoothstep
  const radius = ORBIT_VISUAL_RADIUS * radiusFrac

  const currentAngle = orbit.startAngle + ORBIT_VISUAL_SPEED * (elapsed / 1000)
  const radians = currentAngle * (Math.PI / 180)

  const orbitX = playerPos.x + Math.sin(radians) * radius
  const orbitZ = playerPos.z + Math.cos(radians) * radius
  const orbitY = playerPos.y + 1.0

  const axialSpin = (elapsed / 1000) * 1080

  const t = Transform.getMutable(orbit.entity)
  t.position = Vector3.create(orbitX, orbitY, orbitZ)
  t.scale = PROJECTILE_SCALE
  t.rotation = Quaternion.fromEulerDegrees(0, currentAngle + 90 + axialSpin, 0)
}
