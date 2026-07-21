# 🏁 Flag Tag

A multiplayer keep-away game for [Decentraland](https://decentraland.org/). Grab the flag, hold it as long as you can, and fight off other players with boomerangs and banana traps. Five-minute rounds run 24/7.

**Play now:** [flagtag.dcl.eth](https://play.decentraland.org/?realm=flagtag.dcl.eth)

## How It Works

- A single **flag** spawns on the map — follow the gold beacon to find it
- **Pick up** the flag by walking near it, or **steal** it by getting close to the carrier
- **Score 1 point per second** while holding the flag — highest score wins the round
- **Throw boomerangs** (E) to stun rivals and force a flag drop
- **Drop bananas** (F) to trap pursuers
- Earn **coins** from gameplay to unlock boomerang variants (Yellow, Green, Blue)
- **Lightning** targets dominant flag holders as a catch-up mechanic
- **Ghosts** roam the castle at night — avoid getting scared to death

## Architecture

Server-authoritative multiplayer built on Decentraland SDK7's `authoritativeMultiplayer` mode.

```
src/
├── index.ts                 # Entry point — branches to server or client
├── server/                  # All game logic (flag, combat, rounds, economy, analytics)
│   ├── server.ts            # Server setup & orchestrator
│   ├── flagLogic.ts         # Flag pickup/drop/steal, hold time
│   ├── combat.ts            # Boomerang & banana hit detection
│   ├── roundManager.ts      # Countdown, round end, lightning, updraft
│   ├── economy.ts           # Coins, wallets, store, upgrades
│   ├── ghostSystem.ts       # Ghost AI (night only)
│   ├── leaderboard.ts       # Daily/monthly/all-time leaderboards
│   ├── analytics.ts         # Visitor tracking, Discord reports
│   └── ...                  # playerTracking, persistence, serverState, etc.
├── systems/                 # Client-side rendering, input, VFX
│   ├── flagSystem.ts        # Flag visuals (bob, spin, particles, carry)
│   ├── projectile/          # Boomerang system (modular: charge, flight, orbit, etc.)
│   ├── trapSystem.ts        # Banana visuals & input
│   ├── combatSystem.ts      # Hit/stagger VFX
│   ├── lightningSystem.ts   # Lightning bolt rendering
│   ├── waterSystem.ts       # Drowning, splash, air meter
│   ├── ghostSystem.ts       # Ghost rendering, scare meter
│   ├── cinematicSystem.ts   # Round-end podium camera
│   └── ...                  # beacon, updraft, coins, speed boost, etc.
├── ui/                      # React-ECS screen UI
│   ├── layouts/             # Desktop & mobile layouts
│   ├── screens/             # HowToPlay, Leaderboard, Chest, Boombox, etc.
│   └── components/          # Reusable UI components
├── shared/                  # Shared between client & server
│   ├── components.ts        # ECS component definitions
│   ├── messages.ts          # Client↔Server message schemas
│   ├── constants.ts         # Tuning values
│   ├── coins.ts             # Coin economy definitions
│   └── upgrades.ts          # Store/upgrade definitions
└── gameState/               # Client-side state management
```

Clients send **requests** (e.g. `requestPickup`, `requestShell`); the server validates and broadcasts results. All synced components use `validateBeforeChange()` to reject unauthorized writes.

Server persistence (player wallets, upgrades, leaderboards, flag state) is memory-authoritative with write-behind flushing to Decentraland's Server-Side Storage — see [docs/STORAGE.md](docs/STORAGE.md) for the architecture, the failure modes it defends against, and the one-way `player:{addr}` doc migration (**do not roll back past it**).

## Development

### Prerequisites
- Node.js 18+

### Setup & Run
```bash
npm install
npm run start        # Preview (client + local server)
npm run test         # Server validation/accounting regression tests
npm run lint         # TypeScript validation
npm run test:dependencies # Exercise overridden SDK dependency APIs
npm run test:cli     # Smoke-test preview/deploy CLI entry points
```

The SDK currently declares older major versions for several vulnerable development-tool
dependencies. Major-version security overrides are scoped to the SDK packages that own
them; the compatible-major `protobufjs` patch applies across its protocol consumers. Keep
`npm run build`, `npm run test:cli`, and `npm audit` green when upgrading the SDK.

### Deploy
```bash
npm run deploy       # Deploy to flagtag.dcl.eth
```

### Other Commands
```bash
npm run build        # Build without deploying
npm run test         # Run the Jest regression suite
npm run lint         # Run TypeScript validation
npm run test:dependencies # Exercise overridden SDK dependency APIs
npm run test:cli     # Smoke-test preview/deploy CLI entry points
npm run server-logs  # View server logs from deployed scene
```

## Scene Details

| | |
|---|---|
| **World** | `flagtag.dcl.eth` |
| **Size** | 32×32 parcels (512m × 512m) |
| **SDK** | `@dcl/sdk` (auth-server branch) |
| **Round Length** | 5 minutes (UTC-aligned) |

See [GAME_DESIGN_DOCUMENT.md](GAME_DESIGN_DOCUMENT.md) for full system documentation.
