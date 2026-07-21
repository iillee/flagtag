import {
  coinRespawnTimerAfterRollback,
  completeCoinClaim,
  getRespawnableCoinIds,
  reserveCoinClaim,
  rollbackCoinClaim,
} from '../src/server/coinClaimLifecycle'

describe('coin claim lifecycle', () => {
  describe('when the current wallet award fails', () => {
    let cooldowns: Set<string>
    let pendingClaims: Map<string, number>
    let coinId: string
    let token: number
    let rolledBack: boolean

    beforeEach(() => {
      cooldowns = new Set()
      pendingClaims = new Map()
      coinId = 'coin_1_2_3'
      token = 1
      reserveCoinClaim(cooldowns, pendingClaims, coinId, token)
      rolledBack = rollbackCoinClaim(cooldowns, pendingClaims, coinId, token)
    })

    afterEach(() => {
      cooldowns.clear()
      pendingClaims.clear()
    })

    it('should restore the reserved coin', () => {
      expect(cooldowns.has(coinId)).toBe(false)
    })

    it('should report that the reservation was rolled back', () => {
      expect(rolledBack).toBe(true)
    })
  })

  describe('when an old wallet award fails after a newer claim owns the coin', () => {
    let cooldowns: Set<string>
    let pendingClaims: Map<string, number>
    let coinId: string
    let oldToken: number
    let newToken: number
    let rolledBack: boolean

    beforeEach(() => {
      cooldowns = new Set()
      pendingClaims = new Map()
      coinId = 'coin_1_2_3'
      oldToken = 1
      newToken = 2
      reserveCoinClaim(cooldowns, pendingClaims, coinId, oldToken)
      reserveCoinClaim(cooldowns, pendingClaims, coinId, newToken)
      rolledBack = rollbackCoinClaim(cooldowns, pendingClaims, coinId, oldToken)
    })

    afterEach(() => {
      cooldowns.clear()
      pendingClaims.clear()
    })

    it('should preserve the newer cooldown', () => {
      expect(cooldowns.has(coinId)).toBe(true)
    })

    it('should preserve the newer reservation token', () => {
      expect(pendingClaims.get(coinId)).toBe(newToken)
    })

    it('should reject the stale rollback', () => {
      expect(rolledBack).toBe(false)
    })
  })

  describe('when a wallet award is still pending', () => {
    let cooldowns: Set<string>
    let pendingClaims: Map<string, number>
    let coinId: string
    let respawnableIds: string[]

    beforeEach(() => {
      cooldowns = new Set()
      pendingClaims = new Map()
      coinId = 'coin_1_2_3'
      reserveCoinClaim(cooldowns, pendingClaims, coinId, 1)
      respawnableIds = getRespawnableCoinIds(cooldowns, pendingClaims)
    })

    afterEach(() => {
      cooldowns.clear()
      pendingClaims.clear()
      respawnableIds = []
    })

    it('should keep the coin out of the respawn pool', () => {
      expect(respawnableIds).toEqual([])
    })
  })

  describe('when a wallet award completes successfully', () => {
    let cooldowns: Set<string>
    let pendingClaims: Map<string, number>
    let coinId: string
    let respawnableIds: string[]

    beforeEach(() => {
      cooldowns = new Set()
      pendingClaims = new Map()
      coinId = 'coin_1_2_3'
      reserveCoinClaim(cooldowns, pendingClaims, coinId, 1)
      completeCoinClaim(pendingClaims, coinId, 1)
      respawnableIds = getRespawnableCoinIds(cooldowns, pendingClaims)
    })

    afterEach(() => {
      cooldowns.clear()
      pendingClaims.clear()
      respawnableIds = []
    })

    it('should make the cooldown eligible for normal respawn', () => {
      expect(respawnableIds).toEqual([coinId])
    })
  })

  describe('when the final collected coin is restored after an award failure', () => {
    let cooldowns: Set<string>
    let currentTimerSeconds: number
    let nextTimerSeconds: number

    beforeEach(() => {
      cooldowns = new Set()
      currentTimerSeconds = 30
      nextTimerSeconds = coinRespawnTimerAfterRollback(currentTimerSeconds, cooldowns)
    })

    afterEach(() => {
      cooldowns.clear()
      currentTimerSeconds = 0
      nextTimerSeconds = 0
    })

    it('should reset the cooldown clock before the next pickup', () => {
      expect(nextTimerSeconds).toBe(0)
    })
  })

  describe('when another collected coin remains after an award failure', () => {
    let cooldowns: Set<string>
    let currentTimerSeconds: number
    let nextTimerSeconds: number

    beforeEach(() => {
      cooldowns = new Set(['coin_4_5_6'])
      currentTimerSeconds = 12
      nextTimerSeconds = coinRespawnTimerAfterRollback(currentTimerSeconds, cooldowns)
    })

    afterEach(() => {
      cooldowns.clear()
      currentTimerSeconds = 0
      nextTimerSeconds = 0
    })

    it('should preserve the shared cooldown clock', () => {
      expect(nextTimerSeconds).toBe(currentTimerSeconds)
    })
  })
})
