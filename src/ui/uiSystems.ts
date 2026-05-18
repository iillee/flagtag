/**
 * uiSystems.ts — All ECS systems that drive UI state.
 *
 * Keeps engine.addSystem() calls out of the render file.
 * Call `registerUiSystems()` once from main() or setupUi().
 */
import { engine, AudioSource, Transform, inputSystem, InputAction, PointerEventType } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'

import { getCountdownSeconds, CountdownTimer } from '../shared/components'
import { room } from '../shared/messages'
import { getKnownPlayerName } from '../gameState/flagHoldTime'
import { consumePendingRoundEarnings } from '../gameState/roundEarnings'
import { applyDeferredBalance } from '../systems/coinPickupSystem'
import { clearMushroomShield } from '../systems/mushroomSystem'
import { isSpectatorMode } from '../systems/spectatorSystem'
import { musicEntity } from '../index'

import { getServerConnectionStatus, cycleUIScale } from './uiConstants'
import { playTickSound } from './uiSounds'
import {
  cinematicState,
  creditsState, CREDIT_LINES, CREDIT_LINE_DURATION,
  blessingState, markBlessingCompleted,
  earnedState, EARNED_TEXT_DELAY, EARNED_COIN_DELAY, COIN_SOUND_INTERVAL,
  splashState, SPLASH_DURATION_MS,
  serverDownState, SERVER_DOWN_GRACE_SEC, SERVER_DOWN_CONFIRM_SEC, SERVER_DOWN_RESHOW_SEC,
  countdownState,
  musicState,
  notifyOverlayClosed, isAnyOverlayOpen,
  flashUIScale,
} from './uiState'
import {
  getWinConditionOverlayVisible, setWinConditionOverlayVisible,
  getLeaderboardOverlayVisible, setLeaderboardOverlayVisible,
  getAnalyticsOverlayVisible, setAnalyticsOverlayVisible,
} from '../gameState/overlayState'

let _registered = false

export function registerUiSystems() {
  if (_registered) return
  _registered = true

  // ── Credit line rotation ──
  engine.addSystem((dt: number) => {
    if (!creditsState.nextRoundVisible && !creditsState.noScorersVisible) {
      creditsState.lineTimer = 0
      creditsState.lineIndex = 0
      return
    }
    creditsState.lineTimer += dt
    if (creditsState.lineTimer >= CREDIT_LINE_DURATION && creditsState.lineIndex < CREDIT_LINES.length - 1) {
      creditsState.lineTimer = 0
      creditsState.lineIndex++
    }
  })

  // ── Blessing timer countdown ──
  engine.addSystem((dt: number) => {
    if (!blessingState.active) return
    blessingState.timer -= dt

    if (blessingState.timer <= 0) {
      markBlessingCompleted(true)
      blessingState.active = false
      blessingState.timer = 0
      blessingState.fadeOut = 1
      room.send('requestBlessing', { t: 0 })
    }
  })

  // ── Blessing text fade-out ──
  const BLESSING_FADE_DURATION = 2.0
  engine.addSystem((dt: number) => {
    if (blessingState.fadeOut <= 0) return
    const next = blessingState.fadeOut - dt / BLESSING_FADE_DURATION
    blessingState.fadeOut = next <= 0.01 ? 0 : next
  })

  // ── Blessing completed: coin sounds + fly animation + auto-dismiss ──
  const BLESSING_COIN_COUNT = 6
  const BLESSING_COIN_SOUND_INTERVAL = 0.18
  const BLESSING_FLY_DURATION = 1.2
  engine.addSystem((_dt: number) => {
    if (!blessingState.completed) return

    const elapsed = (Date.now() - blessingState.completedAt) / 1000

    if (blessingState.alreadyUsed) {
      if (elapsed > 4) {
        blessingState.completed = false
        blessingState.coinProgress = 0
        blessingState.coinSoundsPlayed = 0
      }
      return
    }

    blessingState.coinProgress = Math.min(1, elapsed / BLESSING_FLY_DURATION)

    const soundsDue = Math.min(BLESSING_COIN_COUNT, Math.floor(elapsed / BLESSING_COIN_SOUND_INTERVAL) + 1)
    if (blessingState.coinSoundsPlayed < soundsDue) {
      blessingState.coinSoundsPlayed = soundsDue
      const snd = engine.addEntity()
      Transform.create(snd, { position: Vector3.Zero() })
      AudioSource.create(snd, {
        audioClipUrl: 'assets/sounds/coin.mp3',
        playing: true,
        volume: 0.7,
        loop: false,
        global: true,
      })
    }

    if (elapsed > 4) {
      blessingState.completed = false
      blessingState.coinProgress = 0
      blessingState.coinSoundsPlayed = 0
    }
  })

  // ── Round earnings UI timing ──
  engine.addSystem((dt: number) => {
    const pending = consumePendingRoundEarnings()
    if (pending) {
      earnedState.pendingLocal = pending
      earnedState.winsFrozen = true
    }

    const creditsShowing = creditsState.nextRoundVisible && !cinematicState.showing
    const wasVisible = earnedState.wasNextRoundVisible

    if (!wasVisible && creditsShowing && earnedState.pendingLocal) {
      earnedState.activeRoundEarnings = earnedState.pendingLocal
      earnedState.pendingLocal = null
      earnedState.visible = true
      earnedState.timer = 0
      earnedState.phase = 'text'
      earnedState.coinsFlyProgress = 0
      earnedState.soundPlayed = false
    }

    if (wasVisible && !creditsShowing && earnedState.visible) {
      earnedState.phase = 'done'
      earnedState.visible = false
      earnedState.activeRoundEarnings = null
    }
    earnedState.wasNextRoundVisible = creditsShowing

    if (!earnedState.visible || !earnedState.activeRoundEarnings) return

    earnedState.timer += dt
    const earnings = earnedState.activeRoundEarnings!

    if (earnedState.phase === 'text' && earnedState.timer >= EARNED_TEXT_DELAY + EARNED_COIN_DELAY) {
      earnedState.phase = 'coins'
      earnedState.timer = 0
      earnedState.coinSoundsPlayed = 0
      earnedState.coinSoundTimer = 0
      if (!earnedState.soundPlayed) {
        earnedState.soundPlayed = true
        applyDeferredBalance(earnings.newBalance)
        earnedState.winsFrozen = false
        earnedState.displayedWins = null
      }
    } else if (earnedState.phase === 'coins') {
      const totalCoins = earnings.total
      const totalSoundDuration = Math.max(1.0, totalCoins * COIN_SOUND_INTERVAL)
      earnedState.coinSoundTimer += dt
      if (earnedState.coinSoundsPlayed < totalCoins && earnedState.coinSoundTimer >= COIN_SOUND_INTERVAL) {
        earnedState.coinSoundTimer -= COIN_SOUND_INTERVAL
        earnedState.coinSoundsPlayed++
        const snd = engine.addEntity()
        Transform.create(snd, { position: Vector3.Zero() })
        AudioSource.create(snd, {
          audioClipUrl: 'assets/sounds/coin.mp3',
          playing: true,
          volume: 0.7,
          loop: false,
          global: true,
        })
      }
      earnedState.coinsFlyProgress = Math.min(1, earnedState.timer / totalSoundDuration)
      if (earnedState.coinsFlyProgress >= 1) {
        earnedState.phase = 'fly'
        earnedState.timer = 0
      }
    }
  })

  // ── Round-end splash ──
  engine.addSystem((_dt: number) => {
    const now = Date.now()
    for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
      if (timer.roundEndTriggered && timer.roundWinnerJson && timer.roundWinnerJson !== splashState.lastRoundWinnerJson) {
        splashState.lastRoundWinnerJson = timer.roundWinnerJson
        splashState.visible = true
        splashState.hideTime = now + SPLASH_DURATION_MS
        clearMushroomShield()

        try {
          const serverData = JSON.parse(timer.roundWinnerJson) as Array<{ userId?: string; name: string; seconds: number }>
          splashState.players = serverData.slice(0, 3).map(p => ({
            name: (p.userId ? getKnownPlayerName(p.userId) : null) || p.name,
            seconds: p.seconds,
          }))
          splashState.winnerUserId = (serverData.length > 0 && serverData[0].userId) ? serverData[0].userId : null
        } catch {
          splashState.players = []
          splashState.winnerUserId = null
        }

        if (true) {
          const trumpet = splashState.trumpetEntity
          if (trumpet) engine.removeEntity(trumpet)
          const t = engine.addEntity()
          Transform.create(t, { position: Vector3.Zero() })
          AudioSource.create(t, {
            audioClipUrl: 'assets/sounds/trumpets.mp3',
            playing: true,
            volume: 0.8,
            loop: false,
            global: true,
          })
          splashState.trumpetEntity = t
        }
      }
      break
    }

    if (splashState.visible && !cinematicState.showing && now >= splashState.hideTime) {
      splashState.visible = false
      splashState.players = []
      splashState.winnerUserId = null
      const trumpet = splashState.trumpetEntity
      if (trumpet) {
        engine.removeEntity(trumpet)
        splashState.trumpetEntity = null
      }
    }
  })

  // ── Countdown tick (last 10 seconds) ──
  engine.addSystem(() => {
    const seconds = getCountdownSeconds()
    if (seconds > 0 && seconds <= 10 && seconds !== countdownState.lastTickSecond) {
      countdownState.lastTickSecond = seconds
      playTickSound()
    }
    if (seconds > 30) countdownState.lastTickSecond = -1
  })

  // ── Server-down detection ──
  engine.addSystem((dt: number) => {
    serverDownState.sceneLoadElapsed += dt
    if (serverDownState.sceneLoadElapsed < SERVER_DOWN_GRACE_SEC) return

    const connected = getServerConnectionStatus() === 'Y'
    if (connected) {
      serverDownState.timer = 0
      serverDownState.visible = false
      serverDownState.dismissedAt = 0
    } else {
      serverDownState.timer += dt
      if (serverDownState.timer >= SERVER_DOWN_CONFIRM_SEC) {
        if (serverDownState.dismissedAt === 0) {
          serverDownState.visible = true
        } else if (Date.now() - serverDownState.dismissedAt >= SERVER_DOWN_RESHOW_SEC * 1000) {
          serverDownState.visible = true
          serverDownState.dismissedAt = 0
        }
      }
    }
  })

  // ── Key 2 — toggle music mute ──
  engine.addSystem(() => {
    if (inputSystem.isTriggered(InputAction.IA_ACTION_4, PointerEventType.PET_DOWN)) {
      musicState.muted = !musicState.muted
      try {
        const audio = AudioSource.getMutable(musicEntity)
        audio.volume = musicState.muted ? 0 : 0.175
      } catch (e) {
        console.error('[UI] Failed to toggle music mute:', e)
      }
    }
  })

  // ── Key 1 — cycle UI scale ──
  engine.addSystem(() => {
    if (inputSystem.isTriggered(InputAction.IA_ACTION_3, PointerEventType.PET_DOWN)) {
      if (!isSpectatorMode() && !isMobile()) {
        cycleUIScale()
        flashUIScale()
      }
    }
  })

  // ── Key 4 — close any open overlay ──
  engine.addSystem(() => {
    if (inputSystem.isTriggered(InputAction.IA_ACTION_6, PointerEventType.PET_DOWN)) {
      let closed = false
      if (getWinConditionOverlayVisible()) { setWinConditionOverlayVisible(false); closed = true }
      if (getLeaderboardOverlayVisible()) {
        setLeaderboardOverlayVisible(false)
        closed = true
      }
      if (getAnalyticsOverlayVisible()) { setAnalyticsOverlayVisible(false); closed = true }
      if (closed) { notifyOverlayClosed() }
    }
  })
}
