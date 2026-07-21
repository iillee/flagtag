import { AsyncSerialQueue } from '../src/server/asyncSerialQueue'

describe('serialized leaderboard mutations', () => {
  describe('when a second mutation is queued while the first is pending', () => {
    let queue: AsyncSerialQueue
    let events: string[]
    let releaseFirst: () => void
    let firstGate: Promise<void>
    let firstTask: jest.MockedFunction<() => Promise<void>>
    let secondTask: jest.MockedFunction<() => Promise<void>>
    let firstResult: Promise<void>
    let secondResult: Promise<void>
    let expectedEvents: string[]

    beforeEach(() => {
      queue = new AsyncSerialQueue()
      events = []
      expectedEvents = ['first-start', 'first-end', 'second-start']
      releaseFirst = () => undefined
      firstGate = new Promise(resolve => { releaseFirst = resolve })
      firstTask = jest.fn(async () => {
        events.push('first-start')
        await firstGate
        events.push('first-end')
      })
      secondTask = jest.fn(async () => {
        events.push('second-start')
      })
      firstResult = queue.run(firstTask)
      secondResult = queue.run(secondTask)
    })

    afterEach(async () => {
      releaseFirst()
      await Promise.allSettled([firstResult, secondResult])
      events = []
      jest.resetAllMocks()
    })

    it('should complete mutations strictly in FIFO order', async () => {
      releaseFirst()
      await Promise.all([firstResult, secondResult])
      expect(events).toEqual(expectedEvents)
    })
  })
})
