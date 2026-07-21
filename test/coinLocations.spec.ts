import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { coinIdFromPosition } from '../src/shared/coinIds'
import { INTERIOR_COIN_LOCATIONS } from '../src/shared/coinLocations'

interface CompositeComponent {
  name: string
  data: Record<string, { json: Record<string, unknown> }>
}

interface CompositeFile {
  components: CompositeComponent[]
}

function getComponent(composite: CompositeFile, name: string): CompositeComponent {
  const component = composite.components.find(candidate => candidate.name === name)
  if (!component) throw new Error(`Missing composite component: ${name}`)
  return component
}

describe('interior coin locations', () => {
  describe('when deterministic pickup ids are generated', () => {
    let roomIds: string[]
    let uniqueIdCount: number
    let expectedCoinCount: number

    beforeEach(() => {
      roomIds = INTERIOR_COIN_LOCATIONS.map(location =>
        coinIdFromPosition(location.x, location.y, location.z)
      )
      uniqueIdCount = new Set(roomIds).size
      expectedCoinCount = INTERIOR_COIN_LOCATIONS.length
    })

    afterEach(() => {
      roomIds = []
      uniqueIdCount = 0
      expectedCoinCount = 0
    })

    it('should assign a unique id to every room coin', () => {
      expect(uniqueIdCount).toBe(expectedCoinCount)
    })
  })

  describe('when room ids are compared with static composite coins', () => {
    let composite: CompositeFile
    let transforms: CompositeComponent
    let gltfContainers: CompositeComponent
    let staticCoinIds: Set<string>
    let roomIds: string[]
    let collisions: string[]

    beforeEach(() => {
      composite = JSON.parse(
        readFileSync(join(process.cwd(), 'assets/scene/main.composite'), 'utf8')
      ) as CompositeFile
      transforms = getComponent(composite, 'core::Transform')
      gltfContainers = getComponent(composite, 'core::GltfContainer')
      staticCoinIds = new Set()
      for (const [entity, component] of Object.entries(gltfContainers.data)) {
        const src = String(component.json.src ?? '').toLowerCase()
        if (!src.includes('coin_01') && !src.includes('doubloon')) continue
        const position = transforms.data[entity]?.json.position as { x: number; y: number; z: number } | undefined
        if (!position) continue
        staticCoinIds.add(coinIdFromPosition(position.x, position.y, position.z))
      }
      roomIds = INTERIOR_COIN_LOCATIONS.map(location =>
        coinIdFromPosition(location.x, location.y, location.z)
      )
      collisions = roomIds.filter(coinId => staticCoinIds.has(coinId))
    })

    afterEach(() => {
      staticCoinIds.clear()
      roomIds = []
      collisions = []
    })

    it('should avoid sharing a cooldown id with an outdoor coin', () => {
      expect(collisions).toEqual([])
    })
  })
})
