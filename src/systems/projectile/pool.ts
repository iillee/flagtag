/**
 * Projectile entity pool — pre-creates entities per boomerang color to avoid
 * GltfContainer model swaps (which trigger a rendering bug).
 */
import { engine, Transform, GltfContainer, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { stopProjectileSound } from './sound'
import { getBoomerangModelSrc, onBoomerangColorChange } from '../../gameState/boomerangColor'
import { hand } from './state'

const POOL_SIZE_PER_COLOR = 10
const BOOMERANG_COLORS = ['r', 'y', 'b', 'g'] as const
const projectilePoolByColor: Map<string, Entity[]> = new Map()
let projectilePoolReady = false
const PROJECTILE_HIDDEN_POS = Vector3.create(0, -200, 0)

export function initProjectilePool(): void {
  if (projectilePoolReady) return
  projectilePoolReady = true
  let totalCreated = 0
  for (const color of BOOMERANG_COLORS) {
    const pool: Entity[] = []
    for (let i = 0; i < POOL_SIZE_PER_COLOR; i++) {
      const e = engine.addEntity()
      Transform.create(e, { position: PROJECTILE_HIDDEN_POS, scale: Vector3.Zero() })
      GltfContainer.create(e, {
        src: `assets/models/boomerang.${color}.glb`,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
      pool.push(e)
      totalCreated++
    }
    projectilePoolByColor.set(color, pool)
  }
  console.log('[Projectile] 🎯 Pre-created', totalCreated, 'projectile visuals (', POOL_SIZE_PER_COLOR, 'per color)')
}

// Update hand boomerang when color changes
onBoomerangColorChange((_color) => {
  const newSrc = getBoomerangModelSrc()
  if (hand.entity !== null && GltfContainer.has(hand.entity)) {
    GltfContainer.getMutable(hand.entity).src = newSrc
  }
  console.log('[Projectile] Updated hand model to', newSrc)
})

export function acquireProjectileFromPool(color: string): Entity | null {
  initProjectilePool()
  const validColor = BOOMERANG_COLORS.includes(color as any) ? color : 'r'
  const pool = projectilePoolByColor.get(validColor)
  if (!pool) return null
  for (const e of pool) {
    const t = Transform.get(e)
    if (t.position.y < -100) return e
  }
  console.error('[Projectile] 🎯 Pool exhausted for color', validColor, '! All', POOL_SIZE_PER_COLOR, 'in use.')
  return null
}

export function releaseProjectileToPool(entity: Entity): void {
  stopProjectileSound(entity)
  const t = Transform.getMutable(entity)
  t.position = PROJECTILE_HIDDEN_POS
  t.scale = Vector3.Zero()
}
