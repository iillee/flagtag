import {
  engine,
  Entity,
  Transform,
  GltfContainer,
  MeshRenderer,
  Material,
  TextShape,
  AudioSource,
  LightSource,
  Tween,
  EasingFunction,
  TriggerArea,
  triggerAreaEventsSystem,
  PlayerIdentityData,
  Schemas,
  GltfNodeModifiers,
  VisibilityComponent,
  MaterialTransparencyMode
} from '@dcl/sdk/ecs'
import { Color3, Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { onLeaveScene } from '@dcl/sdk/players'

enum PortalState {
  CLOSED = 0,
  AJAR = 1,
  OPEN = 2,
}

export type PortalOptions = {
  position: { x: number; y: number; z: number }
  rotation?: { x: number; y: number; z: number }
  size?: number
  thumbnail?: string
  name?: string
  usersCount?: number
  door?: {
    offsetX?: number  // local X from root center (applied to both sides symmetrically)
    offsetY?: number  // local Y from root center
    offsetZ?: number  // local Z from root center
    separation?: number  // X distance from center to each panel (half the gap between doors)
    scale?: number  // uniform scale of each door panel
  }
  //new and updated parameters
  locationId: string
  enable?: boolean
  callback?: () => void
}

const PortalData = engine.defineComponent('portal-data', {
  doorLeft: Schemas.Entity,
  doorRight: Schemas.Entity,
  state: Schemas.Number,   // mirrors PortalState enum (CLOSED=0, AJAR=1, OPEN=2)
  openCount: Schemas.Array(Schemas.String),
  ajarCount: Schemas.Array(Schemas.String),
  closeCount: Schemas.Array(Schemas.String),
})

const PortalLayer = engine.defineComponent('portal-layer', {
  baseWorldX: Schemas.Number,  // portal center in world space (for parallax + distance reference)
  baseWorldY: Schemas.Number,
  baseWorldZ: Schemas.Number,
  baseLocalX: Schemas.Number,  // resting local X (frame offset) — parallax adds on top
  baseLocalY: Schemas.Number,  // resting local Y (frame offset) — parallax adds on top
  localZ: Schemas.Number,  // this layer's fixed local Z (preserved every frame)
  parallaxStrength: Schemas.Number,  // negative = window effect (inner layers shift opposite to cam)
  parallaxLimit: Schemas.Number,  // max local offset in meters
  lerpSpeed: Schemas.Number,  // how fast this layer follows the target (outer=fast, inner=slow)
  currentOffsetX: Schemas.Number,  // smoothed parallax offset, updated each frame
  currentOffsetY: Schemas.Number,
  baseScale: Schemas.Number,  // nominal scale at construction
  distanceScaleFactor: Schemas.Number,  // scale sensitivity to player distance (0 = outer, max = inner)
  portalRotX: Schemas.Number,  // portal root rotation quaternion — used to project cam offset into local space
  portalRotY: Schemas.Number,
  portalRotZ: Schemas.Number,
  portalRotW: Schemas.Number,
})

let _parallaxActive = false
// Rotate vector (vx, vy, vz) by the inverse (conjugate) of unit quaternion (qx, qy, qz, qw).
// This transforms a world-space vector into the local space of an entity with that rotation.
function rotateByInverseQuat(
  vx: number, vy: number, vz: number,
  qx: number, qy: number, qz: number, qw: number
): { x: number; y: number; z: number } {
  // conjugate flips the xyz components
  const cx = -qx, cy = -qy, cz = -qz
  const tx = 2 * (cy * vz - cz * vy)
  const ty = 2 * (cz * vx - cx * vz)
  const tz = 2 * (cx * vy - cy * vx)
  return {
    x: vx + qw * tx + cy * tz - cz * ty,
    y: vy + qw * ty + cz * tx - cx * tz,
    z: vz + qw * tz + cx * ty - cy * tx,
  }
}

function portalParallaxSystem(dt: number) {

  let anyActive = false
  for (const [, data] of engine.getEntitiesWith(PortalData)) {
    if (data.state !== PortalState.CLOSED) { anyActive = true; break }
  }
  if (!anyActive) {
    engine.removeSystem(portalParallaxSystem)
    _parallaxActive = false
    return
  }

  const cam = Transform.getOrNull(engine.CameraEntity)

  const clamp = (v: number, limit: number) => limit > 0 ? Math.max(-limit, Math.min(limit, v)) : v

  for (const [entity] of engine.getEntitiesWith(PortalLayer)) {
    const layer = PortalLayer.getMutable(entity)

    let targetX = 0, targetY = 0
    if (cam) {
      // Project world-space (portal → camera) offset into the portal's local frame so that
      // parallax shifts correctly regardless of the portal's rotation.
      const local = rotateByInverseQuat(
        layer.baseWorldX - cam.position.x,
        layer.baseWorldY - cam.position.y,
        layer.baseWorldZ - cam.position.z,
        layer.portalRotX, layer.portalRotY, layer.portalRotZ, layer.portalRotW,
      )
      targetX = clamp(local.x * layer.parallaxStrength, layer.parallaxLimit)
      targetY = clamp(local.y * layer.parallaxStrength, layer.parallaxLimit * 1.3)
    }

    // Lerp current offset toward target — inner layers (low lerpSpeed) trail behind
    const factor = Math.min(layer.lerpSpeed * dt, 1)
    layer.currentOffsetX += (targetX - layer.currentOffsetX) * factor
    layer.currentOffsetY += (targetY - layer.currentOffsetY) * factor

    Transform.getMutable(entity).position = Vector3.create(layer.baseLocalX + layer.currentOffsetX, layer.baseLocalY + layer.currentOffsetY, layer.localZ)

    // Distance-based scale — inner layers react more; near = bigger, far = smaller
    if (cam && layer.distanceScaleFactor > 0) {
      const dx = cam.position.x - layer.baseWorldX
      const dy = cam.position.y - layer.baseWorldY
      const dz = cam.position.z - layer.baseWorldZ
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const scaleMod = (DIST_REFERENCE - dist) * layer.distanceScaleFactor
      const newScale = Math.max(0.01, layer.baseScale * (1 + scaleMod))
      Transform.getMutable(entity).scale = Vector3.create(newScale, newScale, newScale)
    }
  }

}

function activateParallax() {
  if (_parallaxActive) return
  engine.addSystem(portalParallaxSystem)
  _parallaxActive = true
}

const LAYER_COUNT = 18
const LAYER_SCALE = 0.35    // ← tune this to fit portalLayer2.glb inside the frame opening
const LAYER_GAP = 0.001   // z-separation between layers (outer = 0, inner = furthest back)
const LAYER_Z_OFFSET = -0.05    // global Z shift applied to all layers (positive = push further back)
const LAYER_Y_STEP = 0.07    // y offset added per layer — positive = inner layers rise, negative = drop
const SCALE_MIN = 0.2    // innermost layer scale multiplier (relative to LAYER_SCALE * size)
const SCALE_CURVE = 0.9    // perspective curve exponent: <1 = big outer gaps + tight inner, 1 = linear
const MAX_PARALLAX = 0.5  // absolute max parallax strength (inner layer)
const MAX_LIMIT = 1    // max local offset clamp (inner layer), meters
const LERP_SPEED_OUTER = 80   // outer layer response speed (instant-ish)
const LERP_SPEED_INNER = 15   // inner layer response speed (laggy trail)
const DIST_REFERENCE = 4    // distance (meters) at which scale is neutral
const DIST_SCALE_OUTER = 0    // scale sensitivity for outermost layer (no effect)
const DIST_SCALE_INNER = 0.04 // scale sensitivity for innermost layer (4% per meter)

// Door defaults — tune these to fit door.glb inside the frame
const DOOR_OFFSET_X = 0      // local X base (mirrored per side)
const DOOR_OFFSET_Y = -1.6   // local Y
const DOOR_OFFSET_Z = -0.05  // local Z (slightly in front of frame)
const DOOR_SEPARATION = 1      // X distance from center to each panel center
const DOOR_SCALE = 1.0    // uniform scale of each door panel
const DOOR_OPEN_DIST = 6      // player distance (m) at which doors fully open
const DOOR_AJAR_DIST = 10     // player distance (m) at which doors start cracking open
const DOOR_CLOSE_DIST = 15     // player distance (m) at which doors fully close
const DOOR_AJAR_AMOUNT = 0.4    // how open the door is in the intermediate zone (0–1)
const DOOR_OPEN_ANGLE = 145     // degrees each panel swings open
const DOOR_TWEEN_DURATION = 1500  // ms — matches original lerp feel (ease-out, ~87% at 2s)

const FRAME_OFFSET = { x: 0, y: -1.6, z: 0.16 }  // layers share this offset to align with the frame
// Approximate world-space Y of the arch opening midpoint above the portal root.
// portalBody lifts by -FRAME_OFFSET.y, arch opening is ~3 m tall → midpoint ≈ 1.5 m above root
const PORTAL_CENTER_Y_OFFSET = 2.5

// Info card — unified panel above the portal (thumbnail + label on a shared background)
const INFO_CARD_POS = { x: 0, y: 4.55, z: -0.4 }  // above portal, slightly in front (Y raised to match floor-level root convention)
const INFO_CARD_SCALE = { x: 0.85, y: 0.85, z: 1 }
const INFO_CARD_TILT = -12                          // X-rotation degrees — top leans toward player

// ─────────────────────────────────────────────────────────────────
// Portal class
// ─────────────────────────────────────────────────────────────────

export class Portal {
  private root: Entity
  private frame: Entity
  private layers: Entity[]
  private doorLeft: Entity
  private doorRight: Entity
  private audioAmb: Entity
  private audioOpen: Entity
  private audioClose: Entity
  private portalLight: Entity
  private ajarTrigger: Entity
  private openTrigger: Entity
  private closeTrigger: Entity
  private thresholdTrigger: Entity
  private portalBody: Entity
  private infoCard: Entity
  private infoBg: Entity
  private infoLabel: Entity
  private thumbPlane: Entity
  private usersIcon: Entity

  private _name?: string
  private _usersCount?: number
  private _thumbnail?: string
  private _lodSystem?: (dt: number) => void

  constructor(options: PortalOptions) {
    const pos = options.position
    const rot = options.rotation ?? Vector3.Zero()
    const size = options.size ?? 1

    // Root
    this.root = engine.addEntity()

    // Ajar trigger (10 m) — tracks who's inside for AJAR state
    this.ajarTrigger = this.createTriggerZone(
      DOOR_AJAR_DIST,
      (uid) => {
        const d = PortalData.getMutable(this.root)
        d.ajarCount.push(uid)
        d.closeCount.push(uid)
        this.evaluatePortalState()
      },
      (uid) => {
        const d = PortalData.getMutable(this.root)
        d.ajarCount = d.ajarCount.filter(id => !id.startsWith(uid))
        this.evaluatePortalState()
      },
    )

    // Open trigger (6 m) — tracks who's inside for OPEN state
    this.openTrigger = this.createTriggerZone(
      DOOR_OPEN_DIST,
      (uid) => {
        const d = PortalData.getMutable(this.root)
        d.openCount.push(uid)
        this.evaluatePortalState()
      },
      (uid) => {
        const d = PortalData.getMutable(this.root)
        d.openCount = d.openCount.filter(id => !id.startsWith(uid))
        this.evaluatePortalState()
      },
    )

    // Close trigger (15 m) — hysteresis gate: door only closes when this set empties
    this.closeTrigger = this.createTriggerZone(
      DOOR_CLOSE_DIST,
      null,
      (uid) => {
        const d = PortalData.getMutable(this.root)
        d.closeCount = d.closeCount.filter(id => !id.startsWith(uid))
        this.evaluatePortalState()
      },
    )

    //onLeaveScene for correctly cleaning all areas counts on unity-explorer
    onLeaveScene((userId) => {
      if (!userId) return
      const data = PortalData.getMutable(this.root)
      data.ajarCount = data.ajarCount.filter(id => !id.includes(userId))
      data.openCount = data.openCount.filter(id => !id.includes(userId))
      data.closeCount = data.closeCount.filter(id => !id.includes(userId))

      this.evaluatePortalState()
    })

    // Portal body — intermediate entity that scales with `size` (frame, doors, layers, light)
    this.portalBody = engine.addEntity()

    // Frame (outermost arch, decorative)
    this.frame = engine.addEntity()
    Transform.create(this.frame, {
      position: Vector3.create(FRAME_OFFSET.x, FRAME_OFFSET.y, FRAME_OFFSET.z),
      rotation: Quaternion.Identity(),
      scale: Vector3.One(),
      parent: this.portalBody,
    })
    GltfContainer.create(this.frame, { src: 'assets/models/portals/portalFrame.glb' })

    // Orange point light — sits between doors and first layer
    this.portalLight = engine.addEntity()
    Transform.create(this.portalLight, {
      position: Vector3.create(0, 0, 0.2),
      parent: this.portalBody,
    })
    LightSource.create(this.portalLight, {
      type: LightSource.Type.Point({}),
      color: Color3.create(1, 0.4, 0.05),
      intensity: 10000,
    })

    // Audio entities — only ambient loop is used (doors were removed)
    this.audioAmb = this.createAudioEntity('assets/sounds/portals/doorAmb.mp3', true)
    this.audioOpen = this.createAudioEntity('assets/sounds/portalload.mp3', false)
    this.audioClose = this.createAudioEntity('assets/sounds/portalload.mp3', false)

    // Double doors
    const dOpts = options.door ?? {}
    const dX = dOpts.offsetX ?? DOOR_OFFSET_X
    const dY = dOpts.offsetY ?? DOOR_OFFSET_Y
    const dZ = dOpts.offsetZ ?? DOOR_OFFSET_Z
    const dSep = dOpts.separation ?? DOOR_SEPARATION
    const dScl = dOpts.scale ?? DOOR_SCALE

    this.doorLeft = this.createDoor(dX - dSep, dY, dZ, dScl, dScl, this.portalBody)
    this.doorRight = this.createDoor(dX + dSep, dY, dZ, -dScl, dScl, this.portalBody)  // mirrored on X

    PortalData.create(this.root, {
      doorLeft: this.doorLeft,
      doorRight: this.doorRight,
      state: PortalState.CLOSED,
      openCount: [],
      ajarCount: [],
      closeCount: [],
    })

    // Threshold trigger — thin box at door frame, fires callback when player crosses
    this.thresholdTrigger = engine.addEntity()
    Transform.create(this.thresholdTrigger, {
      position: Vector3.create(dX, dY + 1.5, dZ),
      scale: Vector3.create(2.5, 3, 0.3),
      parent: this.root,
    })
    TriggerArea.setBox(this.thresholdTrigger)
    triggerAreaEventsSystem.onTriggerEnter(this.thresholdTrigger, (result) => {
      if (result.trigger?.entity !== engine.PlayerEntity) return
      options.callback && options.callback()
    })

    // Concentric arch layers — i=0 outermost/largest, i=LAYER_COUNT-1 innermost/smallest
    const rotQ = Quaternion.fromEulerDegrees(rot.x, rot.y, rot.z)
    this.layers = Array.from({ length: LAYER_COUNT }, (_, i) => {
      const entity = engine.addEntity()
      const t = i / (LAYER_COUNT - 1)               // 0 → 1 (outer → inner)
      const tC = Math.pow(t, SCALE_CURVE)            // curved t: <1 exponent = big outer gaps
      const scale = 3 * LAYER_SCALE * (1 - tC * (1 - SCALE_MIN))
      const localZ = FRAME_OFFSET.z + LAYER_Z_OFFSET + i * LAYER_GAP
      const localY = FRAME_OFFSET.y + i * LAYER_Y_STEP

      Transform.create(entity, {
        position: Vector3.create(FRAME_OFFSET.x, localY, localZ),
        rotation: Quaternion.Identity(),
        scale: Vector3.create(scale, scale, scale),
        parent: this.portalBody,
      })

      // GLTF attached lazily by the LOD system when player is within range

      PortalLayer.create(entity, {
        baseWorldX: pos.x,
        baseWorldY: pos.y + PORTAL_CENTER_Y_OFFSET * size,
        baseWorldZ: pos.z,
        baseLocalX: FRAME_OFFSET.x,
        baseLocalY: localY,
        localZ,
        parallaxStrength: -t * MAX_PARALLAX,
        parallaxLimit: t * MAX_LIMIT,
        lerpSpeed: LERP_SPEED_OUTER + t * (LERP_SPEED_INNER - LERP_SPEED_OUTER),
        currentOffsetX: 0,
        currentOffsetY: 0,
        baseScale: scale,
        distanceScaleFactor: DIST_SCALE_OUTER + t * (DIST_SCALE_INNER - DIST_SCALE_OUTER),
        portalRotX: rotQ.x,
        portalRotY: rotQ.y,
        portalRotZ: rotQ.z,
        portalRotW: rotQ.w,
      })

      return entity
    })

    // Info card — shared container for background, thumbnail, and label
    this.infoCard = engine.addEntity()
    Transform.create(this.infoCard, {
      position: INFO_CARD_POS,
      rotation: Quaternion.fromEulerDegrees(INFO_CARD_TILT, 0, 0),
      scale: INFO_CARD_SCALE,
      parent: this.root,
    })

    // Background plane — sits behind thumbnail and label
    this.infoBg = engine.addEntity()
    Transform.create(this.infoBg, {
      position: Vector3.create(0, -0.25, +0.02),
      rotation: Quaternion.Identity(),
      scale: Vector3.create(1.5, 2, 1),
      parent: this.infoCard,
    })
    // Info card background removed

    // Thumbnail plane
    this.thumbPlane = engine.addEntity()
    Transform.create(this.thumbPlane, {
      position: Vector3.create(0, 0.65, 0),
      scale: Vector3.create(1.5, 1.5, 1),
      parent: this.infoCard,
    })

    // Info label
    this.infoLabel = engine.addEntity()
    Transform.create(this.infoLabel, {
      position: Vector3.create(0, -0.55, 0.01),
      parent: this.infoCard,
    })

    // Users icon — PNG plane shown next to the connected users count
    this.usersIcon = engine.addEntity()
    Transform.create(this.usersIcon, {
      position: Vector3.create(-0.5, -0.8, 0.0),
      scale: Vector3.create(0.18, 0.18, 1),
      parent: this.infoCard,
    })
    // Users icon removed

    this.update(options)

    // ── LOD: only attach parallax layer GLTFs when player is within 32m ──
    // Layers load in sequence from largest (outer, i=0) → smallest (inner, i=LAYER_COUNT-1)
    // with a small delay between each, so they cascade into view.
    const LOD_DIST = 32
    const LOD_DIST_SQ = LOD_DIST * LOD_DIST
    const LOAD_STEP_DELAY = 0.08 // seconds between each layer appearing
    let loadedCount = 0          // number of layers currently attached (loaded outer → inner)
    let stepTimer = 0
    let inRange = false
    this._lodSystem = (dt: number) => {
      const cam = Transform.getOrNull(engine.CameraEntity)
      const rootT = Transform.getOrNull(this.root)
      if (!cam || !rootT) return
      const dx = cam.position.x - rootT.position.x
      const dy = cam.position.y - rootT.position.y
      const dz = cam.position.z - rootT.position.z
      const distSq = dx * dx + dy * dy + dz * dz
      const shouldLoad = distSq < LOD_DIST_SQ

      if (shouldLoad) {
        if (!inRange) {
          inRange = true
          stepTimer = 0
          const a = AudioSource.getMutable(this.audioOpen)
          a.playing = false
          a.playing = true
        }
        // Stagger-load outer → inner (largest first)
        if (loadedCount < this.layers.length) {
          stepTimer += dt
          while (stepTimer >= LOAD_STEP_DELAY && loadedCount < this.layers.length) {
            stepTimer -= LOAD_STEP_DELAY
            const e = this.layers[loadedCount]
            GltfContainer.createOrReplace(e, { src: 'assets/models/portals/portalLayer2.glb' })
            loadedCount++
          }
        }
      } else {
        if (inRange) {
          inRange = false
          stepTimer = 0
        }
        // Stagger-unload inner → outer (reverse of load order)
        if (loadedCount > 0) {
          stepTimer += dt
          while (stepTimer >= LOAD_STEP_DELAY && loadedCount > 0) {
            stepTimer -= LOAD_STEP_DELAY
            loadedCount--
            const e = this.layers[loadedCount]
            if (GltfContainer.has(e)) GltfContainer.deleteFrom(e)
          }
        }
      }
    }
    engine.addSystem(this._lodSystem)
  }

  update(options: PortalOptions): void {
    const pos = options.position
    const size = options.size ?? 1
    const rotQ = options.rotation
      ? Quaternion.fromEulerDegrees(options.rotation.x, options.rotation.y, options.rotation.z)
      : undefined

    Transform.createOrReplace(this.root, {
      position: Vector3.create(pos.x, pos.y, pos.z),
      rotation: rotQ ?? Quaternion.Identity(),
      scale: Vector3.One(),
    })

    Transform.createOrReplace(this.portalBody, {
      position: Vector3.create(0, -FRAME_OFFSET.y * size, 0),
      rotation: Quaternion.Identity(),
      scale: Vector3.create(size, size, size),
      parent: this.root,
    })


    if (pos || rotQ) {
      for (const entity of this.layers) {
        const layer = PortalLayer.getMutable(entity)
        if (pos) {
          layer.baseWorldX = pos.x
          layer.baseWorldY = pos.y + PORTAL_CENTER_Y_OFFSET * size
          layer.baseWorldZ = pos.z
        }
        if (rotQ) {
          layer.portalRotX = rotQ.x
          layer.portalRotY = rotQ.y
          layer.portalRotZ = rotQ.z
          layer.portalRotW = rotQ.w
        }
      }
    }

    if (options.name !== undefined) this._name = options.name
    if (options.usersCount !== undefined) this._usersCount = options.usersCount
    if (options.thumbnail !== undefined) this._thumbnail = options.thumbnail

    const lines: string[] = []
    const chunks = (this._name || '').match(/.{1,25}(\s|$)|.{1,25}/g) ?? []
    const wrapped = chunks.length > 2
      ? chunks[0]!.trimEnd() + '\n' + chunks[1]!.trimEnd().slice(0, 22) + '...'
      : chunks.join('\n').trimEnd()

    lines.push(wrapped)

    const hasUsers = this._usersCount !== undefined && this._usersCount > 1
    if (hasUsers) {
      lines.push(`<size=1.8>${this._usersCount} users</size>`)
      const posY = Number(this._name?.length) > 25 ? -0.815 : -0.68
      const posX = this._usersCount! >= 100 ? -0.51 : this._usersCount! >= 10 ? -0.44 : -0.385
      Transform.getMutable(this.usersIcon).position = Vector3.create(posX, posY, 0)
    }

    // Info label, users icon, and thumbnail removed — card is invisible
  }

  private fireDoorTween(angle: number): void {
    const tween = (entity: Entity, sign: number) => {
      const angleDx = Math.abs(Math.abs(Quaternion.toEulerAngles(Transform.get(this.doorLeft).rotation).y) - angle)
      const tweenDuration = DOOR_TWEEN_DURATION * angleDx / DOOR_OPEN_ANGLE
      return Tween.createOrReplace(entity, {
        mode: Tween.Mode.Rotate({ start: Transform.get(entity).rotation, end: Quaternion.fromEulerDegrees(0, angle * sign, 0) }),
        duration: tweenDuration,
        easingFunction: EasingFunction.EF_EASEOUTQUAD,
      })
    }
    tween(this.doorLeft, 1)
    tween(this.doorRight, -1)
  }

  private setPortalState(state: PortalState, angle: number, playOpen: boolean, playClose: boolean, playAmb: boolean): void {
    this.fireDoorTween(angle)
    // doorOpen / doorClose sounds removed along with doors
    AudioSource.getMutable(this.audioAmb).playing = playAmb
    PortalData.getMutable(this.root).state = state
    if (state !== PortalState.CLOSED) activateParallax()
  }

  private evaluatePortalState(): void {
    const portalData = PortalData.get(this.root)
    if (portalData.openCount.length > 0) {
      if (portalData.state !== PortalState.OPEN)
        this.setPortalState(PortalState.OPEN, DOOR_OPEN_ANGLE, false, false, true)
    } else if (portalData.ajarCount.length > 0) {
      if (portalData.state === PortalState.CLOSED)
        this.setPortalState(PortalState.AJAR, DOOR_OPEN_ANGLE * DOOR_AJAR_AMOUNT, true, false, true)
    } else if (portalData.closeCount.length === 0) {
      if (portalData.state !== PortalState.CLOSED)
        this.setPortalState(PortalState.CLOSED, 0, false, true, false)
    }
  }

  private getUserId(entity: number): string | undefined {
    const address = PlayerIdentityData.getOrNull(entity as Entity)?.address
    return address
  }

  private createTriggerZone(
    radius: number,
    onEnter: ((uid: string) => void) | null,
    onExit: ((uid: string) => void) | null,
  ): Entity {
    const entity = engine.addEntity()
    Transform.create(entity, {
      position: Vector3.Zero(),
      scale: Vector3.create(radius * 2, radius * 2, radius * 2),
      parent: this.root,
    })
    TriggerArea.setSphere(entity)
    if (onEnter) {
      triggerAreaEventsSystem.onTriggerEnter(entity, (result) => {
        const uid = result?.trigger && this.getUserId(result?.trigger?.entity)
        if (!uid) return
        // onEnter(uid)
        onEnter(`${result?.trigger?.entity}-${uid}`)
      })
    }
    if (onExit) {
      triggerAreaEventsSystem.onTriggerExit(entity, (result) => {
        // const uid = result?.trigger && this.getUserId(result?.trigger?.entity)
        // if (!uid) return
        // onExit(uid)
        onExit(`${result?.trigger?.entity}`)
      })
    }
    return entity
  }

  private createAudioEntity(clipUrl: string, loop: boolean): Entity {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.Zero(), parent: this.root })
    AudioSource.create(entity, { audioClipUrl: clipUrl, playing: false, loop, volume: 1 })
    return entity
  }

  private createDoor(x: number, y: number, z: number, scaleX: number, scaleYZ: number, parent: Entity): Entity {
    const entity = engine.addEntity()
    Transform.create(entity, {
      position: Vector3.create(x, y, z),
      rotation: Quaternion.Identity(),
      scale: Vector3.create(scaleX, scaleYZ, scaleYZ),
      parent,
    })
    // Door mesh removed — entity kept as placeholder so door tween logic doesn't break
    return entity
  }

  destroy(): void {
    if (this._lodSystem) engine.removeSystem(this._lodSystem)
    triggerAreaEventsSystem.removeOnTriggerEnter(this.ajarTrigger)
    triggerAreaEventsSystem.removeOnTriggerExit(this.ajarTrigger)
    triggerAreaEventsSystem.removeOnTriggerEnter(this.openTrigger)
    triggerAreaEventsSystem.removeOnTriggerExit(this.openTrigger)
    triggerAreaEventsSystem.removeOnTriggerEnter(this.closeTrigger)
    triggerAreaEventsSystem.removeOnTriggerExit(this.closeTrigger)
    engine.removeEntityWithChildren(this.root)
  }
}
