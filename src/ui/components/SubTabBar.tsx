/**
 * SubTabBar — Horizontal tab switcher (Daily / Monthly / All Time, etc.)
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { S, WHITE, MUTED } from '../uiConstants'
import { playClickSound } from '../uiSounds'

interface SubTabBarProps {
  tabs: string[]
  keys: string[]
  active: string
  onChange: (key: string) => void
}

export function SubTabBar({ tabs: tabLabels, keys, active, onChange }: SubTabBarProps) {
  return (
    <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'row', height: S(32) }}>
      {tabLabels.map((label, i) => (
        <UiEntity key={`tab-${keys[i]}`} uiTransform={{ flexGrow: 1, flexDirection: 'row' }}>
          {i > 0 && <UiEntity uiTransform={{ width: S(6) }} />}
          <UiEntity
            uiTransform={{ flexGrow: 1, height: S(32), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: S(6) }}
            uiBackground={{ color: active === keys[i] ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
            onMouseDown={() => { playClickSound(); onChange(keys[i]) }}
          >
            <Label value={label} fontSize={S(16)} color={active === keys[i] ? WHITE : MUTED} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      ))}
    </UiEntity>
  )
}
