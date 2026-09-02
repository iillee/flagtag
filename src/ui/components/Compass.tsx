/**
 * Compass.tsx — Top-of-screen compass HUD.
 *
 * Renders a horizontal bar with N / E / S / W markers that slide based on the
 * camera's yaw. The marker aligned with the center caret is whatever direction
 * the player is currently facing.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4, Vector3 } from '@dcl/sdk/math'
import { engine, Transform } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { PANEL_BG } from '../uiConstants'

const CARDINALS: { label: string; deg: number; color: Color4 }[] = [
  { label: 'N', deg: 0,   color: Color4.White() },
  { label: 'E', deg: 90,  color: Color4.White() },
  { label: 'S', deg: 180, color: Color4.White() },
  { label: 'W', deg: 270, color: Color4.White() },
]

/** Get camera yaw in degrees (0 = north / +Z, clockwise). */
function getCameraYawDeg(): number {
  const t = Transform.getOrNull(engine.CameraEntity)
  if (!t) return 0
  // Rotate forward vector (0,0,1) by camera rotation, read heading from x/z.
  const f = Vector3.rotate(Vector3.Forward(), t.rotation)
  let yaw = Math.atan2(f.x, f.z) * (180 / Math.PI)
  if (yaw < 0) yaw += 360
  return yaw
}

export function Compass() {
  const mobile = isMobile()
  const width = mobile ? 640 : 520
  const height = mobile ? 34 : 26
  const yaw = getCameraYawDeg()

  // Show markers within +/- 90 degrees of the current heading.
  const halfSpan = 90
  const pxPerDeg = (width / 2) / halfSpan

  const markers: any[] = []
  for (const c of CARDINALS) {
    // Signed angular delta in range (-180, 180].
    let delta = c.deg - yaw
    while (delta > 180) delta -= 360
    while (delta < -180) delta += 360
    if (Math.abs(delta) > halfSpan) continue

    const centerX = width / 2 + delta * pxPerDeg
    const labelWidth = mobile ? 40 : 30
    markers.push(
      <Label
        key={c.label}
        value={c.label}
        fontSize={mobile ? 22 : 16}
        color={c.color}
        font="sans-serif"
        textAlign="middle-center"
        uiTransform={{
          positionType: 'absolute',
          position: { top: 0, left: centerX - labelWidth / 2 },
          width: labelWidth,
          height,
        }}
      />
    )
  }

  return (
    <UiEntity
      uiTransform={{
        width,
        height,
        positionType: 'relative',
        borderRadius: 8,
        margin: { bottom: 2 },
      }}
      uiBackground={{ color: PANEL_BG }}
    >
      <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'relative', pointerFilter: 'none' }}>
        {markers}
        {/* Center caret */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: -4, left: width / 2 - 1 },
            width: 2,
            height: height + 8,
          }}
          uiBackground={{ color: Color4.White() }}
        />
      </UiEntity>
    </UiEntity>
  )
}
