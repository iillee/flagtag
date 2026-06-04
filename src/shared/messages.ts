import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // Client → Server
  registerName: Schemas.Map({ name: Schemas.String }),
  requestPickup: Schemas.Map({ t: Schemas.Int }),
  requestDrop: Schemas.Map({ t: Schemas.Int }),
  // requestAttack removed — proximity steal replaced melee attack
  reportGroundY: Schemas.Map({ y: Schemas.Float }),
  requestBanana: Schemas.Map({ t: Schemas.Int }),
  reportBananaGroundY: Schemas.Map({ bananaX: Schemas.Float, bananaZ: Schemas.Float, groundY: Schemas.Float }),
  requestShell: Schemas.Map({ dirX: Schemas.Float, dirZ: Schemas.Float, color: Schemas.String, chargeSpeed: Schemas.Float, chargeRange: Schemas.Float, chargeScale: Schemas.Float }),
  reportShellWallDist: Schemas.Map({ shellId: Schemas.Float, maxDist: Schemas.Float }),
  reportShellGroundY: Schemas.Map({ shellX: Schemas.Float, shellZ: Schemas.Float, groundY: Schemas.Float }),

  // Server → Client
  hitVfx: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  missVfx: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  stagger: Schemas.Map({ victimId: Schemas.String }),
  pickupConfirmed: Schemas.Map({ playerId: Schemas.String }),
  pickupSound: Schemas.Map({ t: Schemas.Int }),
  dropSound: Schemas.Map({ t: Schemas.Int }),
  bananaDenied: Schemas.Map({ reason: Schemas.String }),
  bananaDropped: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, ownerId: Schemas.String }),
  bananaTriggered: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String }),
  shellDropped: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, dirX: Schemas.Float, dirZ: Schemas.Float, color: Schemas.String, firedBy: Schemas.String, chargeSpeed: Schemas.Float, chargeRange: Schemas.Float, chargeScale: Schemas.Float, shellId: Schemas.Int }),
  shellTriggered: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String, peak: Schemas.Optional(Schemas.Boolean), firedBy: Schemas.Optional(Schemas.String), shellId: Schemas.Optional(Schemas.Int) }),
  shellReturned: Schemas.Map({ firedBy: Schemas.String, shellId: Schemas.Optional(Schemas.Int) }),


  // Updraft messages
  requestUpdraftLocation: Schemas.Map({ t: Schemas.Int }),
  updraftLocation: Schemas.Map({ index: Schemas.Int, slot: Schemas.Int }),

  // Mushroom messages
  requestMushroomPositions: Schemas.Map({ t: Schemas.Int }),
  pickupMushroom: Schemas.Map({ id: Schemas.Int }),
  mushroomPositions: Schemas.Map({ mushroomsJson: Schemas.String, fullReset: Schemas.Optional(Schemas.Boolean) }),   // JSON array of {id, candidates: [{x,z}]}
  mushroomPickedUp: Schemas.Map({ id: Schemas.Int, playerId: Schemas.String }),
  mushroomShield: Schemas.Map({ durationMs: Schemas.Int, playerId: Schemas.String }),
  shieldConsumed: Schemas.Map({ playerId: Schemas.String }),
  flagImmunity: Schemas.Map({ playerId: Schemas.String, durationMs: Schemas.Int }),
  flagSinking: Schemas.Map({ t: Schemas.Int }),
  playerShieldActive: Schemas.Map({ playerId: Schemas.String, active: Schemas.Int }),

  // Boomerang color sync
  colorChanged: Schemas.Map({ color: Schemas.String }),
  playerColorChanged: Schemas.Map({ playerId: Schemas.String, color: Schemas.String }),
  requestAllColors: Schemas.Map({ t: Schemas.Int }),

  // Green orbit mechanic
  requestOrbit: Schemas.Map({ t: Schemas.Int, startAngle: Schemas.Float }),
  orbitHitWall: Schemas.Map({ t: Schemas.Int }),
  orbitStarted: Schemas.Map({ playerId: Schemas.String, durationMs: Schemas.Int, startAngle: Schemas.Float }),
  orbitHit: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String, attackerId: Schemas.String }),
  orbitEnded: Schemas.Map({ playerId: Schemas.String }),

  // Speed boost trail sync (client → server)
  reportBoost: Schemas.Map({ tier: Schemas.String, duration: Schemas.Float }),
  // Speed boost trail sync (server → all clients)
  playerBoosted: Schemas.Map({ playerId: Schemas.String, tier: Schemas.String, duration: Schemas.Float }),

  // Boomerang charge sync
  chargeStart: Schemas.Map({ t: Schemas.Int }),
  chargeStop: Schemas.Map({ t: Schemas.Int }),
  chargeBurnout: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  playerChargeStart: Schemas.Map({ playerId: Schemas.String, t: Schemas.Int }),
  playerChargeStop: Schemas.Map({ playerId: Schemas.String, t: Schemas.Int }),

  // Lightning (carrier client → all clients)
  lightningWarning: Schemas.Map({ t: Schemas.Int }),
  lightningStrike: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String }),

  // Round end respawn
  requestReloadRespawn: Schemas.Map({ t: Schemas.Int }),
  respawnPlayers: Schemas.Map({ t: Schemas.Int, winnersJson: Schemas.String }),

  // Coin messages
  requestCoinPickup: Schemas.Map({ coinId: Schemas.String }),           // Client → Server: player wants to pick up a coin
  coinPickedUp: Schemas.Map({ coinId: Schemas.String, playerId: Schemas.String, newBalance: Schemas.Int }),  // Server → Client: coin was picked up
  coinRespawned: Schemas.Map({ coinId: Schemas.String }),               // Server → Client: coin is back
  requestWalletBalance: Schemas.Map({ t: Schemas.Int }),                // Client → Server: request current balance on join
  walletBalance: Schemas.Map({ playerId: Schemas.String, coins: Schemas.Int }),  // Server → Client: your current balance
  roundCoinsEarned: Schemas.Map({ playerId: Schemas.String, total: Schemas.Int, participation: Schemas.Int, holdTime: Schemas.Int, placement: Schemas.Int, rank: Schemas.Int, newBalance: Schemas.Int }), // Server → Client: round-end earnings breakdown

  // Store / upgrade messages
  requestUpgrades: Schemas.Map({ t: Schemas.Int }),                    // Client → Server: request my upgrades + lifetime wins on join
  upgradesResponse: Schemas.Map({ upgradesJson: Schemas.String, wins: Schemas.Int }),  // Server → Client: direct response with upgrade data
  buyBoomerang: Schemas.Map({ color: Schemas.String }),                // Client → Server: purchase a boomerang
  buyResult: Schemas.Map({ success: Schemas.Boolean, color: Schemas.String, reason: Schemas.String, newBalance: Schemas.Int, upgradesJson: Schemas.String }),  // Server → Client
  equipBoomerang: Schemas.Map({ color: Schemas.String }),              // Client → Server: equip an owned boomerang

  // Ghost messages
  ghostHit: Schemas.Map({ ghostId: Schemas.Float }),          // Client → Server: boomerang hit a ghost
  ghostKilled: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),  // Server → Client: ghost died (VFX)
  // zombieStagger and ghostDeath removed — replaced by ghostTouching + scare meter
  ghostTouching: Schemas.Map({ victimId: Schemas.String }),     // Server → Client: ghost is touching a player this frame

  // Death penalty
  deathPenalty: Schemas.Map({ cause: Schemas.String }),           // Client → Server: player died, deduct coins
  deathPenaltyApplied: Schemas.Map({ playerId: Schemas.String, penalty: Schemas.Int, newBalance: Schemas.Int }),  // Server → Client

  // Mailbox feedback
  sendFeedback: Schemas.Map({ message: Schemas.String }),                                   // Client → Server
  feedbackResult: Schemas.Map({ success: Schemas.Boolean, message: Schemas.String }),       // Server → Client

  // Blessing (pedestal daily reward)
  checkBlessing: Schemas.Map({ t: Schemas.Int }),                                           // Client → Server (pre-check)
  requestBlessing: Schemas.Map({ t: Schemas.Int }),                                         // Client → Server (claim after ritual)
  blessingResult: Schemas.Map({ success: Schemas.Boolean, reason: Schemas.String, newBalance: Schemas.Int }),  // Server → Client


}

export const room = registerMessages(Messages)
