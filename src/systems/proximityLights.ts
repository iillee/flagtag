import { engine, Transform, LightSource } from '@dcl/sdk/ecs'
import { Vector3, Color3 } from '@dcl/sdk/math'
import { getWorldTime } from '~system/Runtime'

// ── Raw light positions (Blender world coords: x=right, y=forward, z=up) ──
// Transform: DCL_x = bx*5 + 74.75,  DCL_y = bz*5 - 2,  DCL_z = -by*5 + 119.5
const RAW_POSITIONS: [number, number, number][] = [
  [10.4848,4.1663,1.199],[10.2489,6.8299,3.199],[8.7249,5.9563,2.199],
  [7.1663,5.282,3.199],[6.1647,7.0381,3.199],[6.235,8.0283,1.199],
  [6.0043,6.196,2.199],[5.3172,5.8243,1.199],[4.4173,7.7396,1.199],
  [2.7939,7.0782,2.199],[4.4052,5.7578,1.199],[3.2949,4.3069,1.199],
  [2.3091,4.2011,2.199],[3.1317,4.086,3.199],[4.3177,6.8218,3.199],
  [9.0257,7.7614,1.124],[-2.1337,3.709,1.124],[-3.2135,7.1689,1.199],
  [-2.2131,7.9677,1.199],[-3.0993,6.2737,1.199],[1.375,6.0729,2.199],
  [-0.9856,10.0033,1.124],[1.0159,6.1157,1.124],[6.6356,22.0122,1.124],
  [5.0947,-3.0334,1.124],[3.6106,-2.016,1.124],[4.1858,-0.458,1.124],
  [3.9745,0.9536,1.199],[6.9424,1.7586,1.199],[11.3007,2.4434,1.124],
  [10.2204,1.8682,2.199],[11.721,0.558,1.124],[11.6603,-1.5061,1.124],
  [10.948,-0.7658,2.199],[8.6995,1.0803,2.199],[6.2887,0.6768,2.199],
  [6.6304,1.4622,3.199],[5.3009,-0.3142,2.199],[6.326,-1.3393,2.199],
  [8.0268,-1.2277,2.199],[8.6704,-1.0968,3.199],[6.5453,-5.5342,1.124],
  [6.8371,-7.6176,1.124],[11.8096,-5.8286,1.124],[11.617,-9.0831,1.124],
  [11.3805,-10.2596,1.124],[7.9138,-15.2711,1.124],[10.9852,-12.2735,1.124],
  [9.8046,-14.8249,1.124],[9.6757,-7.228,3.199],[10.1584,-8.2161,4.199],
  [11.0962,-8.3129,3.199],[9.8179,-12.2438,4.199],[8.7058,-13.2388,4.199],
  [6.5447,-13.7698,4.199],[3.4068,-17.1039,1.124],[1.7666,-18.4835,1.124],
  [0.0601,-20.6577,1.124],[-3.7734,-18.8694,1.124],[-5.9466,-16.8155,1.124],
  [-6.9622,-15.017,1.124],[-7.8823,-13.2456,1.124],[-7.0687,-10.9904,1.124],
  [-6.8393,-12.0844,2.199],[-5.6601,-10.7579,2.199],[-4.6422,-7.016,1.124],
  [-3.7131,-8.5601,1.124],[-6.3125,-13.8829,4.199],[-5.9538,-11.2351,4.199],
  [-2.7083,-9.9973,4.199],[-0.7731,-11.1266,4.199],[-0.3073,-10.4575,4.199],
  [1.4135,-12.0617,5.199],[3.212,-14.1902,4.199],[-0.1258,-18.6413,4.199],
  [1.3559,-15.2913,5.199],[-2.9567,-18.4014,4.199],[-2.3905,-16.343,6.199],
  [-2.8333,-17.0649,5.199],[-3.287,-14.9287,6.199],[-2.3244,-13.6342,7.199],
  [-2.4776,-12.2987,7.199],[-2.954,-14.0639,6.199],[-4.2304,-14.1583,6.199],
  [-5.6183,-12.7224,5.199],[-1.5544,-14.2663,5.199],[0.4981,-14.6298,5.199],
  [-4.7932,-8.2339,4.199],[-3.5933,-13.0388,8.199],[-3.3966,-11.9811,8.199],
  [-3.1561,-11.076,9.199],[-4.1834,-10.8062,11.199],[-4.0508,-8.7722,11.199],
  [-3.8838,-9.6885,10.199],[-0.0192,-7.8576,4.199],[1.2423,-9.1567,4.199],
  [4.6367,-8.6693,1.124],[2.3379,-7.4073,1.124],[1.3284,-5.7421,2.199],
  [-2.0032,-5.3207,2.199],[-3.1135,-4.6563,3.199],[0.0538,-1.3653,2.199],
  [-1.3252,-1.3086,2.199],[0.9343,2.0755,2.199],[-1.2505,0.4145,1.199],
  [-2.9047,-0.1944,1.199],[-0.7624,-0.8437,1.199],[-3.3468,-5.4507,1.124],
  [0.8331,-2.5812,1.124],[-0.5049,-2.9555,2.199],[0.5446,-4.103,2.199],
  [-4.0937,-3.606,2.199],[-4.1636,-1.4796,2.199],[-5.5171,-3.5304,1.199],
  [-8.4243,-2.315,1.199],[-8.1195,-0.203,1.199],[-3.9623,-1.2102,1.199],
  [-7.1751,2.4334,1.199],[7.9583,-10.9962,3.2213],[6.7674,-11.2761,3.2213],
  [8.0383,-9.0093,3.2213],[9.0614,-8.7795,3.2213]
]

// Convert Blender coords to DCL world coordinates
const LIGHT_POSITIONS: Vector3[] = RAW_POSITIONS.map(([bx, by, bz]) =>
  Vector3.create(-bx * 5 + 74.75 + 176, bz * 5 - 2 + 1, -by * 5 + 119.5 + 136)
)

const MAX_ACTIVE = 8
const LIGHT_COLOR = Color3.create(1.0, 0.85, 0.6) // Warm torch
const LIGHT_INTENSITY = 1200
const LIGHT_RANGE = 35
const CHECK_INTERVAL = 0.25 // seconds between proximity checks
const TIME_CHECK_INTERVAL = 10 // seconds between world time checks

// Night = roughly 6pm (64800s) to 6am (7200s) in DCL time (0-86400 cycle)
const SUNSET_TIME = 64800
const SUNRISE_TIME = 7200

interface LightEntry {
  entity: ReturnType<typeof engine.addEntity>
  pos: Vector3
  active: boolean
}

const lights: LightEntry[] = []
// Pre-allocated arrays for top-N selection (avoids per-check allocations)
const topIdx: number[] = new Array(MAX_ACTIVE).fill(-1)
const topDist: number[] = new Array(MAX_ACTIVE).fill(Infinity)
let checkTimer = 0
let timeCheckTimer = 0
let isNight = false

export function setupProximityLights() {
  for (const pos of LIGHT_POSITIONS) {
    const e = engine.addEntity()
    Transform.create(e, { position: pos })
    LightSource.create(e, {
      type: LightSource.Type.Point({}),
      color: LIGHT_COLOR,
      intensity: LIGHT_INTENSITY,
      range: LIGHT_RANGE,
      active: false
    })

    lights.push({ entity: e, pos, active: false })
  }
  console.log(`[Lights] Created ${lights.length} proximity lights`)
}

export function proximityLightSystem(dt: number) {
  // Periodically check world time to determine day/night
  timeCheckTimer -= dt
  if (timeCheckTimer <= 0) {
    timeCheckTimer = TIME_CHECK_INTERVAL
    getWorldTime({}).then((result) => {
      const seconds = result.seconds % 86400
      isNight = seconds >= SUNSET_TIME || seconds < SUNRISE_TIME
    }).catch(() => {})
  }

  checkTimer -= dt
  if (checkTimer > 0) return
  checkTimer = CHECK_INTERVAL

  // If daytime, turn all lights off
  if (!isNight) {
    for (let i = 0; i < lights.length; i++) {
      if (lights[i].active) {
        lights[i].active = false
        LightSource.getMutable(lights[i].entity).active = false
      }
    }
    return
  }

  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  // Find the MAX_ACTIVE closest lights in a single pass (no allocation, no sort).
  // Maintain a small fixed array of the best candidates seen so far.
  // Track the worst (largest) distance in the best-set so we can reject quickly.
  for (let k = 0; k < MAX_ACTIVE; k++) { topIdx[k] = -1; topDist[k] = Infinity }
  let worstBestDist = Infinity

  for (let i = 0; i < lights.length; i++) {
    const p = lights[i].pos
    const dx = playerPos.x - p.x
    const dy = playerPos.y - p.y
    const dz = playerPos.z - p.z
    const d = dx * dx + dy * dy + dz * dz

    if (d >= worstBestDist) continue // fast reject — farther than all current top 8

    // Find the slot with the largest distance and replace it
    let worstSlot = 0
    for (let k = 1; k < MAX_ACTIVE; k++) {
      if (topDist[k] > topDist[worstSlot]) worstSlot = k
    }
    topIdx[worstSlot] = i
    topDist[worstSlot] = d

    // Recompute worst-best threshold
    worstBestDist = 0
    for (let k = 0; k < MAX_ACTIVE; k++) {
      if (topDist[k] > worstBestDist) worstBestDist = topDist[k]
    }
  }

  // Toggle lights
  for (let i = 0; i < lights.length; i++) {
    let shouldBeActive = false
    for (let k = 0; k < MAX_ACTIVE; k++) {
      if (topIdx[k] === i) { shouldBeActive = true; break }
    }
    if (shouldBeActive !== lights[i].active) {
      lights[i].active = shouldBeActive
      const ls = LightSource.getMutable(lights[i].entity)
      ls.active = shouldBeActive
    }
  }
}
