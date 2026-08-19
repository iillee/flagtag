import { RESERVED_ENTITY_NUMBERS, describeEntityId, isReservedEntity } from '../src/shared/entityRange'

/** Pack an entity number and version the way @dcl/ecs does: version in the high 16 bits. */
function toEntityId(entityNumber: number, entityVersion: number): number {
  return ((entityNumber & 0xffff) | ((entityVersion & 0xffff) << 16)) >>> 0
}

describe('isReservedEntity', () => {
  describe('when the entity is a renderer static entity at version zero', () => {
    it('should report the root entity as reserved', () => {
      expect(isReservedEntity(toEntityId(0, 0))).toBe(true)
    })

    it('should report the player entity as reserved', () => {
      expect(isReservedEntity(toEntityId(1, 0))).toBe(true)
    })
  })

  describe('when the entity is an avatar slot at version zero', () => {
    it('should report the lowest avatar slot as reserved', () => {
      expect(isReservedEntity(toEntityId(32, 0))).toBe(true)
    })
  })

  describe('when the entity is a recycled avatar slot, so its packed id exceeds the reserved bound', () => {
    let recycledAvatarSlot: number

    beforeEach(() => {
      recycledAvatarSlot = toEntityId(32, 1)
    })

    it('should pack to 65568, above the reserved bound', () => {
      expect(recycledAvatarSlot).toBe(65568)
    })

    it('should still report it as reserved, which a raw comparison against the bound would not', () => {
      expect(isReservedEntity(recycledAvatarSlot)).toBe(true)
    })
  })

  describe('when the entity is an avatar slot at a high version', () => {
    it('should report slot 33 version 39 as reserved', () => {
      expect(isReservedEntity(toEntityId(33, 39))).toBe(true)
    })

    it('should report the top avatar slot at the maximum version as reserved', () => {
      expect(isReservedEntity(toEntityId(255, 0xffff))).toBe(true)
    })
  })

  describe('when the entity is the first scene-owned number', () => {
    it('should report it as not reserved at version zero', () => {
      expect(isReservedEntity(toEntityId(RESERVED_ENTITY_NUMBERS, 0))).toBe(false)
    })

    it('should report it as not reserved at a non-zero version', () => {
      expect(isReservedEntity(toEntityId(RESERVED_ENTITY_NUMBERS, 7))).toBe(false)
    })
  })

  describe('when the entity is the highest reserved number', () => {
    it('should report it as reserved', () => {
      expect(isReservedEntity(toEntityId(RESERVED_ENTITY_NUMBERS - 1, 3))).toBe(true)
    })
  })

  describe('when the entity is a typical scene-allocated id', () => {
    it('should report it as not reserved', () => {
      expect(isReservedEntity(toEntityId(746, 0))).toBe(false)
    })
  })
})

describe('describeEntityId', () => {
  describe('when the entity is a recycled avatar slot', () => {
    it('should render the packed id with its decomposed number and version', () => {
      expect(describeEntityId(65568)).toBe('65568 (#32 v1)')
    })
  })

  describe('when the entity is a scene-owned id at version zero', () => {
    it('should render version zero explicitly', () => {
      expect(describeEntityId(746)).toBe('746 (#746 v0)')
    })
  })
})
