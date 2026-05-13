/**
 * uiSystems.ts — All ECS systems that drive UI state.
 *
 * Keeps engine.addSystem() calls out of the render file.
 * Call `registerUiSystems()` once from main() or setupUi().
 */
import { engine, AudioSource, Transform, inputSystem, InputAction, PointerEventType, PointerEvents, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'

import { getCountdownSeconds, CountdownTimer } from '../shared/components'
import { getKnownPlayerName } from '../gameState/flagHoldTime'
import { consumePendingRoundEarnings } from '../gameState/roundEarnings'
import { applyDeferredBalance } from '../systems/coinPickupSystem'
import { clearMushroomShield } from '../systems/mushroomSystem'
import { isSpectatorMode } from '../systems/spectatorSystem'
import { musicEntity } from '../index'

import { getServerConnectionStatus, cycleUIScale } from './uiConstants'
import { playClickSound, playTickSound } from './uiSounds'
import {
  // Cinematic/credits
  isNextRoundStartingVisible, isNoScorersCreditsVisible,
  getCreditLineIndex, setCreditLineIndex,
  getCreditLineTimer, setCreditLineTimer,
  CREDIT_LINES, CREDIT_LINE_DURATION,
  getCinematicShowing,
  // Earned UI
  getActiveRoundEarnings, setActiveRoundEarnings,
  isEarnedUiVisible, setEarnedUiVisible,
  getEarnedUiTimer, setEarnedUiTimer, addEarnedUiTimer,
  getEarnedUiPhase, setEarnedUiPhase,
  getEarnedCoinsFlyProgress, setEarnedCoinsFlyProgress,
  isEarnedSoundPlayed, setEarnedSoundPlayed,
  getEarnedCoinSoundsPlayed, setEarnedCoinSoundsPlayed,
  getEarnedCoinSoundTimer, addEarnedCoinSoundTimer, setEarnedCoinSoundTimer,
  getPendingEarningsLocal, setPendingEarningsLocal,
  setDisplayedWins, setWinsFrozen,
  getWasNextRoundVisible, setWasNextRoundVisible,
  EARNED_TEXT_DELAY, EARNED_COIN_DELAY, COIN_SOUND_INTERVAL,
  // Splash
  isSplashVisible, setSplashVisible,
  getSplashHideTime, setSplashHideTime,
  getTrumpetEntity, setTrumpetEntity,
  setSplashPlayers, setSplashWinnerUserId,
  getLastSplashRoundWinnerJson, setLastSplashRoundWinnerJson,
  SPLASH_DURATION_MS,
  // Server down
  getSceneLoadElapsed, addSceneLoadElapsed,
  getServerDownTimer, setServerDownTimer, addServerDownTimer,
  isServerDownVisible, setServerDownVisible,
  getServerDownDismissedAt, setServerDownDismissedAt,
  SERVER_DOWN_GRACE_SEC, SERVER_DOWN_CONFIRM_SEC, SERVER_DOWN_RESHOW_SEC,
  // Attack flicker
  ATTACK_FLICKER_MS, setLastAttackPressMs,
  // Tick
  getLastTickSecond, setLastTickSecond,
  // UI scale
  flashUIScale,
  // Music
  isMusicMuted, toggleMusicMuted,
  // Overlay
  notifyOverlayClosed,
  isAnyOverlayOpen,
} from './uiState'
import {
  getWinConditionOverlayVisible, setWinConditionOverlayVisible,
} from '../gameState/winConditionOverlayState'
import {
  getLeaderboardOverlayVisible, setLeaderboardOverlayVisible,
} from '../gameState/leaderboardOverlayState'
import {
  getAnalyticsOverlayVisible, setAnalyticsOverlayVisible,
} from '../gameState/analyticsOverlayState'

let _registered = false

export function registerUiSystems() {
  if (_registered) return
  _registered = true

  // ── Credit line rotation ──
  engine.addSystem((dt: number) => {
    if (!isNextRoundStartingVisible() && !isNoScorersCreditsVisible()) {
      setCreditLineTimer(0)
      setCreditLineIndex(0)
      return
    }
    setCreditLineTimer(getCreditLineTimer() + dt)
    if (getCreditLineTimer() >= CREDIT_LINE_DURATION && getCreditLineIndex() < CREDIT_LINES.length - 1) {
      setCreditLineTimer(0)
      setCreditLineIndex(getCreditLineIndex() + 1)
    }
  })

  // ── Round earnings UI timing ──
  engine.addSystem((dt: number) => {
    const pending = consumePendingRoundEarnings()
    if (pending) {
      setPendingEarningsLocal(pending)
      setWinsFrozen(true)
    }

    const creditsShowing = isNextRoundStartingVisible() && !getCinematicShowing()
    const wasVisible = getWasNextRoundVisible()

    if (!wasVisible && creditsShowing && getPendingEarningsLocal()) {
      setActiveRoundEarnings(getPendingEarningsLocal())
      setPendingEarningsLocal(null)
      setEarnedUiVisible(true)
      setEarnedUiTimer(0)
      setEarnedUiPhase('text')
      setEarnedCoinsFlyProgress(0)
      setEarnedSoundPlayed(false)
    }

    if (wasVisible && !creditsShowing && isEarnedUiVisible()) {
      setEarnedUiPhase('done')
      setEarnedUiVisible(false)
      setActiveRoundEarnings(null)
    }
    setWasNextRoundVisible(creditsShowing)

    if (!isEarnedUiVisible() || !getActiveRoundEarnings()) return

    addEarnedUiTimer(dt)
    const earnings = getActiveRoundEarnings()!

    if (getEarnedUiPhase() === 'text' && getEarnedUiTimer() >= EARNED_TEXT_DELAY + EARNED_COIN_DELAY) {
      setEarnedUiPhase('coins')
      setEarnedUiTimer(0)
      setEarnedCoinSoundsPlayed(0)
      setEarnedCoinSoundTimer(0)
      if (!isEarnedSoundPlayed()) {
        setEarnedSoundPlayed(true)
        applyDeferredBalance(earnings.newBalance)
        setWinsFrozen(false)
        setDisplayedWins(null)
      }
    } else if (getEarnedUiPhase() === 'coins') {
      const totalCoins = earnings.total
      const totalSoundDuration = Math.max(1.0, totalCoins * COIN_SOUND_INTERVAL)
      addEarnedCoinSoundTimer(dt)
      if (getEarnedCoinSoundsPlayed() < totalCoins && getEarnedCoinSoundTimer() >= COIN_SOUND_INTERVAL) {
        setEarnedCoinSoundTimer(getEarnedCoinSoundTimer() - COIN_SOUND_INTERVAL)
        setEarnedCoinSoundsPlayed(getEarnedCoinSoundsPlayed() + 1)
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
      setEarnedCoinsFlyProgress(Math.min(1, getEarnedUiTimer() / totalSoundDuration))
      if (getEarnedCoinsFlyProgress() >= 1) {
        setEarnedUiPhase('fly')
        setEarnedUiTimer(0)
      }
    }
    // 'fly' phase: stays visible until credits screen hides (cleared above)
  })

  // ── Round-end splash ──
  engine.addSystem((_dt: number) => {
    const now = Date.now()
    for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
      if (timer.roundEndTriggered && timer.roundWinnerJson && timer.roundWinnerJson !== getLastSplashRoundWinnerJson()) {
        setLastSplashRoundWinnerJson(timer.roundWinnerJson)
        setSplashVisible(true)
        setSplashHideTime(now + SPLASH_DURATION_MS)
        clearMushroomShield()

        try {
          const serverData = JSON.parse(timer.roundWinnerJson) as Array<{ userId?: string; name: string; seconds: number }>
          setSplashPlayers(serverData.slice(0, 3).map(p => ({
            name: (p.userId ? getKnownPlayerName(p.userId) : null) || p.name,
            seconds: p.seconds,
          })))
          setSplashWinnerUserId((serverData.length > 0 && serverData[0].userId) ? serverData[0].userId : null)
        } catch {
          setSplashPlayers([])
          setSplashWinnerUserId(null)
        }

        if (true) { // play trumpet (only if someone scored — checked inside)
          const trumpet = getTrumpetEntity()
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
          setTrumpetEntity(t)
        }
      }
      break
    }

    if (isSplashVisible() && !getCinematicShowing() && now >= getSplashHideTime()) {
      setSplashVisible(false)
      setSplashPlayers([])
      setSplashWinnerUserId(null)
      const trumpet = getTrumpetEntity()
      if (trumpet) {
        engine.removeEntity(trumpet)
        setTrumpetEntity(null)
      }
    }
  })

  // ── Attack flicker ──
  engine.addSystem(() => {
    if (inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN) && !isAnyOverlayOpen()) {
      const cmd = inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_DOWN)
      const hitEntity = cmd?.hit?.entityId
      if (hitEntity && PointerEvents.has(hitEntity as Entity)) return
      setLastAttackPressMs(Date.now())
    }
  })

  // ── Countdown tick (last 10 seconds) ──
  engine.addSystem(() => {
    const seconds = getCountdownSeconds()
    if (seconds > 0 && seconds <= 10 && seconds !== getLastTickSecond()) {
      setLastTickSecond(seconds)
      playTickSound()
    }
    if (seconds > 30) setLastTickSecond(-1)
  })

  // ── Server-down detection ──
  engine.addSystem((dt: number) => {
    addSceneLoadElapsed(dt)
    if (getSceneLoadElapsed() < SERVER_DOWN_GRACE_SEC) return

    const connected = getServerConnectionStatus() === 'Y'
    if (connected) {
      setServerDownTimer(0)
      setServerDownVisible(false)
      setServerDownDismissedAt(0)
    } else {
      addServerDownTimer(dt)
      if (getServerDownTimer() >= SERVER_DOWN_CONFIRM_SEC) {
        if (getServerDownDismissedAt() === 0) {
          setServerDownVisible(true)
        } else if (Date.now() - getServerDownDismissedAt() >= SERVER_DOWN_RESHOW_SEC * 1000) {
          setServerDownVisible(true)
          setServerDownDismissedAt(0)
        }
      }
    }
  })

  // ── Key 2 — toggle music mute ──
  engine.addSystem(() => {
    if (inputSystem.isTriggered(InputAction.IA_ACTION_4, PointerEventType.PET_DOWN)) {
      toggleMusicMuted()
      try {
        const audio = AudioSource.getMutable(musicEntity)
        audio.volume = isMusicMuted() ? 0 : 0.175
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
      if (closed) { playClickSound(); notifyOverlayClosed() }
    }
  })
}
