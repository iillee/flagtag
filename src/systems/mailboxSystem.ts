import {
  engine, Transform, pointerEventsSystem, InputAction,
  MeshRenderer, Material, AudioSource
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { showMailboxPopup, hideMailboxPopup, isMailboxPopupVisible } from '../ui'

// Mailbox position/rotation from composite (entity 512)
const MAILBOX_POS = Vector3.create(214.54, 12.54, 286.28)
const MAILBOX_ROT = { x: 0, y: 0.555660605430603, z: 0, w: 0.831409215927124 }
const MATCH_DIST = 2
const MAILBOX_CLOSE_DISTANCE = 5

let mailboxSetup = false

export function mailboxSystem() {
  // Close mailbox popup if player walks away
  if (isMailboxPopupVisible() && Transform.has(engine.PlayerEntity)) {
    const playerPos = Transform.get(engine.PlayerEntity).position
    if (Vector3.distance(playerPos, MAILBOX_POS) > MAILBOX_CLOSE_DISTANCE) {
      hideMailboxPopup()
    }
  }

  if (mailboxSetup) return

  for (const [entity] of engine.getEntitiesWith(Transform)) {
    const t = Transform.get(entity)
    if (Vector3.distance(t.position, MAILBOX_POS) < MATCH_DIST) {
      if (entity === engine.PlayerEntity || entity === engine.CameraEntity) continue

      // Mailbox sound effect
      const mailboxSound = engine.addEntity()
      Transform.create(mailboxSound, { position: MAILBOX_POS })
      AudioSource.create(mailboxSound, {
        audioClipUrl: 'assets/sounds/mailbox.mp3',
        playing: false,
        loop: false,
        volume: 1,
        global: false
      })

      pointerEventsSystem.onPointerDown(
        { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Leave a Message', maxDistance: 5 } },
        () => {
          const a = AudioSource.getMutable(mailboxSound)
          a.currentTime = 0
          a.playing = true
          showMailboxPopup()
        }
      )

      // Place letter.png on front of mailbox
      const yawDeg = 67.5
      const yawRad = (yawDeg * Math.PI) / 180
      // Offset slightly in front of mailbox along its facing direction
      const offsetDist = 0.45
      const letter = engine.addEntity()
      Transform.create(letter, {
        position: Vector3.create(
          MAILBOX_POS.x + Math.sin(yawRad) * (offsetDist - 0.3) - Math.cos(yawRad) * 0.35 - 0.15,
          MAILBOX_POS.y + 0.80,
          MAILBOX_POS.z + Math.cos(yawRad) * (offsetDist - 0.3) + Math.sin(yawRad) * 0.35 - 0.07
        ),
        rotation: Quaternion.fromEulerDegrees(0, yawDeg + 90, 0),
        scale: Vector3.create(0.3, 0.22, 0.3)
      })
      MeshRenderer.setPlane(letter)
      Material.setPbrMaterial(letter, {
        texture: Material.Texture.Common({ src: 'images/letter.png' }),
        roughness: 1,
        metallic: 0,
        specularIntensity: 0
      })

      mailboxSetup = true
      console.log('[Mailbox] Click handler attached')
      return
    }
  }
}
