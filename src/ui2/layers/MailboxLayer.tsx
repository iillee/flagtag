import ReactEcs, { UiEntity, Label, Input } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { Background, Layer, ZoneType, getTheme } from '@stom66/dcl-ui-component-kit'

import { CloseButton } from '../../ui/components/CloseButton'
import { S, LIGHT_GREY } from '../../ui/uiConstants'
import { popupState, hideMailboxPopup, notifyOverlayClosed, getMailboxStatus, setMailboxStatus } from '../../ui/uiState'
import { room } from '../../shared/messages'

// MARK: MailboxLayer
// "Leave a Message" modal for player feedback. Input box + Send button;
// status label reflects send-progress / server response.

let feedbackText = ''
let feedbackListenerRegistered = false

function sendFeedback() {
  if (!feedbackText.trim()) { setMailboxStatus('Please type a message first.'); return }
  if (!feedbackListenerRegistered) {
    feedbackListenerRegistered = true
    room.onMessage('feedbackResult', (data: { message: string }) => { setMailboxStatus(data.message) })
  }
  setMailboxStatus('Sending...')
  room.send('sendFeedback', { message: feedbackText.trim() })
  feedbackText = ''
}

export class MailboxLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-mailbox',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!popupState.mailbox) return null
    const theme = getTheme()
    const status = getMailboxStatus()
    const BLUE = Color4.create(0.2, 0.6, 1, 1)

    return [
      <UiEntity
        key="wrap"
        uiTransform={{
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          width: '100%', height: '100%',
          justifyContent: 'center', alignItems: 'center',
          pointerFilter: 'none',
        }}
      >
        <UiEntity
          uiTransform={{
            width: S(480),
            flexDirection: 'column', alignItems: 'center',
            padding: { top: S(24), bottom: S(24), left: S(24), right: S(24) },
          }}
        >
          <Background backgroundColor={theme.colors.body} borderRadius={theme.border.radiusLarge} />
          <CloseButton hoverKey="closeMailbox" onClose={() => { hideMailboxPopup(); notifyOverlayClosed() }} />
          <Label value="Leave a Message" fontSize={S(28)} color={BLUE} font="sans-serif"
            uiTransform={{ margin: { bottom: S(8) } }} />
          <Label value="Leave feedback, report a bug, or just say hi!" fontSize={S(16)} color={LIGHT_GREY}
            uiTransform={{ margin: { top: S(4), bottom: S(12) }, width: S(420), height: S(28) }}
            textAlign="middle-center" />
          <Input
            placeholder="Type your message..."
            fontSize={S(15)}
            color={Color4.White()}
            placeholderColor={Color4.create(0.6, 0.6, 0.6, 1)}
            uiTransform={{ width: S(420), height: S(40), margin: { bottom: S(12) }, borderRadius: S(8), padding: { left: S(8), right: S(8) } }}
            uiBackground={{ color: Color4.create(0.15, 0.15, 0.2, 1) }}
            onChange={(val) => { feedbackText = val }}
            onSubmit={(val) => { feedbackText = val; sendFeedback() }}
            value={feedbackText}
          />
          <UiEntity uiTransform={{ width: S(200), height: S(44), borderRadius: S(8), justifyContent: 'center', alignItems: 'center' }}
            uiBackground={{ color: BLUE }}
            onMouseDown={() => { sendFeedback() }}
          >
            <Label value="Send" fontSize={S(18)} color={Color4.White()}
              uiTransform={{ width: '100%', height: '100%' }} textAlign="middle-center" />
          </UiEntity>
          {status ? (
            <Label value={status} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif"
              uiTransform={{ margin: { top: S(12) }, width: S(360) }} textAlign="middle-center" />
          ) : null}
        </UiEntity>
      </UiEntity>,
    ]
  }
}

export const mailboxLayer = new MailboxLayer()

export function updateMailboxLayerVisibility() {
  if (popupState.mailbox) mailboxLayer.show(0)
  else mailboxLayer.hide(0)
}
