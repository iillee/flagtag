import {
  engine, Transform, GltfContainer, pointerEventsSystem, InputAction, AudioSource
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { showMailboxPopup, hideMailboxPopup, isMailboxPopupVisible } from '../ui'

const MAILBOX_MODEL = 'assets/models/MailPost_01/MailPost_01.glb'
const CLOSE_DISTANCE = 5

const attachedEntities = new Set<number>()
const mailboxPositions: ReturnType<typeof Vector3.create>[] = []

export function mailboxSystem() {
  // Close popup if player walks away from all mailboxes
  if (isMailboxPopupVisible() && Transform.has(engine.PlayerEntity)) {
    const playerPos = Transform.get(engine.PlayerEntity).position
    const nearAny = mailboxPositions.some(pos => Vector3.distance(playerPos, pos) <= CLOSE_DISTANCE)
    if (!nearAny) hideMailboxPopup()
  }

  // Scan for any mailbox model entities we haven't attached to yet
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    if (attachedEntities.has(entity)) continue
    const gltf = GltfContainer.get(entity)
    if (gltf.src !== MAILBOX_MODEL) continue

    const pos = Transform.get(entity).position
    mailboxPositions.push(Vector3.create(pos.x, pos.y, pos.z))

    const soundEntity = engine.addEntity()
    Transform.create(soundEntity, { position: pos })
    AudioSource.create(soundEntity, {
      audioClipUrl: 'assets/sounds/mailbox.mp3',
      playing: false, loop: false, volume: 1, global: false
    })

    pointerEventsSystem.onPointerDown(
      { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Leave a Message', maxDistance: 5 } },
      () => {
        AudioSource.createOrReplace(soundEntity, {
          audioClipUrl: 'assets/sounds/mailbox.mp3',
          playing: true, loop: false, volume: 1, global: false
        })
        showMailboxPopup()
      }
    )

    attachedEntities.add(entity)
    console.log(`[Mailbox] Click handler attached (${attachedEntities.size})`)
  }
}
