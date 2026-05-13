/**
 * StatsRow — Bottom stats bar (Users, Bots, Online, Server, Date, Time, Play, Mute).
 * Reused in MetricsTabContent and AnalyticsOverlay.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { AudioSource } from '@dcl/sdk/ecs'
import { S, LIGHT_GREY, GOLD, _ROW_HEIGHT, formatUTCTime, formatPlaytime } from '../uiConstants'
import { playClickSound } from '../uiSounds'
import { isMusicMuted, toggleMusicMuted, isDiscordReportSent, setDiscordReportSent, ADMIN_ADDRESS } from '../uiState'
import { room } from '../../shared/messages'
import { musicEntity } from '../../index'

interface StatsRowProps {
  visitorCount: number
  botCount: number
  onlineCount: number
  serverConnected: string
  dateLabel: string
  totalPlaytimeMin: number
  localUserId: string | null
}

export function StatsRow({ visitorCount, botCount, onlineCount, serverConnected, dateLabel, totalPlaytimeMin, localUserId }: StatsRowProps) {
  return (
    <UiEntity uiTransform={{ height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}>
      <UiEntity uiTransform={{ width: '12.5%' }}>
        <Label value={`Users: ${visitorCount}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
      </UiEntity>
      <UiEntity uiTransform={{ width: '12.5%' }}>
        <Label value={`Bots: ${botCount}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
      </UiEntity>
      <UiEntity uiTransform={{ width: '12.5%' }}>
        <Label value={`Online: ${onlineCount}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
      </UiEntity>
      <UiEntity uiTransform={{ width: '12.5%' }}>
        <Label value={`Server: ${serverConnected}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
      </UiEntity>
      <UiEntity uiTransform={{ width: '12.5%', height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center' }}
        onMouseDown={localUserId !== null && localUserId.toLowerCase() === ADMIN_ADDRESS ? () => {
          playClickSound()
          room.send('testDiscord', { t: Date.now() })
          setDiscordReportSent(true)
          setTimeout(() => { setDiscordReportSent(false) }, 200)
        } : undefined}
      >
        <Label value={dateLabel} fontSize={S(13)} color={isDiscordReportSent() ? GOLD : LIGHT_GREY} font="sans-serif" />
      </UiEntity>
      <UiEntity uiTransform={{ width: '12.5%' }}>
        <Label value={`${formatUTCTime()}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
      </UiEntity>
      <UiEntity uiTransform={{ width: '12.5%' }}>
        <Label value={`Play: ${formatPlaytime(totalPlaytimeMin)}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
      </UiEntity>
      <UiEntity
        uiTransform={{ width: '12.5%', height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
        onMouseDown={() => { playClickSound(); toggleMusicMuted(); try { AudioSource.getMutable(musicEntity).volume = isMusicMuted() ? 0 : 0.175 } catch {} }}
      >
        <Label value={`Mute: ${isMusicMuted() ? 'Y' : 'N'}`} fontSize={S(13)} color={isMusicMuted() ? GOLD : LIGHT_GREY} font="sans-serif" />
      </UiEntity>
    </UiEntity>
  )
}
