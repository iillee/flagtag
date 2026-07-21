import type { BoomerangColor } from '../gameState/boomerangColor'

export function canUseBoomerangAbility(
  equippedColor: string | undefined,
  requiredColor: BoomerangColor
): boolean {
  return (equippedColor ?? 'r') === requiredColor
}
