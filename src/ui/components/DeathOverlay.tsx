/**
 * DeathOverlay — Full-screen death message with fade, coin penalty, and respawn timer.
 * Reused for drown, lightning, and ghost deaths.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { S, CORAL_RED, LIGHT_GREY } from '../uiConstants'
import { isDeathPenaltyVisible, getLastDeathPenalty } from '../../systems/deathPenaltySystem'

interface DeathOverlayProps {
  visible: boolean
  message: string
  fadeOpacity: number
  showText: boolean
  respawnCountdown: number
}

export function DeathOverlay({ visible, message, fadeOpacity, showText, respawnCountdown }: DeathOverlayProps) {
  if (!visible) return null
  const mobile = isMobile()
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: S(0), left: S(0) },
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
      }}
      uiBackground={{ color: Color4.create(0, 0, 0, fadeOpacity) }}
    >
      {showText && (
        <Label value={message} fontSize={mobile ? 72 : S(42)} color={CORAL_RED} font="sans-serif" />
      )}
      {showText && isDeathPenaltyVisible() && (
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { top: S(8) } }}>
          <UiEntity
            uiTransform={{ width: mobile ? 24 : S(20), height: mobile ? 24 : S(20), margin: { right: mobile ? 6 : S(6) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }}
          />
          <Label value={`-${getLastDeathPenalty()}`} fontSize={mobile ? 48 : S(28)} color={CORAL_RED} font="sans-serif" />
        </UiEntity>
      )}
      {showText && <UiEntity uiTransform={{ height: S(12) }} />}
      {showText && (
        <Label value={`Respawning in ${Math.ceil(respawnCountdown)}...`} fontSize={mobile ? 36 : S(20)} color={LIGHT_GREY} font="sans-serif" />
      )}
    </UiEntity>
  )
}
