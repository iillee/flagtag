import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // ── Client → Server ──
  registerName: Schemas.Map({ name: Schemas.String }),

  // Sword pickup/drop (same pattern as old flag)
  requestSwordPickup: Schemas.Map({ t: Schemas.Int }),
  requestSwordDrop: Schemas.Map({ t: Schemas.Int }),
  reportGroundY: Schemas.Map({ y: Schemas.Float }),

  // Sword attack — sword holder swings at nearby slimes
  requestSwordAttack: Schemas.Map({ t: Schemas.Int }),

  // Traps (humans drop traps to slow slimes)
  requestBanana: Schemas.Map({ t: Schemas.Int }),
  reportBananaGroundY: Schemas.Map({ bananaX: Schemas.Float, bananaZ: Schemas.Float, groundY: Schemas.Float }),

  // Updraft
  requestUpdraftLocation: Schemas.Map({ t: Schemas.Int }),

  // Speed boost trail sync (client → server)
  reportBoost: Schemas.Map({ tier: Schemas.String, duration: Schemas.Float }),

  // Coin pickup
  requestCoinPickup: Schemas.Map({ coinId: Schemas.String }),
  requestWalletBalance: Schemas.Map({ t: Schemas.Int }),

  // Store / upgrades
  requestUpgrades: Schemas.Map({ t: Schemas.Int }),
  buyBoomerang: Schemas.Map({ color: Schemas.String }),
  equipBoomerang: Schemas.Map({ color: Schemas.String }),

  // Death penalty
  deathPenalty: Schemas.Map({ cause: Schemas.String }),

  // Reload respawn
  requestReloadRespawn: Schemas.Map({ t: Schemas.Int }),

  // Admin
  testDiscord: Schemas.Map({ t: Schemas.Int }),

  // ── Server → Client ──

  // Infection events
  playerInfected: Schemas.Map({ victimId: Schemas.String, attackerId: Schemas.String }),
  roundStartInfection: Schemas.Map({ patientZeroId: Schemas.String }),
  lastHumanWin: Schemas.Map({ winnerId: Schemas.String, survivalSeconds: Schemas.Float }),
  allHumansInfected: Schemas.Map({ t: Schemas.Int }),

  // Sword events
  swordPickupConfirmed: Schemas.Map({ playerId: Schemas.String }),
  swordPickupSound: Schemas.Map({ t: Schemas.Int }),
  swordDropSound: Schemas.Map({ t: Schemas.Int }),
  swordAttackVfx: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, attackerId: Schemas.String }),

  // Slime killed by sword → enters respawn cooldown
  slimeKilled: Schemas.Map({ slimeId: Schemas.String, killedBy: Schemas.String, x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  slimeRespawned: Schemas.Map({ slimeId: Schemas.String }),

  // Stagger (from traps or sword hits)
  stagger: Schemas.Map({ victimId: Schemas.String }),

  // Traps
  bananaDropped: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, ownerId: Schemas.String }),
  bananaTriggered: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String }),

  // Updraft
  updraftLocation: Schemas.Map({ index: Schemas.Int }),

  // Speed boost trail sync (server → all clients)
  playerBoosted: Schemas.Map({ playerId: Schemas.String, tier: Schemas.String, duration: Schemas.Float }),

  // Round end respawn
  respawnPlayers: Schemas.Map({ t: Schemas.Int, winnersJson: Schemas.String }),

  // Coins
  coinPickedUp: Schemas.Map({ coinId: Schemas.String, playerId: Schemas.String, newBalance: Schemas.Int }),
  coinRespawned: Schemas.Map({ coinId: Schemas.String }),
  walletBalance: Schemas.Map({ playerId: Schemas.String, coins: Schemas.Int }),
  roundCoinsEarned: Schemas.Map({ playerId: Schemas.String, total: Schemas.Int, participation: Schemas.Int, holdTime: Schemas.Int, placement: Schemas.Int, rank: Schemas.Int, newBalance: Schemas.Int }),

  // Store / upgrades
  upgradesResponse: Schemas.Map({ upgradesJson: Schemas.String, wins: Schemas.Int }),
  buyResult: Schemas.Map({ success: Schemas.Boolean, color: Schemas.String, reason: Schemas.String, newBalance: Schemas.Int, upgradesJson: Schemas.String }),

  // Death penalty
  deathPenaltyApplied: Schemas.Map({ playerId: Schemas.String, penalty: Schemas.Int, newBalance: Schemas.Int }),
}

export const room = registerMessages(Messages)
