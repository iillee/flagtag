# 🏁 Flag Tag

A server-authoritative, 24/7 multiplayer keep-away game for [Decentraland](https://decentraland.org/). Grab the flag, hold it as long as you can, and fend off rivals with boomerangs and banana traps. Rounds are five minutes long and aligned to UTC — a new one starts every five minutes, forever.

**▶ Play now:** [flagtag.dcl.eth](https://play.decentraland.org/?realm=flagtag.dcl.eth)

![Flag Tag](assets/images/flagtag_splash.png)

---

## Table of Contents

- [The Game](#the-game)
- [Quick Start](#quick-start)
- [Project Layout](#project-layout)
- [Architecture](#architecture)
- [Scripts](#scripts)
- [Deployment](#deployment)
- [Documentation](#documentation)

---

## The Game

- 🚩 A single **flag** spawns on the map — follow the gold beacon to find it.
- 🏃 **Pick up** the flag by walking over it, or **steal** it by getting close to the carrier.
- ⏱️ **Score 1 point per second** while holding — highest hold wins the round.
- 🪃 **Throw boomerangs** (E) to stun rivals and knock the flag loose.
- 🍌 **Drop bananas** (F) to trap pursuers.
- 🪙 Earn **coins** to unlock boomerang variants (Dubs, Orbit, Charge) and cosmetics.
- ⚡ **Lightning** targets dominant flag holders as a catch-up mechanic.
- 👻 **Ghosts** roam the castle at night — don't get scared to death.
- 🏆 Daily, monthly, and all-time leaderboards persist across sessions.

Full mechanics and design rationale live in [docs/GAME_DESIGN_DOCUMENT.md](docs/GAME_DESIGN_DOCUMENT.md).

---

## Quick Start

**Prerequisites:** Node.js 24+ and npm 9+.

```bash
npm install
npm run start
```

This launches the Decentraland preview with both the client and a local authoritative server. Open the URL printed in the terminal and jump in.

---

## Project Layout

```
flagtag/
├── src/                     # All game source
│   ├── index.ts             # Entry — branches to server or client
│   ├── server/              # Authoritative game logic (see Architecture)
│   ├── systems/             # Client-side rendering, input, VFX
│   ├── ui/                  # React-ECS screen UI (HUD, menus, dialogs)
│   ├── ui2/                 # Newer UI screens (in-progress migration)
│   ├── shared/              # Code shared between client & server
│   ├── gameState/           # Client-side reactive state
│   ├── themes/              # UI theming + texture atlases
│   └── utils/               # Small helpers
├── assets/                  # Models, textures, sounds, scene composite
│   ├── scene/               # main.composite (in-world layout)
│   ├── models/              # Custom .glb models (boomerang, flag, etc.)
│   ├── asset-packs/         # Decentraland asset-pack pieces
│   ├── images/              # UI images, splash, thumbnails
│   └── sounds/              # SFX and music
├── models/                  # Custom emotes (.glb)
├── test/                    # Jest regression tests (server logic)
├── scripts/                 # Dev utilities (composite shifts, smoke tests)
├── docs/                    # Architecture, gameplay, storage, bug postmortems
└── scene.json               # Decentraland scene metadata
```

---

## Architecture

Flag Tag runs on Decentraland SDK7's **authoritative multiplayer** mode. A single headless server holds truth for every synced value in the scene; clients render, animate, and predict, but never mutate authoritative state directly.

### The client/server split

`src/index.ts` is the same bundle for both roles. On boot it checks `isServer()`:

- **Server** — `import('./server/server').setupServer()` boots the game loop, round manager, persistence, and analytics. No rendering, no input, no `~system/RestrictedActions`.
- **Client** — dynamically imports everything under `src/systems/` and `src/ui/`. Sends **request messages** (`requestPickup`, `requestShell`, `requestUpgrade`, …) and listens for authoritative **broadcasts** in return.

All synced ECS components use `validateBeforeChange()` guards to reject writes from anyone but the server. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map.

### Persistence

Player wallets, upgrades, leaderboards, and flag state are held in-memory on the server and flushed to Decentraland's Server-Side Storage with a write-behind queue. There is a one-way migration to per-player `player:{addr}` docs — **do not roll back past it**. See [docs/STORAGE.md](docs/STORAGE.md).

---

## Scripts

| Command | What it does |
|---|---|
| `npm run start` | Launch preview (client + local server) |
| `npm run build` | Compile the scene to `bin/` without deploying |
| `npm run deploy` | Deploy to `flagtag.dcl.eth` |
| `npm run test` | Run the Jest server-logic regression suite |
| `npm run lint` | TypeScript type-check (no emit) |
| `npm run test:dependencies` | Exercise SDK dependency overrides |
| `npm run test:cli` | Smoke-test preview/deploy CLI entry points |
| `npm run server-logs` | Tail server logs from the deployed scene |
| `npm run upgrade-sdk` | Pull the latest `@dcl/sdk@auth-server` build |

**Before shipping any SDK upgrade,** run `npm run build`, `npm run test:cli`, and `npm audit` and make sure all three stay green. The `overrides` block in `package.json` patches vulnerable transitive deps of the SDK — expect to revisit it whenever the SDK version bumps.

---

## Deployment

The scene targets a Decentraland World, not Genesis City land:

```bash
npm run deploy
```

This builds `bin/index.js` and publishes to `flagtag.dcl.eth`. Only the wallet configured in `.env` (or your local Decentraland credentials) can deploy — the scene owner is set in `scene.json`. Full deployment notes, secrets management, and rollback guidance in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Documentation

| Doc | Purpose |
|---|---|
| [docs/GAME_DESIGN_DOCUMENT.md](docs/GAME_DESIGN_DOCUMENT.md) | Full design bible — mechanics, tuning, economy |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Code layout, client/server split, message flow |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | How to publish, secrets, rollback |
| [docs/STORAGE.md](docs/STORAGE.md) | Server-side storage schema and migrations |
| [docs/KNOWN_BUGS.md](docs/KNOWN_BUGS.md) | Live bug tracker |
| [docs/PITCH.md](docs/PITCH.md) | Product pitch / vision |
| [docs/history/](docs/history/) | Retired bug postmortems and old pitches |

---

## Credits

Built by **ile** on Decentraland SDK7.
Scene owner: `0x1E93E534C5E26B01Ed242410b43AE23dD0fAA52b`
