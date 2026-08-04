# Flag Tag — Game Design Document

> **Version:** 2.1 · **Last Updated:** June 20, 2026  
> **Platform:** Decentraland SDK7 · **Deployment:** World (`flagtag.dcl.eth`)  
> **Scene Size:** 32×32 parcels (512m × 512m, 1024 parcels)

---

## 1. Game Overview

**Flag Tag** is a multiplayer "keep away" game set in a medieval castle environment surrounded by a moat. Players compete to hold a single flag for the longest cumulative time during 5-minute rounds that run continuously 24/7, aligned to UTC clock boundaries.

**Core Loop:** Find the flag → Pick it up → Run and survive → Score points by holding it → Win the round → Earn coins.

---

## 2. Architecture

### 2.1 Client/Server Split (Authoritative Multiplayer)

The scene uses Decentraland's **authoritative server** architecture (`authoritativeMultiplayer: true` in scene.json). A single entry point (`src/index.ts`) branches via `isServer()`:

- **Server** (`src/server/`): All game logic — flag state, combat hit detection, round timer, scoring, leaderboards, persistence, visitor tracking, Discord reporting, economy. Uses `validateBeforeChange()` on all synced components so clients cannot cheat.
- **Client** (`src/index.ts` + `src/systems/*` + `src/ui/*`): Rendering, input, VFX, sound, UI. Sends requests to server (`requestPickup`, `requestShell`, `requestBanana`, etc.) and reacts to server broadcasts.

### 2.2 State Synchronization

- **CRDT Components** (synced via `syncEntity`): `Flag`, `PlayerFlagHoldTime`, `CountdownTimer`, `LeaderboardState`, `AllTimeLeaderboardState`, `Ghost`, and `CoinState`. High-churn combat visuals use messages rather than synced trap/projectile entities to avoid CRDT saturation.
- **Message Bus** (`registerMessages`): Used for ephemeral events — sound triggers, VFX, lightning, mushroom spawns, boomerang color changes, charge sync, orbit mechanics, ghost touching, respawn commands, coin pickups, speed boosts, death penalties, blessings, feedback
- **Persistence** (`Storage` API): Flag state, leaderboards (daily + monthly + all-time), player names, visitor data (daily + monthly), Discord report tracking, coin wallets, player upgrades, blessing timestamps survive server restarts

### 2.3 Server Modules

The server code is split into focused domain modules:

| Module | Purpose |
|--------|---------|
| `server/server.ts` | Entry point — entity creation, state loading, handler/system registration |
| `server/serverState.ts` | Shared mutable state, entity references, constants |
| `server/persistence.ts` | Storage get/set wrappers |
| `server/leaderboard.ts` | Leaderboard types, helpers, daily/monthly resets |
| `server/analytics.ts` | Visitor tracking and player-join Discord notifications |
| `server/economy.ts` | Coin wallets, round-end earnings, store/upgrades |
| `server/flagLogic.ts` | Flag pickup/drop/steal, gravity, hold-time accumulation |
| `server/combat.ts` | Traps, projectiles, orbits |
| `server/ghostSystem.ts` | Ghost AI, spawning, collisions |
| `server/mushroomSystem.ts` | Mushroom spawning and pickup |
| `server/playerTracking.ts` | Join/leave detection, name resolution |
| `server/roundManager.ts` | Countdown, round end, lightning, updraft rotation |
| `server/posthog.ts` | PostHog analytics integration |

### 2.4 Client File Structure

| File/Directory | Lines | Purpose |
|----------------|-------|---------|
| `src/index.ts` | ~254 | Entry point; client setup, system registration via systemManager |
| `src/ui.tsx` | ~543 | UI root, overlays, death screens, server-down detection |
| `src/ui/layouts/DesktopLayout.tsx` | ~201 | Desktop UI layout |
| `src/ui/layouts/MobileLayout.tsx` | ~228 | Mobile UI layout |
| `src/ui/screens/HowToPlay.tsx` | ~151 | 3-column how-to-play overlay |
| `src/ui/screens/LeaderboardOverlay.tsx` | ~104 | Status popup (inventory, equipment, daily) |
| `src/ui/screens/ChestPopup.tsx` | ~330 | Tabbed universal store (Throw/Traps/Music/Wearables) |
| `src/ui/screens/boomboxState.ts` | ~70 | Music state, toggleMusic(), tape queries |
| `src/ui/screens/RoundEndSplash.tsx` | ~101 | Round-end top 3 splash |
| `src/ui/uiConstants.ts` | ~207 | Colors, scale helpers, formatters, caching |
| `src/ui/components/` | Various | Reusable UI components (CloseButton, DeathOverlay, IconButton, KeyBinding, ProgressBar, Scrollbar, SubTabBar) |
| `src/systems/flagSystem.ts` | ~694 | Client-side flag rendering (bob, spin, particles, carry visual) |
| `src/systems/projectile/` | ~1571 | Client-side boomerang (modular: charge, flight, hand visual, orbit, pool, sound, state) |
| `src/systems/trapSystem.ts` | ~675 | Client-side banana input, visuals, sound |
| `src/systems/combatSystem.ts` | ~389 | Hit/stagger VFX, movement freeze on stun |
| `src/systems/lightningSystem.ts` | ~647 | Client-side lightning bolt rendering + stun |
| `src/systems/waterSystem.ts` | ~284 | Drowning/respawn, movement slowdown in water |
| `src/systems/ghostSystem.ts` | ~387 | Client-side ghost rendering, scare meter |
| `src/systems/beaconSystem.ts` | ~174 | Gold vertical beacon above the flag |
| `src/systems/spectatorSystem.ts` | ~256 | Bird's-eye spectator camera (key 4) |
| `src/systems/updraftSystem.ts` | ~429 | Smoke stack updraft physics |
| `src/systems/mushroomSystem.ts` | ~392 | Mushroom collectible (grants shield + speed boost) |
| `src/systems/shieldSystem.ts` | ~181 | Forcefield visual around shielded players |
| `src/systems/coinPickupSystem.ts` | ~492 | Coin entity detection, pickup requests, visual state |
| `src/systems/coinBobSpinSystem.ts` | ~108 | Coin bob/spin animation |
| `src/systems/speedBoostSystem.ts` | ~92 | Mushroom speed boost via AvatarLocomotionSettings |
| `src/systems/boostTrailSystem.ts` | ~228 | Gold orb trail VFX during speed boosts |
| `src/systems/deathPenaltySystem.ts` | ~44 | Coin penalty on death |
| `src/systems/pedestalSystem.ts` | ~308 | Ritual pedestal — daily blessing reward |
| `src/systems/boomboxSystem.ts` | ~150 | Clickable boombox mute/unmute toggle with music ring VFX |
| `src/systems/worldLeaderboard.ts` | ~277 | In-world 3D leaderboard text display |
| `src/systems/proximityLights.ts` | ~169 | ~60 point lights that activate near the player |
| `src/systems/remoteBoomerangSystem.ts` | ~565 | Other players' hand boomerangs + charge VFX |
| `src/systems/portalSystem.ts` | ~549 | Reusable portal component (Genesis Plaza link) |
| `src/systems/boundaryWalls.ts` | ~97 | Cylindrical boundary wall (colliders + proximity-fade) |
| `src/systems/teleportOrbs.ts` | ~137 | Glowing teleport orb pairs with pulse animation |
| `src/systems/cinematicSystem.ts` | ~279 | Round-end fade state machine, podium camera, emotes |
| `src/systems/ladderSystem.ts` | ~106 | Click-to-climb ladder interaction |
| `src/systems/waterBobSystem.ts` | ~77 | Bobbing animation for water planes/lilypads |
| `src/systems/waterSplashSystem.ts` | ~175 | Splash VFX when walking in water |
| `src/systems/mailboxSystem.ts` | ~51 | Clickable mailbox for feedback |
| `src/systems/chestSystem.ts` | ~62 | Clickable chest (universal store) |
| `src/systems/gravestoneSystem.ts` | ~41 | Clickable gravestone |
| `src/systems/terminalSystem.ts` | ~61 | Clickable terminal (metrics panel) |
| `src/systems/systemManager.ts` | ~95 | Centralized system registration (per-frame + throttled) |
| `src/systems/musicSetup.ts` | ~20 | Background music entity setup |
| `src/systems/avatarModifierSetup.ts` | ~19 | Avatar modifier area setup |
| `src/systems/handBoomerangSetup.ts` | ~132 | Hand boomerang model setup |
| `src/systems/nameRetrySystem.ts` | ~39 | Player name resolution retry |
| `src/systems/clientUtils.ts` | ~30 | Shared client utilities |
| `src/gameState/flagHoldTime.ts` | ~291 | Client-side player tracking, score interpolation |
| `src/gameState/boomerangColor.ts` | ~36 | Boomerang color state + callbacks |
| `src/gameState/playerUpgradeState.ts` | ~183 | Client-side upgrade/store state |
| `src/gameState/roundsWon.ts` | ~64 | Cached leaderboard parsing |

| `src/gameState/roundEarnings.ts` | ~27 | Round-end coin earnings display state |
| `src/gameState/overlayState.ts` | ~22 | Overlay visibility state |
| `src/gameState/cinematicState.ts` | ~5 | Cinematic active flag |
| `src/gameState/lightningState.ts` | ~10 | Lightning warning state |
| `src/shared/components.ts` | ~256 | ECS component definitions, sync IDs |
| `src/shared/constants.ts` | ~68 | Game tuning constants |
| `src/shared/dateUtils.ts` | ~35 | UTC date/time helpers |
| `src/shared/messages.ts` | ~116 | Client↔Server message schemas |
| `src/shared/coins.ts` | ~72 | Coin component definitions, economy constants |
| `src/shared/upgrades.ts` | ~155 | Upgrade/store definitions (boomerangs, music, traps, wearables) |
| `src/shared/dayNight.ts` | ~38 | Day/night cycle detection |
| `src/shared/syncIdPool.ts` | ~31 | Reusable sync ID pool factory |
| `src/shared/clientState.ts` | ~30 | Shared client state (avoids circular imports) |
| `src/preloadSounds.ts` | ~51 | Silent preload of all audio clips |
| `src/version.ts` | ~1 | Build version string |

---

## 3. Core Systems

### 3.1 Flag System

**States:** `AtBase` → `Carried` → `Dropped` → (cycle)

- **Pickup:** Player walks within 3m of flag → server transfers ownership
- **Proximity Steal:** Walk within 2m of the carrier → automatically steal the flag
- **Steal Immunity:** 3 seconds of immunity after picking up/stealing (prevents instant re-steal)
- **Drop:** Press `3` to voluntarily drop; also forced by boomerang hit, banana stun, lightning strike, ghost death, or drowning
- **Gravity:** Dropped flag falls with acceleration (15 m/s²) until it reaches the ground (Y estimated from carrier position history + client raycasts)
- **Water Respawn:** If the flag reaches the lifted moat surface around Y=49.58, it sinks and respawns at a random spawn point
- **Spawn Points:** 3 predefined locations on the map; randomly selected at round start and water respawn
- **Visual:** Client-side bob animation (0.25m amplitude), slow spin, gold particle trail, gold vertical beacon (110m tall)
- **Carry Visual:** Flag floats above carrier's head using a 3-layer entity hierarchy: `Anchor (AvatarAttach AAPT_NAME_TAG)` → `Offset (static, never mutated)` → `Visual (bob + spin)`. The static intermediate entity prevents a Bevy race condition where per-frame Transform writes on a direct AvatarAttach child cause the entity to detach and freeze in world space.

### 3.2 Round Timer & Scoring

- **Round Length:** 5 minutes, aligned to UTC 5-minute boundaries (e.g., :00, :05, :10...)
- **Scoring:** Server accumulates hold time (synced every 2s via CRDT, with a 5s WebSocket heartbeat fallback); client interpolates between updates for smooth scoreboard counting
- **Winner:** Player with the most cumulative hold time at round end
- **Round End Sequence (Server):**
  1. Flush hold time accumulator (ensures final scores are accurate)
  2. Read final authoritative scores
  3. Reset the flag and ALL `PlayerFlagHoldTime` entities synchronously before any `await`
  4. Clear accumulators defensively
  5. Clean up traps, projectiles, orbits, cooldowns, lightning, mushrooms
  6. Calculate and distribute coin earnings (participation + hold time + placement bonuses)
  7. Broadcast `respawnPlayers` with top 3 player data
  8. (async) Update the daily and all-time leaderboards, persist to Storage, send Discord/PostHog reports
- **Round End Sequence (Client):**
  1. Receive `respawnPlayers` → freeze movement, fade to black (1.5s)
  2. Top 3 players teleported to podium cubes (1st=red, 2nd=gold, 3rd=blue)
  3. Virtual camera activates (green cube position looking at red cube)
  4. Winner plays "handsair" emote, 2nd/3rd play "clap" (grounded-emote system waits for stable Y before triggering)
  5. Splash UI shows top 3 with scores + coin earnings breakdown + "Next round starting..."
  6. After 15s, fade to black, show credits screen with countdown, release camera, return players to spawn
- **Credits Screen:** After the cinematic (or immediately for no-scorer rounds), a black screen shows "Special Thanks to:" with rotating credit lines and "Next round in X..." countdown. Lasts 15 seconds before fading to gameplay.

### 3.3 Economy System

- **Coins:** In-game currency earned by playing. Persisted per-player via server Storage.
- **Earning Coins:**
  - Collecting coin pickups scattered around the map (proximity trigger, server-authoritative)
  - Round-end participation bonus (1 coin for everyone who played)
  - Round-end hold time bonus (0.1 coins per second held, floored)
  - Round-end placement bonus (1st: 5, 2nd: 3, 3rd: 1 coins)
- **Coin Pickups:** Physical coins in the world. When picked up, disappear for all players and respawn after 30 seconds (one empty spot refills per tick). Synced via `CoinState` CRDT component. Bob/spin animation on client.
- **Spending Coins:** Used to purchase boomerang variants from the store (via chest interaction)
- **Death Penalty:** Dying (drown, lightning, ghost) deducts 10 coins
- **Max Balance:** 10,000 coins
- **Wallet Sync:** Targeted server messages send balances on join and after transactions; durable state lives in the consolidated per-player Storage document.

### 3.4 Upgrade / Store System

The **Chest** is the universal shop with 4 tabbed categories. Each tab shows 4 item slots (filled items + empty "?" placeholders for future content).

- **Projectiles Tab (Throw):** 4 boomerang variants with escalating costs and flag-win requirements:
  - **Red (Base):** Free, 0 wins required
  - **Yellow (Dubs):** 50 coins, 1 win required
  - **Green (Orbit):** 150 coins, 5 wins required
  - **Blue (Charge):** 300 coins, 10 wins required
- **Traps Tab:** Banana (free, default) + 3 empty slots for future traps
- **Music Tab:** Purchasable music tapes that unlock in the boombox. Sprite Sprint (free, default) + 3 empty slots for future tracks. Equipping a tape in the chest changes the boombox music.
- **Wearables Tab:** 4 empty slots for future wearable rewards (cape planned)
- **Purchase Flow:** Click chest → tabbed popup UI → select item → `buyBoomerang`/`buyTape` message → server validates balance + wins → `buyResult`/`buyTapeResult` response
- **Equipment:** Players can equip owned items per category. Boomerang choice synced to all players. Tape choice is local (controls boombox music).
- **Persistence:** `PlayerUpgrades` component (JSON: `{boomerangs: ["r","y"], equipped: "r", tapes: ["w"], equippedTape: "w", traps: ["banana"], equippedTrap: "banana"}`), `PlayerLifetimeWins`, `PlayerLifetimeHoldTime` — all server-persisted

### 3.5 Combat: Boomerang (E Key)

- **Input:** Press E (or click on mobile) to throw; hold E for charge (Blue variant)
- **Server-Authoritative:** Client sends `requestShell` with camera direction + charge parameters; server spawns synced `Projectile` entity
- **Flight:** Travels in a straight line on the XZ plane at variant-specific speed, up to variant-specific range (or until wall hit)
- **Wall Detection:** Client performs raycast and reports `reportShellWallDist` to cap range
- **Return:** After reaching max range (or hitting a player), boomerang homes back to the thrower at the same speed. Consumed when it reaches them.
- **Hit Detection (Server):** 2m radius hit check (× chargeScale for green) against all players except the thrower
- **On Hit:** Forces flag drop if victim is carrying; victim gets stun VFX + movement freeze
- **Trap Interaction:** Boomerang destroys bananas on contact, then returns
- **Ghost Interaction:** Boomerang damages ghosts; triggers return after hit
- **Cooldown:** 0.45s base (post-catch), plus variant-specific extra cooldown
- **Max Active:** 1 per player (2 for yellow)
- **Customization:** 4 color variants (must be purchased from store, except Red which is free):
  - **Red ("Base"):** Instant fire, 40m range, no extra cooldown. The default all-rounder.
  - **Yellow ("Dubs"):** Instant fire, 20m range, fires a 2nd boomerang 250ms later from left hand. +1s extra cooldown. Dual-wield style.
  - **Blue ("Charge"):** Hold E to charge (1.5s max). Speed scales 30→60 m/s, range scales 20→50m. Movement slowed while charging. Overcharge at full charge = burnout self-stun + flag drop. Extra cooldown +1s (<1s charge) or +2s (≥1s charge). Visual: gold charging ring of beads orbits the hand, grows and spins faster with charge.
  - **Green ("Orbit"):** Press E to launch boomerang in a 3m radius orbit around the player for 3.5s. Hits anyone within orbit ring. Wall collision ends orbit early. +5s extra cooldown. No projectile flight — purely close-range area denial.
- **Charge VFX (multiplayer):** Charge start/stop synced via messages. Remote players see the charging ring within 16m proximity.
- **Hand Model:** Right hand always shows equipped boomerang color. Left hand shows only for Yellow variant. Both visible to other players via `remoteBoomerangSystem`.
- **Client Module Structure:** Projectile system is split into submodules: `charge.ts`, `flight.ts`, `handVisual.ts`, `orbit.ts`, `pool.ts`, `sound.ts`, `state.ts`, `utils.ts`

### 3.6 Combat: Banana Trap (F Key)

- **Input:** Press F to drop at player's feet
- **Server-Authoritative:** Client sends `requestBanana`; server creates synced `Trap` entity
- **Placement:** Drops at player position with gravity fall to ground
- **Trigger:** Any player (including dropper after 2s) walks within 2m → stun + flag drop
- **Ghost Interaction:** Ghosts can trigger bananas — kills the ghost, consumes the banana
- **Lifetime:** 15 seconds, then despawns
- **Cooldown:** 5 seconds between drops
- **Max Active:** 3 per player simultaneously
- **Self-Hit:** Immune for 2s after dropping, then can trigger own banana
- **Visual:** `models/banana.glb` — client attaches the model locally

### 3.7 Lightning System

- **Trigger:** Server-side probability roll every 5 seconds while flag is carried
- **Probability Curve:** Scales with carrier's score:
  - <100s: 0%
  - 100-200s: 5-10% per roll
  - 200-250s: 10-40%
  - 250-280s: 40-70%
  - 280+: 70-95%
- **Warning:** 3-second delay between roll success and strike
- **Strike:** Server determines position (carrier or flag), sends `lightningStrike` with victim ID
- **Effect:** Forces flag drop, visual bolt from sky, flash, thunder sound, victim respawn with fade overlay, coin penalty
- **Purpose:** Rubber-banding mechanic — prevents any single player from dominating an entire round

### 3.8 Water / Drowning

- **Water Level:** Y ≈ 49.58 after the scene's +48m vertical lift (moat surrounding the castle)
- **Movement Penalty:** Running and jumping disabled in water (walk only)
- **Air Timer:** 5 seconds of air; recharges in 5 seconds on land
- **Drowning:** When air depletes, player sees "You Drowned!" death overlay, coin penalty applied, then teleported to spawn point
- **Flag Interaction:** If carrier drowns, flag is dropped; if flag falls in water, it respawns at a random spawn point
- **Visual:** Splash particles at player's feet, water bob animation on water planes/lilypads, air meter bar at bottom of screen

### 3.9 Ghost System (Night Only)

- **Schedule:** Ghosts spawn only during nighttime (detected via `getWorldTime()`, checking for hours between sunset 6 PM and sunrise 6 AM in DCL sky time)
- **Spawning:** Up to 5 ghosts, spawn interval 20 seconds
- **Behavior (Server):**
  - Idles in slow orbit around spawn point when no player within 20m
  - Chases nearest player within 20m detection radius
  - Speed: 3 m/s base, 5 m/s when within 8m
  - Y-axis follows target player height
- **Scare Meter (Client):** When ghost touches player (within 1.5m), `ghostTouching` message sent each frame. Client fills a scare meter (grey bar, turns red above 75%). Meter drains when not being touched. At 100% → death.
- **Ghost Death:** "You were scared to death!" overlay → coin penalty → respawn at spawn. Forces flag drop.
- **Combat:** Ghost has 1 HP; killed by boomerang hit or banana trap. Death VFX + 30s respawn cooldown.
- **Visual (Client):** `AvatarShape` NPC with ghost-like wearables, rising/sinking animation. Synced via CRDT `Ghost` component + `Transform`.
- **Dawn Despawn:** All ghosts removed when night ends.

### 3.10 Mushroom / Shield / Speed Boost

- **Server Spawning:** 1 mushroom spawned at a time within a cylindrical region (center 250.75, 255.5; radius 128m)
- **Candidate System:** Server generates 10 random candidate positions per mushroom, sends all to client. Client raycasts each to find one not in water.
- **Pickup:** Walk within 0.5m of mushroom
- **Effects:**
  - **Shield:** Golden forcefield (8 rotating billboard rings). Blocks one hit (boomerang or banana), then consumed.
  - **Speed Boost:** +50% movement speed, jump height, and double jump for 20 seconds via `AvatarLocomotionSettings`. Gold orb trail VFX at player's feet (visible to other players within 32m via messages).
- **Respawn:** When picked up, server immediately spawns a replacement

### 3.11 Updraft Smoke Stacks

- **49 Chimney Locations** on castle rooftops
- **Server Rotation:** Every 60 seconds, one chimney is randomly activated
- **Visual:** Column of rising white orbs (billboard spheres)
- **Mechanic:** Player inside the column and holding jump gets physics lift upward
- **Sound:** Woosh audio when entering updraft

### 3.12 Teleport Orbs

- **2 Orb Pairs:** Orange pair and Blue pair
- **Orange:** Ground level ↔ High rooftop (290.5, 2.6, 254.7 ↔ 276.56, 52.25, 301.5)
- **Blue:** Two ground positions (224, 2.0, 288 ↔ 226.3, 2.8, 211.3)
- **Trigger:** Walk within 1.5m → teleport to paired orb + 3m offset
- **Cooldown:** 1 second
- **Visual:** Glowing spheres with pulsing scale animation, point lights, emissive PBR material

---

## 4. Map & Environment

### 4.1 Layout
- **Castle:** Large medieval structure centered around (250, y, 255) — placed as composite GLB models via Creator Hub
- **Moat:** Water plane covering the entire scene around Y=49.58 after the vertical scene lift, with lilypads and flowers bobbing
- **Boundary:** Cylindrical invisible wall (radius 128m from center, 48 segments, 200m tall) with faceted plane segments that fade in when the player approaches (gradient texture, red emissive glow). Stacked 10m collider segments for reliable physics.
- **Spawn Point:** Elevated platform at approximately (263, 47.5, 298) — players arrive on the castle ramparts

### 4.2 Lighting
- **Proximity Lights:** ~60+ point lights at predefined positions; each activates within 45m of the player (created/destroyed dynamically to save performance)
- **Day/Night Cycle:** Uses Decentraland's default skybox. `getWorldTime()` polled every 2 seconds. Night defined as sunset (64800s) to sunrise (7200s) in DCL day cycle.

### 4.3 Interactive Objects
- **Ladders:** Climbable ladders (click to teleport to top/bottom)
- **Portal:** Genesis Plaza portal at (225.95, 2.15, 224.9) — parallax door effect with interactive open/close states
- **Mailbox:** Clickable — opens feedback popup. Messages sent to Discord webhook via server. Rate-limited to 1 per 60s per player.
- **Chest:** Clickable — opens universal store UI with 4 tabs (Throw, Traps, Music, Wearables). Each tab has 4 item slots.
- **Boombox:** Clickable — toggles music mute/unmute. Animated gold rings when playing. Tooltip shows "♪ Music". Tapes are purchased and equipped in the Chest.
- **Gravestone:** Clickable — displays information popup
- **Terminal:** Clickable — opens metrics/analytics panel
- **Ritual Pedestal:** "Blessing of the Gods" — click to kneel, beam of light activates, rolling credits play. If the authoritative server position stays near the pedestal for the full 32-second duration, the player earns 6 coins (once per day).
- **Podium Cubes:** 4 invisible marker entities (red, gold, blue, green) used for round-end cinematic positioning. Hidden at runtime via `VisibilityComponent`.
- **In-World Leaderboard:** 3D text display with clickable "Daily Wins" / "Top 10" tabs at the Artwork Info board location.

### 4.4 Avatar Modifiers
- **Passport Disabled:** `AvatarModifierArea` covering the full scene disables clicking on avatars to view profiles (prevents accidental passport opens during gameplay)

---

## 5. UI System

### 5.1 Component Architecture
UI is built with React-ECS (JSX) and split into reusable components:
- **Layouts:** `DesktopLayout.tsx`, `MobileLayout.tsx` — platform-specific arrangement
- **Screens:** `HowToPlay`, `LeaderboardOverlay` (StatusPopup), `ChestPopup` (tabbed store), `RoundEndSplash`
- **Components:** `CloseButton`, `DeathOverlay`, `IconButton`, `KeyBinding`, `ProgressBar`, `Scrollbar`, `SubTabBar`

### 5.2 Desktop Layout (scaled by viewport)
- **Top Center:** Round countdown timer (M:SS format, fixed-width dark background). Gold color in last 10 seconds with tick sound. Hidden during round-end cinematic.
- **Right Side:** Scoreboard panel — lists all players sorted by hold time, gold highlight for leader, flag icon for current carrier. Sun/moon icon right-aligned in header. Coin balance displayed. Two icon buttons stacked vertically:
  - Flag icon → Leaderboards overlay (folder-tab UI)
  - `?` → How to Play overlay (3-column cards: Flag, Combat, Win + Controls)
- **Bottom Center:** Ability icons — Boomerang (E) and Banana (F) with cooldown overlays
- **Keyboard Shortcuts:**
  - `1` — Cycle UI scale (Small / Medium / Large) with toast notification
  - `2` — Toggle music (Mute / Insert Tape)
  - `3` — Drop flag
  - `4` — Close any open overlay

### 5.3 How to Play Overlay
Three-column card layout:
- **Flag:** Beacon image, pickup/steal instructions
- **Combat:** Boomerang (E) throw and banana (F) drop instructions with images
- **Win + Controls:** Scoring explanation + key bindings (E: Throw Boomerang, F: Drop Banana, 3: Drop Flag, 2: Mute/Insert Tape, 1: Toggle UI Size)

### 5.4 Status Popup
Simple popup showing player inventory (coins, flags), equipped items (projectile, trap), and daily status (blessing). Opened via flag icon button on desktop or mobile.

### 5.5 Mobile Layout
- Repositioned for touch-safe areas (avoids joystick, chat, action buttons)
- Top bar: Menu icons (left) — Timer + Score (center) — Ability icons (right)
- Overlays open as centered popups with larger touch targets and font sizes
- Score button opens full scoreboard overlay

### 5.6 Round-End Splash & Credits
- Shows top 3 players with name, rank, score, and coin earnings during cinematic podium view
- Credits screen follows: "Special Thanks to:" with rotating credit lines and "Next round in X..." countdown
- No-scorer rounds skip podium cinematic — go straight to credits

### 5.7 Death Overlays
- **Drowning:** "You Drowned!" with coin penalty display
- **Lightning:** "You were struck by lightning!" with coin penalty display
- **Ghost:** "You were scared to death!" with coin penalty display
- All share the same visual style (CORAL_RED title, LIGHT_GREY countdown, black fade background)

### 5.8 UI Scaling & Constants
- `S()` function scales all UI values by viewport width ratio (base 1920px, clamped 0.6–1.6)
- Auto-detects from `UiCanvasInformation` canvas width each frame
- Manual adjustment via key `1` cycles Small (0.85×) / Medium (1.0×) / Large (1.2×)

### 5.9 Server-Down Detection
- After 20s grace period on scene load, monitors for Flag CRDT presence
- If flag entity missing for 10 consecutive seconds → "Server Disconnected" overlay
- Dismissable, re-shows every 60s if server remains down

### 5.10 Other UI Features
- **Chest Popup:** Tabbed universal store (Throw / Traps / Music / Wearables) with purchase/equip actions, coin balance, win requirements. 4 slots per tab, empty slots show "?" placeholder.
- **Spectator Mode:** Bottom overlay with controls hint + exit button
- **UI Scale Toast:** Brief notification when UI scale changes
- **Scare Bar:** Grey/red progress bar when ghost is nearby
- **Drown Bar:** Blue/red air meter when in water
- **Coin Balance:** Displayed on scoreboard panel
- **Round Earnings:** Breakdown shown during round-end splash (participation + hold time + placement)

---

## 6. Persistence & Leaderboards

### 6.1 Storage Keys
| Key | Content |
|-----|---------|
| `flagState` | Flag position, state, carrier ID, drop anchors |
| `leaderboard` | Daily leaderboard JSON (userId, name, roundsWon) |
| `allTimeLeaderboard` | All-time leaderboard JSON |
| `monthlyLeaderboard` | Monthly leaderboard JSON |
| `monthlyLeaderboardMonth` | Current month string for reset detection |
| `playerNames` | Map of userId → display name |
| `visitorData` | Today's visitor records (name, time spent) |
| `monthlyVisitorData` | This month's visitor records |
| `lastVisitorResetDay` | Date string for daily reset detection |
| `lastLeaderboardResetDay` | Date string for daily leaderboard reset |
| `monthlyVisitorResetMonth` | Month string for monthly visitor reset |
| `wallet:<userId>` | Per-player coin balance |
| `upgrades:<userId>` | Per-player purchased boomerangs + equipped |
| `blessing:<userId>` | Last blessing claim timestamp |
| `lifetime_wins:<userId>` | Per-player lifetime round wins |
| `lifetime_hold_time:<userId>` | Per-player lifetime flag hold time |

### 6.2 Daily Resets (Midnight UTC)
- **Leaderboard:** Resets daily. Before clearing, it validates or recovers the persisted board; malformed/unavailable data fails closed without an overwrite, and CRDT/in-memory reset state is published only after both durable reset writes succeed.
- **Visitor Data:** Resets daily at midnight UTC.
- **Monthly Leaderboard:** Resets on first day of each new month.
- **Monthly Visitor Data:** Resets on first day of each new month.
- **All-Time Leaderboard:** Never resets.

### 6.3 Name Resolution
- Both server and client periodically scan `AvatarBase.name` and `PlayerIdentityData` to resolve player display names (server every 3s, client every 2-5s with retry)
- Names persist in the `playerNames` Storage key
- Client sends `registerName`; the server sanitizes and rate-limits changes across reconnects, then updates the daily/all-time leaderboards, visitor sessions, and persisted name directory
- Leaderboard names patched from persisted directory on server startup

### 6.4 Discord Notifications
- **Player joins:** Delayed briefly for name resolution, then sent through `DISCORD_PLAYER_JOIN_WEBHOOK` when configured.
- **Round winners:** Sent through `DISCORD_ROUND_WINNER_WEBHOOK` when configured.
- **Feedback:** Mailbox submissions are sent through `DISCORD_MAILBOX_WEBHOOK` when configured.
- **Preview mode:** Player-join and round-winner notifications are suppressed during local preview.

### 6.5 PostHog Analytics
- Integrated via `server/posthog.ts` for server-side event tracking

---

## 7. Sound Design

| Sound | File | Trigger |
|-------|------|---------|
| Background Music | Configurable via boombox tapes (default: `SpriteSprint_Loop.mp3`) | Loops globally, toggleable with key `2` or boombox click |
| Flag Pickup | `assets/sounds/flag-pickup.mp3` | Server sends `pickupSound` |
| Flag Drop | `assets/sounds/flag-drop.mp3` | Server sends `dropSound` |
| Boomerang Throw | `assets/sounds/boomerang2.mp3` | Client on E press |
| Banana Drop | `assets/sounds/banana-drop.mp3` | `bananaDropped` message |
| Lightning Thunder | (lightning sound) | `lightningStrike` message |
| Lightning Warning | (warning sound) | `lightningWarning` message |
| Teleport | `assets/sounds/teleport.mp3` | Orb teleport activation |
| Error/Denied | `assets/sounds/error.mp3` | Ability on cooldown |
| Chest Open | `assets/sounds/chest.mp3` | Click chest |
| UI Click | `assets/sounds/click.wav` | UI button interactions |
| UI Hover | `assets/sounds/hover.wav` | UI button hover |
| Countdown Tick | `assets/sounds/click.wav` | Last 10 seconds of round |
| Trumpet | `assets/sounds/trumpets.mp3` | Round-end splash (when there are scorers) |

All sounds are silently preloaded at volume 0 on scene load (`preloadSounds.ts`) to eliminate first-play latency.

---

## 8. Controls

| Input | Action |
|-------|--------|
| WASD | Move |
| Space | Jump / Glide / Updraft |
| E | Throw boomerang (hold for Blue charge) |
| F | Drop banana |
| 1 | Cycle UI scale (Small/Medium/Large) |
| 2 | Toggle music (Mute/Insert Tape) |
| 3 | Voluntarily drop flag |
| 4 | Close any open overlay |
| Mouse Click | Throw boomerang (if no overlay open, no interactive object targeted) |

---

## 9. System Manager & Performance

### 9.1 System Manager
All client systems are registered through a centralized `systemManager.ts` that provides two registration methods:
- `registerSystem(fn)` — Per-frame systems (60fps)
- `registerThrottled(fn, interval)` — Throttled systems with configurable interval

This reduces the number of actual `engine.addSystem()` calls to 2 (one per-frame, one throttled dispatcher), improving engine overhead.

**Frame Budget Tiers:**
1. **Per-frame visual** (60fps): shield, speed boost, hold time interpolation
2. **Per-frame gameplay** (60fps): flag, combat, projectile, trap, water, ghost
3. **Per-frame time-sliced** (alternating frames, 30fps each): mushroom + lightning vs updraft + coins + beacon
4. **Throttled cosmetic** (20fps / 0.05s): water bob, coin bob/spin, water splash, boost trails
5. **Throttled proximity** (10fps / 0.1s): boombox, pedestal
6. **Throttled checks** (4fps / 0.25s): mailbox, chest, gravestone, terminal, upgrades, proximity lights
7. **Rare checks** (0.5fps / 2s): name resolver, world time update

### 9.2 Client-Side Caching
- **Leaderboard Parsing:** Cached keyed on raw JSON string. Only re-parses when server pushes new data (~every 5 minutes).
- **Visitor Parsing:** Cached keyed on raw JSON string. Only re-parses when server syncs (~every 10 seconds).
- **UI Sorting:** Two-slot LRU cache for sorted visitor/leaderboard entries.

### 9.3 Server-Side Optimizations
- Hold time CRDT sync at 2s, plus a 5s WebSocket heartbeat (not every frame)
- Projectile CRDT sync at 10Hz
- Projectile Transform NOT synced — clients compute position from component data
- Flag bob/spin is client-only
- All server systems wrapped in try/catch
- Visitor analytics capped at 100 entries per CRDT sync
- Sync ID pool with recycling to avoid CRDT tombstone accumulation

### 9.4 Entity Pools
- Projectile, trap, and combat VFX entities are pre-created in pools on scene load to avoid first-use invisible entities (GLB model loading delay)

### 9.5 Sound Preloading
- All sound effects silently played at volume 0 on scene load to cache audio clips

---

## 10. Known Issues & Edge Cases

### 10.1 CRDT Pressure
- Too many synced entities or frequent writes can saturate the CRDT buffer
- Mitigated by throttled syncs, non-synced transforms, and capped payloads
- Risk at very high player counts

### 10.2 AvatarAttach + Transform Race Condition (Resolved)
- Inserting a static intermediate entity between AvatarAttach anchor and animated visual prevents Bevy detach bug

### 10.3 Player Position Staleness
- Server reads CRDT-synced positions (~200ms stale). Mitigated by generous hit radii.

### 10.4 Ground Detection
- No server physics engine. Ground level estimated via client raycasts.

### 10.5 Carrier Disconnect
- 5s timeout on position staleness before flag is force-dropped

### 10.6 Single Server Instance
- No sharding. Server crash = full state reset (leaderboards persist via Storage).

---

## 11. Configuration Constants

| Constant | Value |
|----------|-------|
| Round Length | 5 minutes |
| Pickup Radius | 3m |
| Proximity Steal Radius | 2m |
| Steal Immunity | 3 seconds |
| Boomerang Speed (Red/Yellow) | 30 m/s |
| Boomerang Speed (Blue max) | 60 m/s |
| Boomerang Speed (Green) | 18 m/s |
| Boomerang Range (Red) | 40m |
| Boomerang Range (Yellow) | 20m |
| Boomerang Range (Blue max) | 50m |
| Boomerang Range (Green) | 30m |
| Boomerang Hit Radius | 2m |
| Boomerang Cooldown | 0.45s base |
| Blue Charge Time | 1.5s |
| Green Orbit Duration | 3.5s |
| Green Orbit Radius | 3m (client) / 4m (server) |
| Banana Lifetime | 15s |
| Banana Cooldown | 5s |
| Banana Max Active | 3 |
| Banana Trigger Radius | 2m |
| Lightning Roll Interval | 5s |
| Lightning Warning | 3s |
| Water Surface Y | 1.58 |
| Drown Time | 5s |
| Ghost Detect Radius | 20m |
| Ghost Speed | 3 m/s (5 m/s close) |
| Ghost HP | 1 |
| Ghost Spawn Interval | 20s |
| Ghost Max Active | 5 |
| Updraft Rotation | 60s |
| Boundary Radius | 128m |
| Flag Gravity | 15 m/s² |
| Cinematic Duration | 15s |
| Mushroom Count | 1 |
| Mushroom Speed Boost | +50% for 20s |
| Coin Pickup Radius | 2.5m |
| Coin Respawn Interval | 30s |
| Coin Death Penalty | 10 |
| Max Coins | 10,000 |
| Coins Per Hold Second | 0.1 |
| Participation Bonus | 1 coin |
| Placement Bonus | 5/3/1 coins |
| Blessing Reward | 6 coins (daily) |
| Blessing Duration | 32s |
| Yellow Boomerang Cost | 50 coins + 1 win |
| Green Boomerang Cost | 150 coins + 5 wins |
| Blue Boomerang Cost | 300 coins + 10 wins |

---

## 12. Rebuilding Checklist

If recreating this game from scratch, implement in this order:

1. **Scene Setup:** 32×32 parcel scene, authoritative multiplayer, world deployment to `flagtag.dcl.eth`
2. **Shared Definitions:** Components (`components.ts`), constants (`constants.ts`), date utils (`dateUtils.ts`), messages (`messages.ts`), coins (`coins.ts`), upgrades (`upgrades.ts`), sync ID pool
3. **Server Core:** Flag state machine, pickup/drop/steal, hold time tracking, round timer (UTC 5-min boundaries)
4. **Economy:** Coin wallets, coin pickups, round-end earnings, death penalties, store/purchases, blessing
5. **Client Flag System:** Visual rendering (bob, spin, particles, beacon, carry attach with static intermediate entity)
6. **Scoreboard UI:** Real-time sorted player list with interpolated scores, coin balance
7. **Boomerang System:** 4 variants (Red/Yellow/Blue/Green), server hit detection, client modular architecture (charge, flight, orbit, pool, sound, state, hand visual)
8. **Banana Trap System:** Server spawn/trigger + client visual pooling + ground raycast
9. **Lightning System:** Server probability rolls + client bolt rendering + death overlay + coin penalty
10. **Water System:** Drowning timer with air bar, movement restriction, splash VFX, coin penalty
11. **Ghost System:** Night-only ghost AI, scare meter, death overlay, boomerang/trap interaction, coin penalty
12. **Mushroom / Shield / Speed Boost:** Pickup → shield + speed boost + trail VFX
13. **Round-End Cinematic:** Fade state machine, podium teleport, virtual camera, emotes, coin earnings splash
14. **Leaderboards:** Daily + monthly + all-time with persistence + in-world 3D display
15. **Environment:** Boundary walls, teleport orbs, updraft stacks, ladders, portal, boombox, pedestal, gravestone, terminal
16. **Polish:** Proximity lights, water bob, spectator cam, mobile UI, sound preloading
17. **Analytics:** Visitor tracking (daily + monthly), Discord event notifications, PostHog integration
18. **Performance:** System manager with throttled tiers, CRDT caching, entity pools, sync ID recycling
