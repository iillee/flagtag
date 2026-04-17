# Flag Tag — Game Design Document

> **Version:** 1.0 · **Last Updated:** April 17, 2026  
> **Platform:** Decentraland SDK7 · **Deployment:** World (`flagtag.dcl.eth`)  
> **Scene Size:** 32×32 parcels (512m × 512m, 1024 parcels)

---

## 1. Game Overview

**Flag Tag** is a multiplayer "keep away" game set in a medieval castle environment surrounded by a moat. Players compete to hold a single flag for the longest cumulative time during 5-minute rounds that run continuously 24/7, aligned to UTC clock boundaries.

**Core Loop:** Find the flag → Pick it up → Run and survive → Score points by holding it → Win the round.

---

## 2. Architecture

### 2.1 Client/Server Split (Authoritative Multiplayer)

The scene uses Decentraland's **authoritative server** architecture (`authoritativeMultiplayer: true` in scene.json). A single entry point (`src/index.ts`) branches via `isServer()`:

- **Server** (`src/server/server.ts`): All game logic — flag state, combat hit detection, round timer, scoring, leaderboards, persistence, visitor tracking. Uses `validateBeforeChange()` on all synced components so clients cannot cheat.
- **Client** (`src/index.ts` + `src/systems/*`): Rendering, input, VFX, sound, UI. Sends requests to server (`requestPickup`, `requestShell`, `requestBanana`, etc.) and reacts to server broadcasts.

### 2.2 State Synchronization

- **CRDT Components** (synced via `syncEntity`): `Flag`, `PlayerFlagHoldTime`, `CountdownTimer`, `LeaderboardState`, `AllTimeLeaderboardState`, `VisitorAnalytics`, `Trap`, `Projectile`
- **Message Bus** (`registerMessages`): Used for ephemeral events — sound triggers, VFX, lightning, mushroom spawns, boomerang color changes, respawn commands
- **Persistence** (`Storage` API): Flag state, leaderboards (daily + all-time), player names, visitor data survive server restarts

### 2.3 Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point; client setup, boundary walls, teleport orbs, round-end cinematic, music |
| `src/server/server.ts` | All server-side game logic (~2500 lines) |
| `src/shared/components.ts` | Shared ECS component definitions, constants, sync IDs |
| `src/shared/messages.ts` | Client↔Server message schema definitions |
| `src/ui.tsx` | Full UI (desktop + mobile layouts) — scoreboard, timer, abilities, overlays |
| `src/systems/flagSystem.ts` | Client-side flag rendering (bob, spin, particles, carry visual) |
| `src/systems/projectileSystem.ts` | Client-side boomerang input, visuals, sound |
| `src/systems/trapSystem.ts` | Client-side banana input, visuals, sound |
| `src/systems/combatSystem.ts` | Hit/stagger VFX, movement freeze on stun |
| `src/systems/lightningSystem.ts` | Client-side lightning bolt rendering + stun |
| `src/systems/waterSystem.ts` | Drowning/respawn, movement slowdown in water |
| `src/systems/beaconSystem.ts` | Gold vertical beacon above the flag |
| `src/systems/spectatorSystem.ts` | Bird's-eye spectator camera (key 4) |
| `src/systems/updraftSystem.ts` | Smoke stack updraft physics |
| `src/systems/mushroomSystem.ts` | Mushroom collectible (grants shield) |
| `src/systems/shieldSystem.ts` | Forcefield visual around shielded players |
| `src/systems/proximityLights.ts` | ~60 point lights that activate near the player |
| `src/systems/remoteBoomerangSystem.ts` | Shows other players' hand boomerangs |
| `src/systems/portals/portal.ts` | Reusable portal component (Genesis Plaza link) |
| `src/systems/ladderSystem.ts` | Click-to-climb ladder interaction |
| `src/systems/waterBobSystem.ts` | Bobbing animation for water planes/lilypads |
| `src/systems/waterSplashSystem.ts` | Splash VFX when walking in water |
| `src/systems/mailboxSystem.ts` | Clickable mailbox for feedback |
| `src/systems/chestSystem.ts` | Clickable chest (boomerang color picker) |

---

## 3. Core Systems

### 3.1 Flag System

**States:** `AtBase` → `Carried` → `Dropped` → (cycle)

- **Pickup:** Player walks within 3m of flag → server transfers ownership
- **Proximity Steal:** Walk within 2m of the carrier → automatically steal the flag
- **Steal Immunity:** 3 seconds of immunity after picking up/stealing (prevents instant re-steal)
- **Drop:** Press `3` to voluntarily drop; also forced by boomerang hit, banana stun, lightning strike, or drowning
- **Gravity:** Dropped flag falls with acceleration (15 m/s²) until it reaches the ground (Y estimated from carrier position history + client raycasts)
- **Water Respawn:** If flag falls below Y=1.58 (water level), it respawns at a random spawn point
- **Spawn Points:** 3 predefined locations on the map; randomly selected at round start and water respawn
- **Visual:** Client-side bob animation (0.25m amplitude), slow spin, gold particle trail, gold vertical beacon (110m tall)
- **Carry Visual:** Flag attaches to carrier's right hand via `AvatarAttach`

### 3.2 Round Timer & Scoring

- **Round Length:** 5 minutes, aligned to UTC 5-minute boundaries (e.g., :00, :05, :10...)
- **Scoring:** Server accumulates hold time (synced every 0.5s via CRDT); client interpolates between syncs for smooth scoreboard counting
- **Winner:** Player with the most cumulative hold time at round end
- **Round End Sequence:**
  1. Server broadcasts `respawnPlayers`
  2. All clients freeze movement, fade to black (1.5s)
  3. Top 3 players teleported to podium cubes (1st=red, 2nd=gold, 3rd=blue)
  4. Virtual camera activates (green cube position looking at red cube)
  5. Winner plays "handsair" emote, 2nd/3rd play "clap"
  6. Splash UI shows top 3 with scores + "Next round starting..."
  7. After 10s (or 3s if no scorers), fade to black, release camera, return players to spawn
- **No Scorers Round:** If nobody scored, short 3s black interstitial instead of full cinematic

### 3.3 Combat: Boomerang (E Key)

- **Input:** Press E (or click on mobile) to throw
- **Server-Authoritative:** Client sends `requestShell` with camera direction; server spawns synced `Projectile` entity
- **Flight:** Travels in a straight line at 30 m/s on the XZ plane, up to 50m (or until wall hit)
- **Wall Detection:** Client performs raycast and reports `reportShellWallDist` to cap range
- **Return:** After reaching max range, boomerang homes back to the thrower. Consumed when it reaches them.
- **Hit Detection (Server):** 2m radius hit check against all players except the thrower
- **On Hit:** Forces flag drop if victim is carrying; victim gets stun VFX + movement freeze
- **Trap Interaction:** Boomerang destroys bananas on contact, then returns
- **Cooldown:** 0s (can throw again immediately after return)
- **Max Active:** 1 per player
- **Customization:** 4 colors (Red, Yellow, Blue, Green) — selected via chest UI, synced to all players, visible on hand model
- **Visual:** Client-side local entity with spinning animation; remote players see synced position via `Projectile` component data
- **Note:** Transform is NOT synced for projectiles (to avoid CRDT saturation); clients position visuals from component start/direction/distance data

### 3.4 Combat: Banana Trap (F Key)

- **Input:** Press F to drop at player's feet
- **Server-Authoritative:** Client sends `requestBanana`; server creates synced `Trap` entity
- **Placement:** Drops at player position with gravity fall to ground
- **Trigger:** Any player (including dropper after 2s) walks within 2m → stun + flag drop
- **Lifetime:** 15 seconds, then despawns
- **Cooldown:** 5 seconds between drops
- **Max Active:** 3 per player simultaneously
- **Self-Hit:** Immune for 2s after dropping, then can trigger own banana
- **Visual:** `models/banana.glb` — client attaches the model locally (server doesn't create visuals)

### 3.5 Lightning System

- **Trigger:** Server-side probability roll every 5 seconds while flag is carried
- **Probability Curve:** Scales with carrier's score:
  - <100s: 0%
  - 100-200s: 5-10% per roll
  - 200-250s: 10-40%
  - 250-280s: 40-70%
  - 280+: 70-95%
- **Warning:** 3-second delay between roll success and strike (server sends `lightningWarning`)
- **Strike:** Server determines position (carrier or flag), sends `lightningStrike` with victim ID
- **Effect:** Forces flag drop, visual bolt from sky, flash, thunder sound, victim stun
- **Purpose:** Rubber-banding mechanic — prevents any single player from dominating an entire round

### 3.6 Water / Drowning

- **Water Level:** Y = 1.58 across the entire 512×512m scene (moat surrounding the castle)
- **Movement Penalty:** Running and jumping disabled in water (walk only)
- **Air Timer:** 5 seconds of air; recharges in 5 seconds on land
- **Drowning:** When air depletes, player is stunned and teleported to spawn point
- **Flag Interaction:** If carrier drowns, flag is dropped; if flag falls in water, it respawns at a random spawn point
- **Visual:** Splash particles at player's feet, water bob animation on water planes/lilypads

### 3.7 Mushroom / Shield

- **Server Spawning:** 1 mushroom spawned at a time within a cylindrical region (center 250.75, 255.5; radius 128m)
- **Pickup:** Walk within 0.5m of mushroom
- **Effect:** Grants a golden forcefield shield (8 rotating plane billboard rings)
- **Shield Behavior:** Blocks one hit (boomerang or banana), then consumed. Also removed at round end.
- **Respawn:** When picked up, server immediately spawns a replacement at a random location
- **Water Avoidance:** Client raycasts to check if mushroom landed in water; if so, sends `rerollMushroom` (max 10 rerolls)

### 3.8 Updraft Smoke Stacks

- **49 Chimney Locations** on castle rooftops
- **Server Rotation:** Every 60 seconds, one chimney is randomly activated
- **Visual:** Column of rising white orbs (particle-like billboard spheres)
- **Mechanic:** Player inside the column and holding jump gets physics lift upward
- **Sound:** Woosh audio when entering updraft

### 3.9 Teleport Orbs

- **2 Orb Pairs:** Orange pair and Blue pair
- **Orange:** Ground level ↔ High rooftop (290.5, 2.6, 254.7 ↔ 276.56, 52.25, 301.5)
- **Blue:** Two ground positions (224, 2.3, 288 ↔ 226.3, 2.8, 211.3)
- **Trigger:** Walk within 1.5m radius → teleport to paired orb + 3m offset
- **Cooldown:** 1 second
- **Visual:** Glowing spheres with pulsing scale animation, point lights, emissive PBR material

---

## 4. Map & Environment

### 4.1 Layout
- **Castle:** Large medieval structure centered around (250, y, 255) — placed as composite GLB models via Creator Hub
- **Moat:** Water plane covering the entire scene at Y=1.58, with lilypads and flowers bobbing
- **Boundary:** Cylindrical invisible wall (radius 128m from center) with 48 faceted plane segments that fade in when the player approaches (gradient texture, red emissive glow)
- **Spawn Point:** Elevated platform at approximately (263, 47.5, 298) — players arrive on the castle ramparts

### 4.2 Lighting
- **Proximity Lights:** ~60+ point lights at predefined positions throughout the castle; each light only activates within 45m of the player to save performance (created/destroyed dynamically)
- **Ambient:** Default Decentraland skybox (no custom skybox time override)

### 4.3 Interactive Objects
- **Ladders:** 2 climbable ladders (click to teleport to top/bottom)
- **Portal:** Genesis Plaza portal at (225.95, 2.15, 224.9)
- **Mailbox:** Clickable at (214.54, 12.54, 286.28) — opens feedback form in UI
- **Chest:** Clickable — opens boomerang color picker UI
- **Podium Cubes:** 4 invisible marker entities (red, gold, blue, green) used for round-end cinematic positioning

### 4.4 Avatar Modifiers
- **Passport Disabled:** `AvatarModifierArea` covering the full scene disables clicking on avatars to view profiles (prevents accidental passport opens during gameplay)

---

## 5. UI System

### 5.1 Desktop Layout (scaled by viewport)
- **Top-Left:** Round countdown timer (MM:SS format, pill-shaped dark background)
- **Right Side:** Scoreboard panel — lists all players sorted by hold time, gold highlight for leader, flag icon for current carrier
- **Bottom Center:** Ability icons — Boomerang (E) and Banana (F) with cooldown overlays
- **Scoreboard Header Icons:**
  - `?` → How to Play overlay (3-column cards: Flag, Combat, Environment + Controls bar)
  - Flag icon → Leaderboard overlay (Daily / All Time tabs with scrolling)
  - `#` → Analytics overlay (daily visitors, online count, server status, time-in-scene)

### 5.2 Mobile Layout
- Repositioned for touch-safe areas (avoids joystick, chat, action buttons)
- Top bar: Menu icons (left) — Timer + Score (center) — Ability icons (right)
- Overlays open as centered popups with larger touch targets
- Score button opens full scoreboard overlay

### 5.3 Round-End Splash
- Shows top 3 players with name, rank (#1/#2/#3), and score
- "Next round starting..." message
- Closeable via × button
- Appears during cinematic camera sequence

### 5.4 UI Scaling
- `S()` function scales all UI values by viewport width ratio (base 1920px)
- Keyboard shortcut `1` cycles through 4 UI scale modes (auto, 75%, 100%, 125%)
- Keyboard shortcut `2` toggles music mute

---

## 6. Persistence & Leaderboards

### 6.1 Storage Keys
| Key | Content |
|-----|---------|
| `flagState` | Flag position, state, carrier ID, drop anchors |
| `leaderboard` | Daily leaderboard JSON (userId, name, roundsWon) |
| `allTimeLeaderboard` | All-time leaderboard JSON |
| `playerNames` | Map of userId → display name (persisted across sessions) |
| `visitorData` | Today's visitor records (name, time spent) |
| `lastVisitorResetDay` | Date string for daily reset detection |
| `lastLeaderboardResetDay` | Date string for daily leaderboard reset |
| `concurrentData` | Hourly peak concurrent users |

### 6.2 Daily Resets
- **Leaderboard:** Resets at midnight UTC (checked via `getTodayDateString()`)
- **Visitor Data:** Resets at midnight UTC; pre-midnight report logged at 23:55 UTC
- **All-Time Leaderboard:** Never resets

### 6.3 Name Resolution
- Both server and client periodically scan `AvatarBase.name` and `PlayerIdentityData` to resolve player display names
- Names persist in the `playerNames` Storage key so leaderboard entries show real names even after players leave
- Client sends `registerName` message when its name resolves; server updates all data stores

---

## 7. Sound Design

| Sound | File | Trigger |
|-------|------|---------|
| Background Music | `assets/sounds/Medieval.mp3` | Loops globally, toggleable with key `2` |
| Flag Pickup | `assets/sounds/flag-pickup.mp3` | Server sends `pickupSound` |
| Flag Drop | `assets/sounds/flag-drop.mp3` | Server sends `dropSound` |
| Boomerang Throw | `assets/sounds/boomerang-throw.mp3` | Client on E press |
| Boomerang Hit | (hit VFX sound) | `shellTriggered` with victimId |
| Boomerang Miss/Return | (miss VFX sound) | `shellTriggered` without victimId |
| Banana Drop | `assets/sounds/banana-drop.mp3` | `bananaDropped` message |
| Banana Trigger | (stun sound) | `bananaTriggered` message |
| Lightning Thunder | (lightning sound) | `lightningStrike` message |
| Lightning Warning | (warning sound) | `lightningWarning` message |
| Teleport | `assets/sounds/rs-teleport.mp3` | Orb teleport activation |
| Error/Denied | `assets/sounds/error.mp3` | Ability on cooldown |
| Water | (water sounds) | Enter/exit water zone |
| Chest Open | `assets/sounds/chest.mp3` | Click chest |
| UI Click | (click sound) | UI button interactions |

---

## 8. Controls

| Input | Action |
|-------|--------|
| WASD | Move |
| Space | Jump / Glide / Updraft |
| E | Throw boomerang |
| F | Drop banana trap |
| 1 | Cycle UI scale |
| 2 | Toggle music mute |
| 3 | Voluntarily drop flag |
| 4 | Toggle spectator camera |
| Mouse | Look / Aim boomerang direction |

---

## 9. Known Issues & Potential Faults

### 9.1 CRDT Pressure
- **Problem:** Too many synced entities or frequent writes can saturate the CRDT buffer, freezing ALL synced state (scoreboard, flag position, etc.)
- **Mitigation:** Projectile Transform is NOT synced (clients read component data instead); hold time syncs at 0.5s intervals; projectile component syncs at 10Hz
- **Risk:** High player counts with many simultaneous boomerangs + bananas could still cause pressure

### 9.2 Player Position Accuracy
- **Problem:** Server reads player positions from CRDT-synced `Transform` on `PlayerIdentityData` entities, which can be ~200ms stale
- **Impact:** Hit detection, proximity steal, and flag carry position may be slightly delayed
- **Mitigation:** Generous hit radii (2m for boomerangs, 2m for proximity steal, 3m for flag pickup)

### 9.3 Gravity & Ground Detection
- **Problem:** Server has no physics engine — ground level is estimated via client raycasts (`reportGroundY`, `reportShellGroundY`, `reportBananaGroundY`) and carrier Y-position history
- **Risk:** Flag or bananas can briefly float or sink before ground data arrives; if no client reports ground, objects fall to `FLAG_MIN_Y` (1.5m)

### 9.4 Carrier Disconnect
- **Detection:** Server checks `PlayerIdentityData` presence each frame + 5s staleness timeout on position data
- **Risk:** Brief network hiccups could trigger false disconnect detection; 5s timeout means flag can be "stuck" on a disconnected player for up to 5 seconds

### 9.5 Name Resolution Delays
- **Problem:** Player display names aren't always available immediately on connect (Decentraland platform latency)
- **Mitigation:** Client + server both have periodic name resolver systems (every 2-3s); names persist in Storage
- **Risk:** Leaderboard entries may briefly show truncated wallet addresses (0x...) before names resolve

### 9.6 Round Timer Drift
- **Problem:** Rounds are aligned to UTC clock boundaries, but `Date.now()` on the server may have slight drift
- **Mitigation:** Server recalculates next boundary from `Date.now()` at each round end; countdown is pure UTC-based (not accumulated delta time)

### 9.7 Entity Limits
- **Scene is 1024 parcels** — generous entity/triangle budgets, but:
  - Each active banana = 1 synced entity
  - Each active boomerang = 1 synced entity  
  - Each player = 1 hold-time synced entity
  - Proximity lights dynamically created/destroyed
- **Risk:** With many players all using abilities simultaneously, entity count could spike

### 9.8 Mobile Experience
- The game has a dedicated mobile UI layout, but gameplay is challenging on mobile due to:
  - Smaller screen real estate
  - Touch controls less precise for aiming boomerangs
  - No E/F key access (relies on Decentraland's action bar slots)

### 9.9 Single Server Instance
- The authoritative server is a single instance — there's no load balancing or sharding
- All players in the world connect to the same server process
- Server crash = full state reset (flag position, scores) though leaderboards persist via Storage

---

## 10. Asset Manifest

### 3D Models (in `models/`)
- `boomerang.r.glb`, `boomerang.y.glb`, `boomerang.b.glb`, `boomerang.g.glb` — Colored boomerangs
- `banana.glb` — Banana trap model
- `mushroom_03.glb` — Collectible mushroom
- `solid_red.glb`, `gold.glb`, `solid_blue.glb`, `solid_green.glb` — Podium marker cubes (hidden at runtime)
- Castle/environment models — placed via Creator Hub composite

### Images (in `assets/images/` and `images/`)
- `boomerang.r.png`, `boomerang.y.png`, `boomerang.b.png`, `boomerang.g.png`, `boomerang.bw.png` — Ability icons
- `banana-color.png` — Banana ability icon
- `flag-icon-white.png` — Flag icon for scoreboard/leaderboard
- `UI_circle.png` — Mobile button background
- `expand.png` — Expand icon for mobile scoreboard
- `boundary-rgba.png` — Boundary wall gradient texture
- `flagtag_splash.png` — Navmap thumbnail

### Audio (in `assets/sounds/`)
- `Medieval.mp3` — Background music loop
- `flag-pickup.mp3`, `flag-drop.mp3` — Flag interaction
- `boomerang-throw.mp3` — Projectile fire
- `banana-drop.mp3` — Trap placement
- `rs-teleport.mp3` — Teleport orb
- `error.mp3` — Cooldown denial
- `chest.mp3` — Chest interaction
- Various hit/miss/water/lightning sounds

---

## 11. Configuration Constants Quick Reference

| Constant | Value | Location |
|----------|-------|----------|
| Round Length | 5 minutes | `components.ts` |
| Pickup Radius | 3m | `server.ts` |
| Proximity Steal Radius | 2m | `server.ts` |
| Steal Immunity | 3 seconds | `server.ts` |
| Boomerang Speed | 30 m/s | `components.ts` |
| Boomerang Range | 50m | `components.ts` |
| Boomerang Hit Radius | 2m | `components.ts` |
| Boomerang Cooldown | 0s | `components.ts` |
| Banana Lifetime | 15s | `components.ts` |
| Banana Cooldown | 5s | `components.ts` |
| Banana Max Active | 3 | `components.ts` |
| Banana Trigger Radius | 2m | `components.ts` |
| Lightning Roll Interval | 5s | `server.ts` |
| Lightning Warning | 3s | `server.ts` |
| Water Surface Y | 1.58 | `waterSystem.ts` |
| Drown Time | 5s | `waterSystem.ts` |
| Updraft Rotation | 60s | `server.ts` |
| Boundary Radius | 128m | `index.ts` |
| Flag Gravity | 15 m/s² | `server.ts` |
| Splash Duration | 3s | `server.ts` |
| Cinematic Duration | 10s (3s no scorers) | `index.ts` |
| Mushroom Count | 1 | `server.ts` |
| Hold Time Sync | 0.5s | `server.ts` |

---

## 12. Rebuilding Checklist

If recreating this game from scratch, implement in this order:

1. **Scene Setup:** 32×32 parcel scene, authoritative multiplayer enabled, world deployment to `flagtag.dcl.eth`
2. **Shared Components:** Define `Flag`, `PlayerFlagHoldTime`, `CountdownTimer`, `LeaderboardState`, `AllTimeLeaderboardState`, `VisitorAnalytics`, `Trap`, `Projectile` with `validateBeforeChange`
3. **Message Bus:** Define all client↔server messages (see `src/shared/messages.ts`)
4. **Server Core:** Flag state machine, pickup/drop/steal logic, hold time tracking, round timer aligned to UTC 5-min boundaries
5. **Client Flag System:** Visual rendering (bob, spin, particles, beacon, carry attach)
6. **Scoreboard UI:** Real-time sorted player list with interpolated scores
7. **Boomerang System:** Server hit detection + client visual entity pooling + wall raycast reporting
8. **Banana Trap System:** Server spawn/trigger + client visual pooling + ground raycast reporting
9. **Lightning System:** Server probability rolls + client bolt rendering
10. **Water System:** Drowning timer, movement restriction, splash VFX
11. **Round-End Cinematic:** Fade sequence, podium teleport, virtual camera, emotes
12. **Leaderboards:** Daily + all-time with persistence and daily reset
13. **Environment:** Boundary walls, teleport orbs, updraft stacks, ladders, portals
14. **Polish:** Proximity lights, water bob, mushroom/shield, spectator cam, mobile UI, sound design
15. **Analytics:** Visitor tracking, concurrent user peaks, daily reporting
