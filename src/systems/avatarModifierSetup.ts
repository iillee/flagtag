import { engine, Transform, AvatarModifierArea, AvatarModifierType } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

/**
 * Disables passport UI (clicking on avatars to view profiles) across the
 * entire scene. Prevents accidental passport opens during gameplay.
 *
 * NOTE: The SDK does not provide a way to disable smart wearables/portable
 * experiences. Only AMT_HIDE_AVATARS and AMT_DISABLE_PASSPORTS are available.
 */
export function setupAvatarModifier() {
  const avatarModArea = engine.addEntity()
  Transform.create(avatarModArea, { position: Vector3.create(378, 59, 350) })
  AvatarModifierArea.create(avatarModArea, {
    area: Vector3.create(644, 98, 616),
    modifiers: [AvatarModifierType.AMT_DISABLE_PASSPORTS],
    excludeIds: []
  })
}
