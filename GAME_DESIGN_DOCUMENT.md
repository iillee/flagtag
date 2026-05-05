# Flag Tag — Game Design Document

> **Version:** 1.3 · **Last Updated:** May 5, 2026  
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

- **Server** (`src/server/server.ts`): All game logic — flag state, combat hit detection, round timer, scoring, leaderboards, persistence, visitor tracking, Discord reporting. Uses `validateBeforeChange()` on all synced components so clients cannot cheat.
- **Client** (`src/index.ts` + `src/systems/*`): Rendering, input, VFX, sound, UI. Sends requests to server (`requestPickup`, `requestShell`, `requestBanana`, etc.) and reacts to server broadcasts.

### 2.2 State Synchronization

- **CRDT Components** (synced via `syncEntity`): `Flag`, `PlayerFlagHoldTime`, `CountdownTimer`, `LeaderboardState`, `AllTimeLeaderboardState`, `MonthlyLeaderboardState`, `VisitorAnalytics`, `MonthlyVisitorAnalytics`, `Trap`, `Projectile`, `Zombie`
- **Message Bus** (`registerMessages`): Used for ephemeral events — sound triggers, VFX, lightning, mushroom spawns, boomerang color changes, charge sync, orbit mechanics, ghost touching, respawn commands
- **Persistence** (`Storage` API): Flag state, leaderboards (daily + monthly + all-time), player names, visitor data (daily + monthly), Discord report tracking survive server restarts

### 2.3 Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | ~390 | Entry point; client setup, music, avatar modifiers, player tracking, hand boomerangs, charge ring, reload detection |
| `src/server/server.ts` | ~3040 | All server-side game logic |
| `src/shared/components.ts` | ~326 | Shared ECS component definitions, constants, sync IDs |
| `src/shared/messages.ts` | ~83 | Client↔Server message schema definitions |
| `src/ui.tsx` | ~2950 | UI root, overlays, death screens, splash, server-down detection |
| `src/ui/uiConstants.ts` | ~200 | Shared UI colors, scale helpers, formatters, sorting/caching logic |
| `src/systems/boundaryWalls.ts` | ~96 | Cylindrical boundary wall (colliders + proximity-fade visuals) |
| `src/systems/teleportOrbs.ts` | ~115 | Glowing teleport orb pairs with pulse animation |
| `src/systems/cinematicSystem.ts` | ~222 | Round-end fade state machine, podium camera, grounded emotes, respawnPlayers handler |
| `src/systems/flagSystem.ts` | ~651 | Client-side flag rendering (bob, spin, particles, carry visual) |
| `src/systems/projectileSystem.ts` | ~1446 | Client-side boomerang input, charge mechanic, visuals, sound |
| `src/systems/trapSystem.ts` | ~665 | Client-side banana input, visuals, sound |
| `src/systems/combatSystem.ts` | ~385 | Hit/stagger VFX, movement freeze on stun |
| `src/systems/lightningSystem.ts` | ~601 | Client-side lightning bolt rendering + stun |
| `src/systems/waterSystem.ts` | ~281 | Drowning/respawn, movement slowdown in water |
| `src/systems/zombieSystem.ts` | ~371 | Client-side ghost rendering, scare meter, death overlay |
| `src/systems/beaconSystem.ts` | ~140 | Gold vertical beacon above the flag |
| `src/systems/spectatorSystem.ts` | ~264 | Bird's-eye spectator camera (key 4) |
| `src/systems/updraftSystem.ts` | ~413 | Smoke stack updraft physics |
| `src/systems/mushroomSystem.ts` | ~423 | Mushroom collectible (grants shield) |
| `src/systems/shieldSystem.ts` | ~181 | Forcefield visual around shielded players |
| `src/systems/proximityLights.ts` | ~169 | ~60 point lights that activate near the player |
| `src/systems/remoteBoomerangSystem.ts` | ~494 | Shows other players' hand boomerangs + charge VFX |
| `src/systems/portals/portal.ts` | ~572 | Reusable portal component (Genesis Plaza link) |
| `src/systems/ladderSystem.ts` | ~104 | Click-to-climb ladder interaction |
| `src/systems/waterBobSystem.ts` | ~132 | Bobbing animation for water planes/lilypads |
| `src/systems/waterSplashSystem.ts` | ~189 | Splash VFX when walking in water |
| `src/systems/mailboxSystem.ts` | ~80 | Clickable mailbox for feedback |
| `src/systems/chestSystem.ts` | ~64 | Clickable chest (boomerang color picker) |
| `src/gameState/boomerangColor.ts` | — | Boomerang color state + change callbacks |
| `src/gameState/flagHoldTime.ts` | ~249 | Client-side player tracking, name resolution, score interpolation |
| `src/gameState/roundsWon.ts` | ~75 | Cached leaderboard parsing from CRDT |
| `src/gameState/sceneTime.ts` | ~80 | Cached visitor analytics parsing from CRDT |
| `src/cinematicState.ts` | ~5 | Cinematic active flag (shared between systems) |
| `src/shared/dayNight.ts` | ~38 | Day/night cycle detection via getWorldTime() |

---

## 3. Core Systems

### 3.1 Flag System

**States:** `AtBase` → `Carried` → `Dropped` → (cycle)

- **Pickup:** Player walks within 3m of flag → server transfers ownership
- **Proximity Steal:** Walk within 2m of the carrier → automatically steal the flag
- **Steal Immunity:** 3 seconds of immunity after picking up/stealing (prevents instant re-steal)
- **Drop:** Press `3` to voluntarily drop; also forced by boomerang hit, banana stun, lightning strike, ghost death, or drowning
- **Gravity:** Dropped flag falls with acceleration (15 m/s²) until it reaches the ground (Y estimated from carrier position history + client raycasts)
- **Water Respawn:** If flag falls below Y=1.58 (water level), it respawns at a random spawn point
- **Spawn Points:** 3 predefined locations on the map; randomly selected at round start and water respawn
- **Visual:** Client-side bob animation (0.25m amplitude), slow spin, gold particle trail, gold vertical beacon (110m tall)
- **Carry Visual:** Flag floats above carrier's head using a 3-layer entity hierarchy: `Anchor (AvatarAttach AAPT_NAME_TAG)` → `Offset (static, never mutated)` → `Visual (bob + spin)`. The static intermediate entity prevents a Bevy race condition where per-frame Transform writes on a direct AvatarAttach child cause the entity to detach and freeze in world space.

### 3.2 Round Timer & Scoring

- **Round Length:** 5 minutes, aligned to UTC 5-minute boundaries (e.g., :00, :05, :10...)
- **Scoring:** Server accumulates hold time (synced every 0.5s via CRDT); client interpolates between syncs for smooth scoreboard counting
- **Winner:** Player with the most cumulative hold time at round end
- **Round End Sequence (Server):**
  1. Flush hold time accumulator (ensures final scores are accurate)
  2. Reset flag to AtBase at random spawn point (synchronous, before any `await` — prevents `holdTimeServerSystem` from re-accumulating during async gaps)
  3. Read final scores, then reset ALL `PlayerFlagHoldTime` entities to 0 (iterates full ECS, not just tracked map, to catch stale orphans)
  4. Clear `holdTimeAccum` / `holdTimeCarrierKey` defensively
  5. Clean up traps, projectiles, orbits, cooldowns, lightning, mushrooms
  6. Broadcast `respawnPlayers` with top 3 player data (winnersJson)
  7. (async) Set splash timer + winner JSON, update all three leaderboards (daily/monthly/all-time via shared `incrementLeaderboardWins` helper), persist to Storage
- **Round End Sequence (Client):**
  1. Receive `respawnPlayers` → freeze movement, fade to black (1.5s)
  2. Top 3 players teleported to podium cubes (1st=red, 2nd=gold, 3rd=blue)
  3. Virtual camera activates (green cube position looking at red cube)
  4. Winner plays "handsair" emote, 2nd/3rd play "clap" (grounded-emote system waits for stable Y before triggering)
  5. Splash UI shows top 3 with scores + "Next round starting..."
  6. After 15s, fade to black, show credits screen with countdown, release camera, return players to spawn
- **Credits Screen:** After the cinematic (or immediately for no-scorer rounds), a black screen shows "Special Thanks to:" with rotating credit lines and "Next round in X..." countdown. Lasts 15 seconds before fading to gameplay.
- **Timer Hiding:** The round countdown timer hides as soon as the round ends and stays hidden through the entire cinematic/credits sequence.

### 3.3 Combat: Boomerang (E Key)

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
- **Customization:** 4 color variants selected via chest UI, synced to all players via `colorChanged`/`playerColorChanged` messages, visible on both hands:
  - **Red ("Base"):** Instant fire, 40m range, no extra cooldown. The default all-rounder.
  - **Yellow ("Dubs"):** Instant fire, 20m range, fires a 2nd boomerang 250ms later from left hand. +1s extra cooldown. Dual-wield style.
  - **Blue ("Charge"):** Hold E to charge (1.5s max). Speed scales 30→60 m/s, range scales 20→50m. Movement slowed while charging. Overcharge at full charge = burnout self-stun + flag drop. Extra cooldown +1s (<1s charge) or +2s (≥1s charge). Visual: gold charging ring of beads orbits the hand, grows and spins faster with charge.
  - **Green ("Orbit"):** Press E to launch boomerang in a 3m radius orbit around the player for 3.5s. Hits anyone within orbit ring. Wall collision ends orbit early. +5s extra cooldown. No projectile flight — purely close-range area denial.
- **Charge VFX (multiplayer):** Charge start/stop synced via `chargeStart`/`chargeStop` messages. Remote players see the charging ring within 16m proximity (gated to avoid unnecessary entity creation).
- **Hand Model:** Right hand always shows equipped boomerang color. Left hand shows only for Yellow variant. Both visible to other players via `remoteBoomerangSystem`.
- **Visual:** Client-side local entity with spinning animation; remote players see synced position via `Projectile` component data
- **Note:** Transform is NOT synced for projectiles (to avoid CRDT saturation); clients position visuals from component start/direction/distance data

### 3.4 Combat: Banana Trap (F Key)

- **Input:** Press F to drop at player's feet
- **Server-Authoritative:** Client sends `requestBanana`; server creates synced `Trap` entity
- **Placement:** Drops at player position with gravity fall to ground
- **Trigger:** Any player (including dropper after 2s) walks within 2m → stun + flag drop
- **Ghost Interaction:** Ghosts can trigger bananas — kills the ghost, consumes the banana
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
- **Effect:** Forces flag drop, visual bolt from sky, flash, thunder sound, victim respawn with fade overlay
- **Purpose:** Rubber-banding mechanic — prevents any single player from dominating an entire round

### 3.6 Water / Drowning

- **Water Level:** Y = 1.58 across the entire 512×512m scene (moat surrounding the castle)
- **Movement Penalty:** Running and jumping disabled in water (walk only)
- **Air Timer:** 5 seconds of air; recharges in 5 seconds on land
- **Drowning:** When air depletes, player sees "You Drowned!" death overlay, then teleported to spawn point
- **Flag Interaction:** If carrier drowns, flag is dropped; if flag falls in water, it respawns at a random spawn point
- **Visual:** Splash particles at player's feet, water bob animation on water planes/lilypads, air meter bar at bottom of screen

### 3.7 Ghost System (Night Only)

- **Schedule:** Ghost spawns only during nighttime (detected via `getWorldTime()` from `~system/Runtime`, checking for hours between ~22:00-02:00 UTC)
- **Spawning:** Single ghost at a time, spawns at (225, 1.25, 287). 30-second respawn cooldown after death.
- **Behavior (Server):**
  - Idles in slow orbit around spawn point when no player within 20m
  - Chases nearest player within 20m detection radius
  - Speed: 3 m/s base, 5 m/s when within 8m
  - Y-axis follows target player height (floats above ground)
  - Ignores players more than 20m above/below
- **Scare Meter (Client):** When ghost touches player (within 1.5m), `ghostTouching` message sent each frame. Client fills a scare meter (grey bar, turns red above 75%). Meter drains when not being touched. At 100% → death.
- **Ghost Death:** "You were scared to death!" overlay → respawn at spawn. Forces flag drop.
- **Combat:** Ghost has 1 HP; killed by boomerang hit or banana trap. Death VFX + 30s respawn cooldown.
- **Visual (Client):** `AvatarShape` NPC with ghost-like wearables, rising/sinking animation. Synced via CRDT `Zombie` component + `Transform`.
- **Dawn Despawn:** All ghosts instantly removed when night ends.

### 3.8 Mushroom / Shield

- **Server Spawning:** 1 mushroom spawned at a time within a cylindrical region (center 250.75, 255.5; radius 128m)
- **Candidate System:** Server generates 10 random candidate positions per mushroom, sends all to client. Client raycasts each candidate to find one that isn't in water, then places the visual there.
- **Pickup:** Walk within 0.5m of mushroom
- **Effect:** Grants a golden forcefield shield (8 rotating plane billboard rings)
- **Shield Behavior:** Blocks one hit (boomerang or banana), then consumed. Also removed at round end.
- **Respawn:** When picked up, server immediately spawns a replacement at a random location

### 3.9 Updraft Smoke Stacks

- **49 Chimney Locations** on castle rooftops
- **Server Rotation:** Every 60 seconds, one chimney is randomly activated
- **Visual:** Column of rising white orbs (particle-like billboard spheres)
- **Mechanic:** Player inside the column and holding jump gets physics lift upward
- **Sound:** Woosh audio when entering updraft

### 3.10 Teleport Orbs

- **2 Orb Pairs:** Orange pair and Blue pair
- **Orange:** Ground level ↔ High rooftop (290.5, 2.6, 254.7 ↔ 276.56, 52.25, 301.5)
- **Blue:** Two ground positions (224, 2.0, 288 ↔ 226.3, 2.8, 211.3)
- **Trigger:** Walk within 1.5m radius → teleport to paired orb + 3m offset
- **Cooldown:** 1 second
- **Visual:** Glowing spheres with pulsing scale animation, point lights, emissive PBR material
- **Implementation:** Self-contained in `systems/teleportOrbs.ts`

---

## 4. Map & Environment

### 4.1 Layout
- **Castle:** Large medieval structure centered around (250, y, 255) — placed as composite GLB models via Creator Hub
- **Moat:** Water plane covering the entire scene at Y=1.58, with lilypads and flowers bobbing
- **Boundary:** Cylindrical invisible wall (radius 128m from center, 48 segments, 200m tall) with faceted plane segments that fade in when the player approaches (gradient texture, red emissive glow). Stacked 10m collider segments for reliable physics. Self-contained in `systems/boundaryWalls.ts`.
- **Spawn Point:** Elevated platform at approximately (263, 47.5, 298) — players arrive on the castle ramparts

### 4.2 Lighting
- **Proximity Lights:** ~60+ point lights at predefined positions throughout the castle; each light only activates within 45m of the player to save performance (created/destroyed dynamically)
- **Day/Night Cycle:** Uses Decentraland's default skybox. `getWorldTime()` polled each frame to detect night for ghost spawning.

### 4.3 Interactive Objects
- **Ladders:** 2 climbable ladders (click to teleport to top/bottom)
- **Portal:** Genesis Plaza portal at (225.95, 2.15, 224.9)
- **Mailbox:** Clickable at (214.54, 12.54, 286.28) — opens community join popup (Decentraland social API)
- **Chest:** Clickable — opens boomerang color picker UI (4 variants with icons and labels)
- **Podium Cubes:** 4 invisible marker entities (red, gold, blue, green) used for round-end cinematic positioning. Hidden at runtime via `VisibilityComponent` + collision removal.

### 4.4 Avatar Modifiers
- **Passport Disabled:** `AvatarModifierArea` covering the full scene (522m × 50m × 522m) disables clicking on avatars to view profiles (prevents accidental passport opens during gameplay)

---

## 5. UI System

### 5.1 Desktop Layout (scaled by viewport)
- **Top Center:** Round countdown timer (MM:SS format, pill-shaped dark background). Gold color in last 10 seconds with tick sound.
- **Right Side:** Scoreboard panel — lists all players sorted by hold time, gold highlight for leader, flag icon for current carrier. Two icon buttons stacked vertically to the left of the scoreboard:
  - Flag icon → Leaderboards overlay (folder-tab UI)
  - `?` → How to Play overlay (3-column cards: Flag, Combat, Win + Controls)
- **Bottom Center:** Ability icons — Boomerang (E) and Banana (F) with cooldown overlays
- **Keyboard Shortcuts:**
  - `1` — Cycle UI scale (Small / Medium / Large) with toast notification
  - `2` — Toggle music mute
  - `3` — Drop flag
  - `4` — Close any open overlay
- **Leaderboards Overlay:** Folder-tab design with 3 top-level tabs:
  - **Status** — Game status and info
  - **Leaderboards** — Sub-tabs for Daily / Monthly / All Time. Shows rank, player name, address (monthly/all-time), and win count. Total wins in column header.
  - **Metrics** — Sub-tabs for Daily / Monthly. Visitor list with online indicator, name, address, playtime. Summary stats row. Bot detection separates likely bots (unnamed + ≤1s playtime) into a labeled section.

### 5.2 Mobile Layout
- Repositioned for touch-safe areas (avoids joystick, chat, action buttons)
- Top bar: Menu icons (left) — Timer + Score (center) — Ability icons (right)
- Overlays open as centered popups with larger touch targets and font sizes
- Score button opens full scoreboard overlay

### 5.3 Round-End Splash & Credits
- Shows top 3 players with name, rank (#1/#2/#3), and score during cinematic podium view
- Credits screen follows: "Special Thanks to:" with 4 rotating credit lines (3s each) and "Next round in X..." countdown
- No-scorer rounds skip the podium cinematic — go straight to credits on black screen
- Cinematic system self-contained in `systems/cinematicSystem.ts`

### 5.4 Death Overlays
- **Drowning:** "You Drowned!" with fade-to-black and respawn countdown
- **Lightning:** "You were struck by lightning!" with same pattern
- **Ghost:** "You were scared to death!" with same pattern
- All share the same visual style (CORAL_RED title, LIGHT_GREY countdown, black fade background)

### 5.5 UI Scaling & Constants
- `S()` function scales all UI values by viewport width ratio (base 1920px, clamped 0.6–1.6)
- Auto-detects from `UiCanvasInformation` canvas width each frame
- Manual adjustment via key `1` cycles Small (0.85×) / Medium (1.0×) / Large (1.2×)
- All colors, layout constants, formatters, and sorting logic centralized in `src/ui/uiConstants.ts`

### 5.6 Server-Down Detection
- After 20s grace period on scene load, monitors for Flag CRDT presence
- If flag entity missing for 10 consecutive seconds → "Server Disconnected" overlay
- Dismissable, re-shows every 60s if server remains down

### 5.7 Other UI Features
- **Mailbox Popup:** Community join via Decentraland social API (`signedFetch`)
- **Chest Popup:** Boomerang color picker with 4 selectable variants (icon + label)
- **Spectator Mode:** Bottom overlay with controls hint + exit button
- **UI Scale Toast:** Brief notification when UI scale changes
- **Scare Bar:** Grey/red progress bar when ghost is nearby (above drown bar if both visible)
- **Drown Bar:** Blue/red air meter when in water

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
| `playerNames` | Map of userId → display name (persisted across sessions) |
| `visitorData` | Today's visitor records (name, time spent) |
| `monthlyVisitorData` | This month's visitor records |
| `lastVisitorResetDay` | Date string for daily reset detection |
| `lastLeaderboardResetDay` | Date string for daily leaderboard reset |
| `monthlyVisitorResetMonth` | Month string for monthly visitor reset |
| `concurrentData` | Hourly peak concurrent users + daily peak |
| `dailyReportSentForDay` | Date string tracking pre-midnight Discord report |
| `pendingReport` | Deferred Discord report snapshot (sent on next server startup if missed) |

### 6.2 Daily Resets (Midnight UTC)
- **Leaderboard:** Resets daily. Before clearing, snapshots data for Discord report.
- **Visitor Data:** Resets daily; pre-midnight report sent at 23:00 UTC hour.
- **Monthly Leaderboard:** Resets on first day of each new month.
- **Monthly Visitor Data:** Resets on first day of each new month.
- **All-Time Leaderboard:** Never resets.

### 6.3 Name Resolution
- Both server and client periodically scan `AvatarBase.name` and `PlayerIdentityData` to resolve player display names (server every 3s, client every 2-5s with retry)
- Names persist in the `playerNames` Storage key so leaderboard entries show real names even after players leave
- Client sends `registerName` message when its name resolves; server calls `updatePlayerName()` which propagates to all three leaderboards, visitor sessions, and persists
- Leaderboard names patched from persisted directory on server startup via `patchAllLeaderboardNames()`

### 6.4 Discord Daily Report
- **Pre-midnight Report:** Sent automatically during UTC hour 23 (23:00-23:59)
- **Deferred Report:** If pre-midnight report was missed (no server running), data is snapshotted to `pendingReport` Storage key before daily reset. Sent on next server startup.
- **Report Content:** Scene name, date, unique users, total playtime, peak concurrent (count + time), hourly peak array, per-user breakdown (address, name, time_seconds, flags won)
- **Delivery:** Multipart form-data POST to Discord webhook with summary text + JSON file attachment. Falls back to chunked text messages if multipart fails.
- **Admin Trigger:** Admin addresses can manually trigger report via `testDiscord` message

### 6.5 Leaderboard Deduplication
- All three leaderboards (daily, monthly, all-time) share common helper functions:
  - `parseLeaderboardJson()` — safe JSON parse with fallback
  - `incrementLeaderboardWins()` — add round wins for winners
  - `patchLeaderboardNames()` — update a single player's name across entries
  - `patchAllLeaderboardNames()` — bulk name patching from persisted directory
- Eliminates the previous 3× copy-paste pattern in `handleRoundEnd()` and `updatePlayerName()`

---

## 7. Sound Design

| Sound | File | Trigger |
|-------|------|---------|
| Background Music | `assets/sounds/SpriteSprint_Loop.wav` | Loops globally, toggleable with key `2` |
| Flag Pickup | `assets/sounds/flag-pickup.mp3` | Server sends `pickupSound` |
| Flag Drop | `assets/sounds/flag-drop.mp3` | Server sends `dropSound` |
| Boomerang Throw | `assets/sounds/boomerang-throw.mp3` | Client on E press |
| Boomerang Hit | (hit VFX sound) | `shellTriggered` with victimId |
| Boomerang Miss/Return | (miss VFX sound) | `shellTriggered` without victimId |
| Banana Drop | `assets/sounds/banana-drop.mp3` | `bananaDropped` message |
| Banana Trigger | (stun sound) | `bananaTriggered` message |
| Lightning Thunder | (lightning sound) | `lightningStrike` message |
| Lightning Warning | (warning sound) | `lightningWarning` message |
| Teleport | `assets/sounds/teleport.mp3` | Orb teleport activation |
| Error/Denied | `assets/sounds/error.mp3` | Ability on cooldown |
| Chest Open | `assets/sounds/chest.mp3` | Click chest |
| UI Click | `assets/sounds/click.wav` | UI button interactions |
| UI Hover | `assets/sounds/hover.wav` | UI button hover |
| Countdown Tick | `assets/sounds/click.wav` | Last 10 seconds of round |
| Trumpet | `assets/sounds/trumpets.mp3` | Round-end splash (when there are scorers) |

---

## 8. Controls

| Input | Action |
|-------|--------|
| WASD | Move |
| Space | Jump / Glide / Updraft |
| E | Throw boomerang (hold for Blue charge) |
| F | Drop banana trap |
| 1 | Cycle UI scale (Small/Medium/Large) |
| 2 | Toggle music mute |
| 3 | Voluntarily drop flag |
| 4 | Close any open overlay |
| Mouse Click | Throw boomerang (if no overlay open, no interactive object targeted) |

---

## 9. Known Issues & Potential Faults

### 9.1 CRDT Pressure
- **Problem:** Too many synced entities or frequent writes can saturate the CRDT buffer, freezing ALL synced state (scoreboard, flag position, etc.)
- **Mitigation:** Projectile Transform is NOT synced (clients read component data instead); hold time syncs at 0.5s intervals; projectile component syncs at 10Hz; visitor data capped at 100 entries per sync
- **Risk:** High player counts with many simultaneous boomerangs + bananas could still cause pressure

### 9.2 AvatarAttach + Transform Race Condition (Resolved)
- **Problem:** Writing Transform every frame on a direct child of an AvatarAttach entity caused a race condition in Bevy's transform propagation.
- **Resolution:** Inserted a static intermediate entity between the AvatarAttach anchor and the animated visual.
- **Pattern:** `Anchor (AvatarAttach)` → `Offset (STATIC)` → `Visual (animated)`

### 9.3 Player Position Accuracy
- **Problem:** Server reads player positions from CRDT-synced `Transform` on `PlayerIdentityData` entities, which can be ~200ms stale
- **Mitigation:** Generous hit radii (2m for boomerangs, 2m for proximity steal, 3m for flag pickup)

### 9.4 Gravity & Ground Detection
- **Problem:** Server has no physics engine — ground level is estimated via client raycasts and carrier Y-position history
- **Risk:** Flag or bananas can briefly float or sink before ground data arrives

### 9.5 Carrier Disconnect
- **Detection:** Server checks `PlayerIdentityData` presence each frame + 5s staleness timeout on position data
- **Risk:** Flag can be "stuck" on a disconnected player for up to 5 seconds

### 9.6 Name Resolution Delays
- **Problem:** Player display names aren't always available immediately on connect
- **Mitigation:** Client + server both have periodic name resolver systems; names persist in Storage; startup patches all leaderboards from persisted name directory

### 9.7 Round-End Async Race Condition (Resolved)
- **Problem:** `handleRoundEnd()` was async. The flag stayed in `Carried` state through `await` gaps.
- **Resolution:** All critical state mutations happen synchronously before any `await`. Also iterates ALL hold-time entities in the ECS to catch orphaned entities.

### 9.8 Entity Limits
- 1024 parcels = generous budgets, but each active banana/boomerang/player/ghost = 1+ synced entities
- Proximity lights dynamically created/destroyed
- Boundary walls = ~1,008 entities (48 visual + 960 collider segments)

### 9.9 Mobile Experience
- Dedicated mobile UI layout with larger touch targets
- Gameplay challenging due to smaller screen, less precise aiming
- Some UI features simplified (metrics pages removed on mobile)

### 9.10 Single Server Instance
- No load balancing or sharding — all players share one server process
- Server crash = full state reset (flag, scores) though leaderboards persist via Storage

---

## 10. Performance Optimizations

### 10.1 Client-Side Caching
- **Leaderboard Parsing:** `roundsWon.ts` caches parsed + sorted entries keyed on raw JSON string. Only re-parses when server pushes new data (~every 5 minutes). Previously parsed 60×/second.
- **Visitor Parsing:** `sceneTime.ts` caches parsed visitor arrays keyed on raw JSON string. Only re-parses when server syncs (~every 10 seconds).
- **UI Sorting:** `sortVisitorsWithBotSection()` and `getSortedLeaderboardEntries()` check input array reference. Two-slot LRU cache handles daily + monthly visitors in same frame. Skips work on ~599/600 frames.

### 10.2 Server-Side Optimizations
- **Hold time sync at 0.5s** (not every frame) reduces CRDT write pressure
- **Projectile CRDT sync at 10Hz** (not 60fps) — `PROJECTILE_SYNC_INTERVAL = 0.1s`
- **Projectile Transform NOT synced** — clients compute position from component data
- **Flag bob/spin is client-only** — server only writes Transform during gravity falls
- **Safe system wrapper** — all server systems wrapped in try/catch so one error doesn't crash the frame
- **Visitor analytics capped at 100 entries** per CRDT sync to avoid oversized payloads

### 10.3 Memory Leak Prevention
- `playerBoomerangColors` map cleaned on player disconnect
- `roundWinAchievementTime` / `lastKnownWins` maps cleared on leaderboard daily reset
- Disconnected players' hold-time entities cleaned up at round end

---

## 11. Asset Manifest

### 3D Models (in `assets/models/`)
- `boomerang.r.glb`, `boomerang.y.glb`, `boomerang.b.glb`, `boomerang.g.glb` — Colored boomerangs
- `banana.glb` — Banana trap model
- `mushroom_03.glb` — Collectible mushroom
- `solid_red.glb`, `gold.glb`, `solid_blue.glb`, `solid_green.glb` — Podium marker cubes (hidden at runtime)
- Castle/environment models — placed via Creator Hub composite

### Images (in `assets/images/`)
- `boomerang.r.png`, `boomerang.y.png`, `boomerang.b.png`, `boomerang.g.png`, `boomerang.bw.png` — Ability icons
- `banana-color.png` — Banana ability icon
- `flag-icon-white.png` — Flag icon for scoreboard/leaderboard
- `beacon2.png` — Beacon image for How to Play overlay
- `UI_circle.png` — Mobile button background
- `expand.png` — Expand icon for mobile scoreboard
- `boundary-rgba.png` — Boundary wall gradient texture
- `flagtag_splash.png` — Navmap thumbnail

### Audio (in `assets/sounds/`)
- `SpriteSprint_Loop.wav` — Background music loop
- `flag-pickup.mp3`, `flag-drop.mp3` — Flag interaction
- `boomerang-throw.mp3` — Projectile fire
- `banana-drop.mp3` — Trap placement
- `teleport.mp3` — Teleport orb
- `error.mp3` — Cooldown denial
- `chest.mp3` — Chest interaction
- `click.wav` — UI click / countdown tick
- `hover.wav` — UI hover
- `trumpets.mp3` — Round-end fanfare

---

## 12. Configuration Constants Quick Reference

| Constant | Value | Location |
|----------|-------|----------|
| Round Length | 5 minutes | `components.ts` |
| Pickup Radius | 3m | `server.ts` |
| Proximity Steal Radius | 2m | `server.ts` |
| Steal Immunity | 3 seconds | `server.ts` |
| Boomerang Speed (Red/Yellow) | 30 m/s | `projectileSystem.ts` |
| Boomerang Speed (Green) | 18 m/s | `projectileSystem.ts` |
| Boomerang Speed (Blue max) | 60 m/s | `projectileSystem.ts` |
| Boomerang Range (Red) | 40m | `projectileSystem.ts` |
| Boomerang Range (Yellow) | 20m | `projectileSystem.ts` |
| Boomerang Range (Blue max) | 50m | `projectileSystem.ts` |
| Boomerang Range (Green) | 30m | `projectileSystem.ts` |
| Boomerang Hit Radius | 2m | `components.ts` |
| Boomerang Cooldown | 0.45s base | `components.ts` |
| Blue Charge Time | 1.5s | `projectileSystem.ts` |
| Green Orbit Duration | 3.5s | `server.ts` |
| Green Orbit Radius | 3m (client) / 4m hit zone (server) | `server.ts` |
| Banana Lifetime | 15s | `components.ts` |
| Banana Cooldown | 5s | `components.ts` |
| Banana Max Active | 3 | `components.ts` |
| Banana Trigger Radius | 2m | `components.ts` |
| Lightning Roll Interval | 5s | `server.ts` |
| Lightning Warning | 3s | `server.ts` |
| Water Surface Y | 1.58 | `waterSystem.ts` |
| Drown Time | 5s | `waterSystem.ts` |
| Ghost Detect Radius | 20m | `components.ts` |
| Ghost Speed | 3 m/s (5 m/s close) | `components.ts` |
| Ghost HP | 1 | `server.ts` |
| Ghost Respawn Cooldown | 30s | `server.ts` |
| Updraft Rotation | 60s | `server.ts` |
| Boundary Radius | 128m | `boundaryWalls.ts` |
| Flag Gravity | 15 m/s² | `server.ts` |
| Splash Duration | 3s | `server.ts` |
| Cinematic Duration | 15s (podium + credits) | `cinematicSystem.ts` |
| Mushroom Count | 1 | `server.ts` |
| Hold Time Sync | 0.5s | `server.ts` |
| Visitor Sync Interval | 10s | `server.ts` |
| Visitor CRDT Cap | 100 entries | `server.ts` |

---

## 13. Rebuilding Checklist

If recreating this game from scratch, implement in this order:

1. **Scene Setup:** 32×32 parcel scene, authoritative multiplayer enabled, world deployment to `flagtag.dcl.eth`
2. **Shared Components:** Define `Flag`, `PlayerFlagHoldTime`, `CountdownTimer`, `LeaderboardState`, `AllTimeLeaderboardState`, `MonthlyLeaderboardState`, `VisitorAnalytics`, `MonthlyVisitorAnalytics`, `Trap`, `Projectile`, `Zombie` with `validateBeforeChange`
3. **Message Bus:** Define all client↔server messages (see `src/shared/messages.ts`)
4. **Server Core:** Flag state machine, pickup/drop/steal logic, hold time tracking, round timer aligned to UTC 5-min boundaries
5. **Client Flag System:** Visual rendering (bob, spin, particles, beacon, carry attach with static intermediate entity)
6. **Scoreboard UI:** Real-time sorted player list with interpolated scores, cached parsing
7. **Boomerang System:** 4 variants (Red/Yellow/Blue/Green), server hit detection, client visual entity pooling, wall raycast, charge mechanic, orbit mechanic
8. **Banana Trap System:** Server spawn/trigger + client visual pooling + ground raycast reporting
9. **Lightning System:** Server probability rolls + client bolt rendering + death overlay
10. **Water System:** Drowning timer with air bar, movement restriction, splash VFX
11. **Ghost System:** Night-only ghost AI, scare meter, death overlay, boomerang/trap interaction
12. **Round-End Cinematic:** Fade state machine, podium teleport, virtual camera, grounded emotes (in `cinematicSystem.ts`)
13. **Leaderboards:** Daily + monthly + all-time with deduplicated helpers and persistence
14. **Environment:** Boundary walls (`boundaryWalls.ts`), teleport orbs (`teleportOrbs.ts`), updraft stacks, ladders, portals
15. **Polish:** Proximity lights, water bob, mushroom/shield, spectator cam, mobile UI, sound design
16. **Analytics:** Visitor tracking (daily + monthly), concurrent user peaks, Discord daily reporting with deferred snapshots
17. **Performance:** CRDT caching, projectile sync throttling, UI sort caching, memory leak prevention
