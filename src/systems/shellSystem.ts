import {
  engine,
  Transform,
  AudioSource,
  GltfContainer,
  inputSystem,
  InputAction,
  PointerEventType,
  InputModifier,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Tween,
  EasingFunction,
  Raycast,
  RaycastResult,
  RaycastQueryType,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { Flag, Shell, SHELL_COOLDOWN_SEC, SHELL_LIFETIME_SEC, SHELL_SPEED, SHELL_MAX_RANGE, SHELL_HIT_RADIUS } from '../shared/components'
import { room } from '../shared/messages'
import { triggerEmote } from '~system/RestrictedActions'

const SHELL_MODEL_SRC = 'assets/scene/Models/shell.glb'
const SHELL_SCALE = Vector3.create(0.01, 0.01, 0.01)
const SHELL_STAGGER_MS = 800
const SHELL_GRAVITY = 15  // m/s² — matches server FLAG_GRAVITY
const GROUND_RAY_INTERVAL = 0.05 // seconds between ground raycasts for moving shells

// Stagger state for shell hits
let shellStaggerUntil = 0

// ── Sound ──
let shellFireSoundEntity: Entity | null = null
let shellHitSoundEntity: Entity | null = null

function playShellFireSound(position: Vector3): void {
  if (!shellFireSoundEntity) {
    shellFireSoundEntity = engine.addEntity()
    Transform.create(shellFireSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(shellFireSoundEntity, {
      audioClipUrl: 'assets/sounds/rs-miss.mp3',  // TODO: replace with shell fire sound
      playing: false,
      loop: false,
      volume: 0.8,
      global: false
    })
  }
  const t = Transform.getMutable(shellFireSoundEntity)
  t.position = position
  const a = AudioSource.getMutable(shellFireSoundEntity)
  a.currentTime = 0
  a.playing = true
}

function playShellHitSound(position: Vector3): void {
  if (!shellHitSoundEntity) {
    shellHitSoundEntity = engine.addEntity()
    Transform.create(shellHitSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(shellHitSoundEntity, {
      audioClipUrl: 'assets/sounds/rs-hit.mp3',  // TODO: replace with shell hit sound
      playing: false,
      loop: false,
      volume: 1.0,
      global: false
    })
  }
  const t = Transform.getMutable(shellHitSoundEntity)
  t.position = position
  const a = AudioSource.getMutable(shellHitSoundEntity)
  a.currentTime = 0
  a.playing = true
}

// ── Hit VFX pool ──
const SHELL_VFX_POOL_SIZE = 6
const SHELL_VFX_DURATION_MS = 500
const shellVfxPool: Entity[] = []
let shellVfxPoolIdx = 0
let shellVfxPoolReady = false
const HIDDEN_POS = Vector3.create(0, -100, 0)
const activeShellVfx: { entity: Entity; expiresAt: number }[] = []

const SHELL_VFX_MATERIAL = {
  albedoColor: Color4.create(1.0, 0.3, 0.2, 0.7),
  emissiveColor: Color4.create(1.0, 0.2, 0.1, 1),
  emissiveIntensity: 2.0,
  roughness: 1.0,
  metallic: 0.0,
  specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
}

function initShellVfxPool(): void {
  if (shellVfxPoolReady) return
  shellVfxPoolReady = true
  for (let i = 0; i < SHELL_VFX_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, SHELL_VFX_MATERIAL)
    shellVfxPool.push(e)
  }
}

function showShellHitEffect(position: Vector3): void {
  initShellVfxPool()
  const expiresAt = Date.now() + SHELL_VFX_DURATION_MS + 50

  for (let i = 0; i < 3; i++) {
    const sphere = shellVfxPool[shellVfxPoolIdx % SHELL_VFX_POOL_SIZE]
    shellVfxPoolIdx++

    const jitter = Vector3.create(
      (Math.random() - 0.5) * 0.8,
      Math.random() * 0.3,
      (Math.random() - 0.5) * 0.8
    )
    const pos = Vector3.add(position, jitter)
    const startScale = 0.1 + Math.random() * 0.1
    const endScale = 0.4 + Math.random() * 0.3

    const t = Transform.getMutable(sphere)
    t.position = pos
    t.scale = Vector3.create(startScale, startScale, startScale)

    Tween.createOrReplace(sphere, {
      mode: Tween.Mode.Scale({
        start: Vector3.create(startScale, startScale, startScale),
        end: Vector3.create(endScale, endScale * 0.3, endScale)
      }),
      duration: SHELL_VFX_DURATION_MS,
      easingFunction: EasingFunction.EF_EASEOUTQUAD,
    })

    activeShellVfx.push({ entity: sphere, expiresAt })
  }
}

function hideShellVfx(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = HIDDEN_POS
  t.scale = Vector3.Zero()
  if (Tween.has(entity)) Tween.deleteFrom(entity)
}

// ── Client cooldown tracking ──
let lastLocalShellFireTime = 0

/** Returns true if shell is on cooldown (for UI). */
export function isShellOnCooldown(): boolean {
  if (lastLocalShellFireTime === 0) return false
  return (Date.now() - lastLocalShellFireTime) < SHELL_COOLDOWN_SEC * 1000
}

/** Returns cooldown remaining in seconds (0 if ready). */
export function getShellCooldownRemaining(): number {
  if (lastLocalShellFireTime === 0) return 0
  const elapsed = Date.now() - lastLocalShellFireTime
  const remaining = SHELL_COOLDOWN_SEC * 1000 - elapsed
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

// ── Wall distance raycast ──
interface PendingWallRay {
  entity: Entity
}
const pendingWallRays: PendingWallRay[] = []

function fireWallRaycast(pos: Vector3, dirX: number, dirZ: number): void {
  const rayEntity = engine.addEntity()
  Transform.create(rayEntity, { position: pos })
  Raycast.create(rayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(dirX, 0, dirZ) },
    maxDistance: SHELL_MAX_RANGE,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })
  pendingWallRays.push({ entity: rayEntity })
}

function processWallRaycasts(): void {
  for (let i = pendingWallRays.length - 1; i >= 0; i--) {
    const ray = pendingWallRays[i]
    const result = RaycastResult.getOrNull(ray.entity)
    if (result) {
      if (result.hits.length > 0) {
        const hitDist = result.hits[0].length
        room.send('reportShellWallDist', { shellId: 0, maxDist: hitDist })
      }
      engine.removeEntity(ray.entity)
      pendingWallRays.splice(i, 1)
    }
  }
}

// ── Continuous ground raycasts for server-mode shells ──
// We track synced Shell entities and periodically fire downward raycasts
// from their current position to report ground height to the server.
interface TrackedServerShell {
  rayEntity: Entity | null
  lastRayTime: number
}
const trackedServerShells = new Map<number, TrackedServerShell>() // entity id -> tracking state

function updateServerShellGroundRaycasts(dt: number): void {
  const now = Date.now()

  for (const [entity, shell] of engine.getEntitiesWith(Shell, Transform)) {
    if (!shell.active) continue

    const entityId = entity as number
    let tracked = trackedServerShells.get(entityId)
    if (!tracked) {
      tracked = { rayEntity: null, lastRayTime: 0 }
      trackedServerShells.set(entityId, tracked)
    }

    // Check pending raycast result
    if (tracked.rayEntity !== null) {
      const result = RaycastResult.getOrNull(tracked.rayEntity)
      if (result) {
        if (result.hits.length > 0) {
          const pos = Transform.get(entity).position
          room.send('reportShellGroundY', {
            shellX: pos.x,
            shellZ: pos.z,
            groundY: result.hits[0].position!.y
          })
        }
        engine.removeEntity(tracked.rayEntity)
        tracked.rayEntity = null
      }
    }

    // Fire new ground raycast periodically
    if (tracked.rayEntity === null && now - tracked.lastRayTime > GROUND_RAY_INTERVAL * 1000) {
      tracked.lastRayTime = now
      const pos = Transform.get(entity).position
      const rayEntity = engine.addEntity()
      Transform.create(rayEntity, {
        position: Vector3.create(pos.x, pos.y + 2, pos.z) // start above shell
      })
      Raycast.create(rayEntity, {
        direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
        maxDistance: 200,
        queryType: RaycastQueryType.RQT_HIT_FIRST,
        continuous: false
      })
      tracked.rayEntity = rayEntity
    }
  }

  // Clean up tracking for shells that no longer exist
  for (const [entityId, tracked] of trackedServerShells) {
    if (!Shell.has(entityId as Entity)) {
      if (tracked.rayEntity !== null) {
        engine.removeEntity(tracked.rayEntity)
      }
      trackedServerShells.delete(entityId)
    }
  }
}

// ── Message listeners ──
let messagesRegistered = false

function registerShellMessages(): void {
  if (messagesRegistered) return
  messagesRegistered = true

  room.onMessage('shellDropped', (data) => {
    playShellFireSound(Vector3.create(data.x, data.y, data.z))
  })

  room.onMessage('shellTriggered', (data) => {
    const pos = Vector3.create(data.x, data.y, data.z)

    // All effects in one frame
    showShellHitEffect(pos)
    playShellHitSound(pos)

    // Stagger the victim if it's the local player
    const me = getPlayerData()?.userId
    if (me && data.victimId === me) {
      triggerEmote({ predefinedEmote: 'getHit' })
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: true })
      })
      shellStaggerUntil = Date.now() + SHELL_STAGGER_MS
    }
  })
}

// ── Local test mode (no server) ──
function isServerConnected(): boolean {
  return [...engine.getEntitiesWith(Flag)].length > 0
}

function getPlayerForward(): { dirX: number; dirZ: number } {
  if (!Transform.has(engine.PlayerEntity)) return { dirX: 0, dirZ: 1 }
  const rot = Transform.get(engine.PlayerEntity).rotation
  const forward = Vector3.rotate(Vector3.Forward(), rot)
  const len = Math.sqrt(forward.x * forward.x + forward.z * forward.z)
  if (len < 0.01) return { dirX: 0, dirZ: 1 }
  return { dirX: forward.x / len, dirZ: forward.z / len }
}

interface LocalShell {
  entity: Entity
  firedAtMs: number
  startX: number
  startY: number
  startZ: number
  dirX: number
  dirZ: number
  distanceTraveled: number
  maxDistance: number
  // Wall raycast
  wallRayEntity: Entity | null
  // Gravity + ground tracking
  currentY: number
  fallVelocity: number
  groundY: number
  onGround: boolean
  groundRayEntity: Entity | null
  lastGroundRayTime: number
}
const localShells: LocalShell[] = []

function fireShellLocally(): void {
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position
  const { dirX, dirZ } = getPlayerForward()

  const spawnPos = Vector3.create(
    playerPos.x + dirX * 1.0,
    playerPos.y + 0.2,
    playerPos.z + dirZ * 1.0
  )

  const shellEntity = engine.addEntity()
  Transform.create(shellEntity, {
    position: spawnPos,
    scale: SHELL_SCALE,
    rotation: Quaternion.fromEulerDegrees(0, Math.atan2(dirX, dirZ) * (180 / Math.PI), 0)
  })
  GltfContainer.create(shellEntity, {
    src: SHELL_MODEL_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  // Fire wall raycast (forward)
  const wallRayEntity = engine.addEntity()
  Transform.create(wallRayEntity, { position: spawnPos })
  Raycast.create(wallRayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(dirX, 0, dirZ) },
    maxDistance: SHELL_MAX_RANGE,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })

  localShells.push({
    entity: shellEntity,
    firedAtMs: Date.now(),
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX,
    dirZ,
    distanceTraveled: 0,
    maxDistance: SHELL_MAX_RANGE,
    wallRayEntity,
    currentY: spawnPos.y,
    fallVelocity: 0,
    groundY: 0,
    onGround: false,
    groundRayEntity: null,
    lastGroundRayTime: 0,
  })
  playShellFireSound(spawnPos)
  console.log('[Shell] 🐚 LOCAL shell fired dir:', dirX.toFixed(2), dirZ.toFixed(2))
}

function removeLocalShell(index: number): void {
  const shell = localShells[index]
  if (shell.wallRayEntity !== null) engine.removeEntity(shell.wallRayEntity)
  if (shell.groundRayEntity !== null) engine.removeEntity(shell.groundRayEntity)
  engine.removeEntity(shell.entity)
  localShells.splice(index, 1)
}

function updateLocalShells(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = localShells.length - 1; i >= 0; i--) {
    const shell = localShells[i]

    // Check wall raycast result
    if (shell.wallRayEntity !== null) {
      const result = RaycastResult.getOrNull(shell.wallRayEntity)
      if (result) {
        if (result.hits.length > 0) {
          shell.maxDistance = Math.min(shell.maxDistance, result.hits[0].length)
        }
        engine.removeEntity(shell.wallRayEntity)
        shell.wallRayEntity = null
      }
    }

    // Check ground raycast result
    if (shell.groundRayEntity !== null) {
      const result = RaycastResult.getOrNull(shell.groundRayEntity)
      if (result) {
        if (result.hits.length > 0) {
          shell.groundY = result.hits[0].position!.y
        }
        engine.removeEntity(shell.groundRayEntity)
        shell.groundRayEntity = null
      }
    }

    // Fire new ground raycast periodically
    if (shell.groundRayEntity === null && now - shell.lastGroundRayTime > GROUND_RAY_INTERVAL * 1000) {
      shell.lastGroundRayTime = now
      const pos = Transform.get(shell.entity).position
      shell.groundRayEntity = engine.addEntity()
      Transform.create(shell.groundRayEntity, {
        position: Vector3.create(pos.x, pos.y + 2, pos.z)
      })
      Raycast.create(shell.groundRayEntity, {
        direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
        maxDistance: 200,
        queryType: RaycastQueryType.RQT_HIT_FIRST,
        continuous: false
      })
    }

    // Safety expiry
    if (now - shell.firedAtMs > SHELL_LIFETIME_SEC * 1000) {
      console.log('[Shell] 🐚 LOCAL shell expired')
      removeLocalShell(i)
      continue
    }

    // Move forward on XZ
    const moveDistance = SHELL_SPEED * clampedDt
    shell.distanceTraveled += moveDistance

    // Hit wall
    if (shell.distanceTraveled >= shell.maxDistance) {
      const shellPos = Transform.get(shell.entity).position
      console.log('[Shell] 🐚 LOCAL shell hit wall at', shell.distanceTraveled.toFixed(1), 'm')
      showShellHitEffect(shellPos)
      playShellHitSound(shellPos)
      removeLocalShell(i)
      continue
    }

    // Apply gravity
    if (!shell.onGround) {
      shell.fallVelocity += SHELL_GRAVITY * clampedDt
      shell.currentY -= shell.fallVelocity * clampedDt
      if (shell.currentY <= shell.groundY) {
        shell.currentY = shell.groundY
        shell.fallVelocity = 0
        shell.onGround = true
      }
    } else {
      // Follow terrain
      const diff = shell.groundY - shell.currentY
      if (Math.abs(diff) < 0.05) {
        shell.currentY = shell.groundY
      } else if (diff > 0) {
        // Ground rising — snap up
        shell.currentY = shell.groundY
      } else {
        // Ground dropping — fall again
        shell.onGround = false
        shell.fallVelocity = 0
      }
    }

    // Update position
    const newX = shell.startX + shell.dirX * shell.distanceTraveled
    const newZ = shell.startZ + shell.dirZ * shell.distanceTraveled
    const t = Transform.getMutable(shell.entity)
    t.position = Vector3.create(newX, shell.currentY, newZ)
  }
}

// ── Main client system ──
export function shellClientSystem(dt: number): void {
  registerShellMessages()

  const now = Date.now()
  const serverUp = isServerConnected()

  // Release shell stagger freeze
  if (shellStaggerUntil > 0 && now >= shellStaggerUntil) {
    shellStaggerUntil = 0
    if (InputModifier.has(engine.PlayerEntity)) {
      InputModifier.deleteFrom(engine.PlayerEntity)
    }
  }

  // Clean up expired VFX
  for (let i = activeShellVfx.length - 1; i >= 0; i--) {
    if (now >= activeShellVfx[i].expiresAt) {
      hideShellVfx(activeShellVfx[i].entity)
      activeShellVfx.splice(i, 1)
    }
  }

  if (serverUp) {
    // Process wall raycasts
    processWallRaycasts()
    // Continuously report ground Y for moving shells
    updateServerShellGroundRaycasts(dt)
  } else {
    // Local test mode
    updateLocalShells(dt)
  }

  // Key 1 — fire shell
  // Key 3 — fire shell
  if (inputSystem.isTriggered(InputAction.IA_ACTION_5, PointerEventType.PET_DOWN)) {
    const userId = getPlayerData()?.userId
    if (!userId) return

    // Client-side cooldown check
    if (now - lastLocalShellFireTime < SHELL_COOLDOWN_SEC * 1000) {
      const remaining = ((SHELL_COOLDOWN_SEC * 1000 - (now - lastLocalShellFireTime)) / 1000).toFixed(1)
      console.log('[Shell] 1 pressed but cooldown active —', remaining, 's remaining')
      return
    }

    lastLocalShellFireTime = now
    const { dirX, dirZ } = getPlayerForward()

    if (serverUp) {
      console.log('[Shell] 🐚 1 pressed — requesting shell fire (server)')
      room.send('requestShell', { dirX, dirZ })

      // Fire a wall raycast and report it to the server
      if (Transform.has(engine.PlayerEntity)) {
        const playerPos = Transform.get(engine.PlayerEntity).position
        const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.2, playerPos.z + dirZ * 1.0)
        fireWallRaycast(spawnPos, dirX, dirZ)
      }
    } else {
      console.log('[Shell] 🐚 1 pressed — firing shell locally (no server)')
      fireShellLocally()
    }
  }
}
