import {
  beginTrackedRitual,
  consumeTrackedRitualClaim,
  invalidateRitualsOutsideAllowedArea,
  isRitualClaimTimely,
  isWithinDistance,
  type Point3,
} from '../src/server/actionValidation'

describe('server action validation', () => {
  describe('when a player is within the allowed interaction radius', () => {
    let player: Point3
    let target: Point3
    let radius: number

    beforeEach(() => {
      player = { x: 3, y: 0, z: 4 }
      target = { x: 0, y: 0, z: 0 }
      radius = 5
    })

    afterEach(() => {
      player = { x: 0, y: 0, z: 0 }
      target = { x: 0, y: 0, z: 0 }
      radius = 0
    })

    it('should accept the interaction at the radius boundary', () => {
      expect(isWithinDistance(player, target, radius)).toBe(true)
    })
  })

  describe('when a player supplies a non-finite position', () => {
    let player: Point3
    let target: Point3
    let radius: number

    beforeEach(() => {
      player = { x: Number.NaN, y: 0, z: 0 }
      target = { x: 0, y: 0, z: 0 }
      radius = 5
    })

    afterEach(() => {
      player = { x: 0, y: 0, z: 0 }
      target = { x: 0, y: 0, z: 0 }
      radius = 0
    })

    it('should reject the interaction', () => {
      expect(isWithinDistance(player, target, radius)).toBe(false)
    })
  })

  describe('when a ritual claim follows the full ritual duration', () => {
    let startedAtMs: number
    let nowMs: number

    beforeEach(() => {
      startedAtMs = 1_000
      nowMs = 33_000
    })

    afterEach(() => {
      startedAtMs = 0
      nowMs = 0
    })

    it('should accept the claim', () => {
      expect(isRitualClaimTimely(startedAtMs, nowMs)).toBe(true)
    })
  })

  describe('when a ritual claim arrives immediately', () => {
    let startedAtMs: number
    let nowMs: number

    beforeEach(() => {
      startedAtMs = 1_000
      nowMs = 2_000
    })

    afterEach(() => {
      startedAtMs = 0
      nowMs = 0
    })

    it('should reject the claim', () => {
      expect(isRitualClaimTimely(startedAtMs, nowMs)).toBe(false)
    })
  })

  describe('when an active ritual player leaves the allowed pedestal area', () => {
    let ritualStarts: Map<string, number>
    let isPlayerAllowed: jest.MockedFunction<(playerId: string) => boolean>
    let playerId: string

    beforeEach(() => {
      playerId = '0xplayer'
      ritualStarts = new Map([[playerId, 1_000]])
      isPlayerAllowed = jest.fn().mockReturnValueOnce(false)
    })

    afterEach(() => {
      ritualStarts.clear()
      jest.resetAllMocks()
    })

    it('should invalidate the ritual before a later claim', () => {
      invalidateRitualsOutsideAllowedArea(ritualStarts, isPlayerAllowed)
      expect(ritualStarts.has(playerId)).toBe(false)
    })
  })

  describe('when an active ritual player remains inside the allowed pedestal area', () => {
    let ritualStarts: Map<string, number>
    let isPlayerAllowed: jest.MockedFunction<(playerId: string) => boolean>
    let playerId: string

    beforeEach(() => {
      playerId = '0xplayer'
      ritualStarts = new Map([[playerId, 1_000]])
      isPlayerAllowed = jest.fn().mockReturnValueOnce(true)
    })

    afterEach(() => {
      ritualStarts.clear()
      jest.resetAllMocks()
    })

    it('should preserve the ritual start for its eventual claim', () => {
      invalidateRitualsOutsideAllowedArea(ritualStarts, isPlayerAllowed)
      expect(ritualStarts.has(playerId)).toBe(true)
    })
  })

  describe('when blessing eligibility validation is delayed', () => {
    let ritualStarts: Map<string, number>
    let playerId: string
    let beganAtMs: number
    let releaseValidation: (eligible: boolean) => void
    let validationGate: Promise<boolean>
    let isPlayerAllowed: jest.MockedFunction<() => boolean>
    let validateEligibility: jest.MockedFunction<() => Promise<boolean>>
    let validationResult: Promise<boolean>

    beforeEach(() => {
      ritualStarts = new Map()
      playerId = '0xplayer'
      beganAtMs = 1_000
      releaseValidation = () => undefined
      validationGate = new Promise(resolve => { releaseValidation = resolve })
      isPlayerAllowed = jest.fn().mockReturnValueOnce(true)
      validateEligibility = jest.fn().mockReturnValueOnce(validationGate)
      validationResult = beginTrackedRitual({
        ritualStarts,
        playerId,
        beganAtMs,
        isPlayerAllowed,
        validateEligibility,
      })
    })

    afterEach(async () => {
      releaseValidation(true)
      await validationResult
      ritualStarts.clear()
      jest.resetAllMocks()
    })

    it('should expose provisional tracking before the asynchronous work completes', () => {
      expect(ritualStarts.has(playerId)).toBe(true)
    })
  })

  describe('when a provisionally tracked player leaves during delayed validation', () => {
    let ritualStarts: Map<string, number>
    let playerId: string
    let beganAtMs: number
    let releaseValidation: (eligible: boolean) => void
    let validationGate: Promise<boolean>
    let isPlayerAllowed: jest.MockedFunction<() => boolean>
    let validateEligibility: jest.MockedFunction<() => Promise<boolean>>
    let validationResult: Promise<boolean>
    let isStillAllowed: jest.MockedFunction<(trackedPlayerId: string) => boolean>

    beforeEach(() => {
      ritualStarts = new Map()
      playerId = '0xplayer'
      beganAtMs = 1_000
      releaseValidation = () => undefined
      validationGate = new Promise(resolve => { releaseValidation = resolve })
      isPlayerAllowed = jest.fn().mockReturnValueOnce(true)
      validateEligibility = jest.fn().mockReturnValueOnce(validationGate)
      isStillAllowed = jest.fn().mockReturnValueOnce(false)
      validationResult = beginTrackedRitual({
        ritualStarts,
        playerId,
        beganAtMs,
        isPlayerAllowed,
        validateEligibility,
      })
    })

    afterEach(async () => {
      releaseValidation(true)
      await validationResult
      ritualStarts.clear()
      jest.resetAllMocks()
    })

    it('should reject eligibility even if delayed hydration later succeeds', async () => {
      invalidateRitualsOutsideAllowedArea(ritualStarts, isStillAllowed)
      releaseValidation(true)
      await expect(validationResult).resolves.toBe(false)
    })
  })

  describe('when the production ritual lifecycle remains inside the allowed area', () => {
    let ritualStarts: Map<string, number>
    let playerId: string
    let beganAtMs: number
    let claimAccepted: boolean
    let isPlayerAllowed: jest.MockedFunction<() => boolean>
    let validateEligibility: jest.MockedFunction<() => Promise<boolean>>

    beforeEach(async () => {
      ritualStarts = new Map()
      playerId = '0xplayer'
      beganAtMs = 1_000
      isPlayerAllowed = jest.fn().mockReturnValue(true)
      validateEligibility = jest.fn().mockResolvedValueOnce(true)
      await beginTrackedRitual({
        ritualStarts,
        playerId,
        beganAtMs,
        isPlayerAllowed,
        validateEligibility,
      })
      claimAccepted = consumeTrackedRitualClaim(ritualStarts, playerId, 33_000, isPlayerAllowed)
    })

    afterEach(() => {
      ritualStarts.clear()
      jest.resetAllMocks()
    })

    it('should accept one claim after the full ritual duration', () => {
      expect(claimAccepted).toBe(true)
    })
  })

  describe('when the production ritual lifecycle leaves the allowed area before claiming', () => {
    let ritualStarts: Map<string, number>
    let playerId: string
    let beganAtMs: number
    let claimAccepted: boolean
    let isPlayerAllowed: jest.MockedFunction<() => boolean>
    let validateEligibility: jest.MockedFunction<() => Promise<boolean>>
    let isStillAllowed: jest.MockedFunction<(trackedPlayerId: string) => boolean>

    beforeEach(async () => {
      ritualStarts = new Map()
      playerId = '0xplayer'
      beganAtMs = 1_000
      isPlayerAllowed = jest.fn().mockReturnValueOnce(true)
      validateEligibility = jest.fn().mockResolvedValueOnce(true)
      isStillAllowed = jest.fn().mockReturnValueOnce(false)
      await beginTrackedRitual({
        ritualStarts,
        playerId,
        beganAtMs,
        isPlayerAllowed,
        validateEligibility,
      })
      invalidateRitualsOutsideAllowedArea(ritualStarts, isStillAllowed)
      claimAccepted = consumeTrackedRitualClaim(ritualStarts, playerId, 33_000, isPlayerAllowed)
    })

    afterEach(() => {
      ritualStarts.clear()
      jest.resetAllMocks()
    })

    it('should reject the claim even after the required duration elapsed', () => {
      expect(claimAccepted).toBe(false)
    })
  })
})
