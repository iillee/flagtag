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
import { Vector3, Color4 } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { Flag, Shell, SHELL_COOLDOWN_SEC, SHELL_LIFETIME_SEC, SHELL_TRIGGER_RADIUS } from '../shared/components'
import { room } from '../shared/messages'
import { triggerEmote } from '~system/RestrictedActions'

const SHELL_MODEL_SRC = 'assets/scene/Models/shell.glb'
const SHELL_SCALE = Vector3.create(0.01, 0.01, 0.01)
const SHELL_STAGGER_MS = 800

// Stagger state for shell hits
let shellStaggerUntil = 0

// ── Sound ──
let shellDropSoundEntity: Entity | null = null
let shellHitSoundEntity: Entity | null = null

function playShellDropSound(position: Vector3): void {
  if (!shellDropSoundEntity) {
    shellDropSoundEntity = engine.addEntity()
    Transform.create(shellDropSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(shellDropSoundEntity, {
      audioClipUrl: 'assets/sounds/rs-drop.mp3',  // TODO: replace with shell-specific sound
      playing: false,
      loop: false,
      volume: 0.8,
      global: false
    })
  }
  const t = Transform.getMutable(shellDropSoundEntity)
  t.position = position
  const a = AudioSource.getMutable(shellDropSoundEntity)
  a.currentTime = 0
  a.playing = true
}

function playShellHitSound(position: Vector3): void {
  if (!shellHitSoundEntity) {
    shellHitSoundEntity = engine.addEntity()
    Transform.create(shellHitSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(shellHitSoundEntity, {
      audioClipUrl: 'assets/sounds/rs-hit.mp3',  // TODO: replace with shell-specific sound
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
let lastLocalShellDropTime = 0

/** Returns true if shell is on cooldown (for UI). */
export function isShellOnCooldown(): boolean {
  if (lastLocalShellDropTime === 0) return false
  return (Date.now() - lastLocalShellDropTime) < SHELL_COOLDOWN_SEC * 1000
}

/** Returns cooldown remaining in seconds (0 if ready). */
export function getShellCooldownRemaining(): number {
  if (lastLocalShellDropTime === 0) return 0
  const elapsed = Date.now() - lastLocalShellDropTime
  const remaining = SHELL_COOLDOWN_SEC * 1000 - elapsed
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

// ── Shell ground raycasts ──
interface PendingShellRay {
  entity: Entity
  shellX: number
  shellZ: number
}
const pendingShellRays: PendingShellRay[] = []

function fireShellGroundRaycast(x: number, y: number, z: number): void {
  const rayEntity = engine.addEntity()
  Transform.create(rayEntity, {
    position: Vector3.create(x, y + 0.5, z)
  })
  Raycast.create(rayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
    maxDistance: 200,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })
  pendingShellRays.push({ entity: rayEntity, shellX: x, shellZ: z })
}

function processShellRaycasts(): void {
  for (let i = pendingShellRays.length - 1; i >= 0; i--) {
    const ray = pendingShellRays[i]
    const result = RaycastResult.getOrNull(ray.entity)
    if (result) {
      const groundY = result.hits.length > 0 ? result.hits[0].position!.y : 0
      room.send('reportShellGroundY', { shellX: ray.shellX, shellZ: ray.shellZ, groundY })
      engine.removeEntity(ray.entity)
      pendingShellRays.splice(i, 1)
    }
  }
}

// ── Message listeners ──
let messagesRegistered = false

function registerShellMessages(): void {
  if (messagesRegistered) return
  messagesRegistered = true

  room.onMessage('shellDropped', (data) => {
    playShellDropSound(Vector3.create(data.x, data.y, data.z))
    fireShellGroundRaycast(data.x, data.y, data.z)
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
      if (!InputModifier.has(engine.PlayerEntity)) {
        InputModifier.create(engine.PlayerEntity, {
          mode: InputModifier.Mode.Standard({ disableAll: true })
        })
      }
      shellStaggerUntil = Date.now() + SHELL_STAGGER_MS
    }
  })
}

// ── Local test mode (no server) ──
function isServerConnected(): boolean {
  return [...engine.getEntitiesWith(Flag)].length > 0
}

const LOCAL_GRAVITY = 15
const LOCAL_MIN_Y = 0.5

interface LocalShell {
  entity: Entity
  droppedAtMs: number
  falling: boolean
  fallVelocity: number
  targetY: number
  rayEntity: Entity | null
}
const localShells: LocalShell[] = []

function dropShellLocally(): void {
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position
  const dropPos = Vector3.create(playerPos.x, playerPos.y, playerPos.z)

  const shellEntity = engine.addEntity()
  Transform.create(shellEntity, {
    position: dropPos,
    scale: SHELL_SCALE
  })
  GltfContainer.create(shellEntity, {
    src: SHELL_MODEL_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  // Fire a ground raycast
  const rayEntity = engine.addEntity()
  Transform.create(rayEntity, {
    position: Vector3.create(dropPos.x, dropPos.y + 0.5, dropPos.z)
  })
  Raycast.create(rayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
    maxDistance: 200,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })

  localShells.push({
    entity: shellEntity,
    droppedAtMs: Date.now(),
    falling: true,
    fallVelocity: 0,
    targetY: LOCAL_MIN_Y,
    rayEntity,
  })
  playShellDropSound(dropPos)
  console.log('[Shell] 🐚 LOCAL test shell dropped at', dropPos.x.toFixed(1), dropPos.y.toFixed(1), dropPos.z.toFixed(1))
}

function removeLocalShell(index: number): void {
  const shell = localShells[index]
  if (shell.rayEntity !== null) {
    engine.removeEntity(shell.rayEntity)
  }
  engine.removeEntity(shell.entity)
  localShells.splice(index, 1)
}

function updateLocalShells(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  for (let i = localShells.length - 1; i >= 0; i--) {
    const shell = localShells[i]

    // Check raycast result for ground Y
    if (shell.rayEntity !== null) {
      const result = RaycastResult.getOrNull(shell.rayEntity)
      if (result) {
        const groundY = result.hits.length > 0 ? result.hits[0].position!.y : 0
        shell.targetY = Math.max(LOCAL_MIN_Y, groundY)
        engine.removeEntity(shell.rayEntity)
        shell.rayEntity = null

        const currentY = Transform.get(shell.entity).position.y
        if (currentY <= shell.targetY) {
          const t = Transform.getMutable(shell.entity)
          t.position = Vector3.create(t.position.x, shell.targetY, t.position.z)
          shell.falling = false
          shell.fallVelocity = 0
        }
      }
    }

    // Gravity
    if (shell.falling) {
      shell.fallVelocity += LOCAL_GRAVITY * clampedDt
      const pos = Transform.get(shell.entity).position
      let newY = pos.y - shell.fallVelocity * clampedDt
      if (newY <= shell.targetY) {
        newY = shell.targetY
        shell.falling = false
        shell.fallVelocity = 0
      }
      const t = Transform.getMutable(shell.entity)
      t.position = Vector3.create(pos.x, newY, pos.z)
    }

    // Expiry
    if (now - shell.droppedAtMs > SHELL_LIFETIME_SEC * 1000) {
      console.log('[Shell] 🐚 LOCAL shell expired')
      removeLocalShell(i)
      continue
    }

    // Self-trigger test: walk back over after 1 second grace period
    if (now - shell.droppedAtMs > 1000) {
      const shellPos = Transform.get(shell.entity).position
      const dist = Vector3.distance(playerPos, shellPos)
      if (dist < SHELL_TRIGGER_RADIUS) {
        console.log('[Shell] 🐚 LOCAL shell triggered!')
        showShellHitEffect(shellPos)
        playShellHitSound(shellPos)
        triggerEmote({ predefinedEmote: 'getHit' })
        removeLocalShell(i)
      }
    }
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

  // Process shell ground raycasts (server mode)
  if (serverUp) {
    processShellRaycasts()
  }

  // Update local shells (gravity + expiry + trigger) when in local test mode
  if (!serverUp) {
    updateLocalShells(dt)
  }

  // Key 1 — drop shell
  if (inputSystem.isTriggered(InputAction.IA_ACTION_3, PointerEventType.PET_DOWN)) {
    const userId = getPlayerData()?.userId
    if (!userId) return

    // Client-side cooldown check
    if (now - lastLocalShellDropTime < SHELL_COOLDOWN_SEC * 1000) {
      const remaining = ((SHELL_COOLDOWN_SEC * 1000 - (now - lastLocalShellDropTime)) / 1000).toFixed(1)
      console.log('[Shell] 1 pressed but cooldown active —', remaining, 's remaining')
      return
    }

    lastLocalShellDropTime = now

    if (serverUp) {
      console.log('[Shell] 🐚 1 pressed — requesting shell drop (server)')
      room.send('requestShell', { t: 0 })
    } else {
      console.log('[Shell] 🐚 1 pressed — dropping shell locally (no server)')
      dropShellLocally()
    }
  }
}
