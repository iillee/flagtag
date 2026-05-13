/**
 * KeyBinding — Displays a key badge [E] with label text. Used in How to Play.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { WHITE, MUTED } from '../uiConstants'

interface KeyBindingProps {
  keyLabel: string
  text: string
  s: (v: number) => number
  last?: boolean
}

export function KeyBinding({ keyLabel, text, s, last }: KeyBindingProps) {
  return (
    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: last ? undefined : { bottom: s(10) } }}>
      <UiEntity uiTransform={{ width: s(34), height: s(30), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: s(5), margin: { right: s(8) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}>
        <Label value={keyLabel} fontSize={s(16)} color={WHITE} font="sans-serif" />
      </UiEntity>
      <Label value={text} fontSize={s(13)} color={MUTED} font="sans-serif" />
    </UiEntity>
  )
}
