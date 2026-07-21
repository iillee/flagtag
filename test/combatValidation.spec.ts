import type { BoomerangColor } from '../src/gameState/boomerangColor'
import { canUseBoomerangAbility } from '../src/server/combatValidation'

describe('authoritative boomerang ability validation', () => {
  describe('when the equipped color matches the ability requirement', () => {
    let equippedColor: BoomerangColor
    let requiredColor: BoomerangColor

    beforeEach(() => {
      equippedColor = 'g'
      requiredColor = 'g'
    })

    afterEach(() => {
      equippedColor = 'r'
      requiredColor = 'r'
    })

    it('should authorize the server-side ability request', () => {
      expect(canUseBoomerangAbility(equippedColor, requiredColor)).toBe(true)
    })
  })

  describe('when the equipped color does not match the ability requirement', () => {
    let equippedColor: BoomerangColor
    let requiredColor: BoomerangColor

    beforeEach(() => {
      equippedColor = 'r'
      requiredColor = 'g'
    })

    afterEach(() => {
      equippedColor = 'r'
      requiredColor = 'r'
    })

    it('should reject the server-side ability request', () => {
      expect(canUseBoomerangAbility(equippedColor, requiredColor)).toBe(false)
    })
  })
})
