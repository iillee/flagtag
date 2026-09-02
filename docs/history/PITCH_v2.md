# FlagTag v2 — Creator Success 2026 Program Pitch

**Experience:** FlagTag — `flagtag.dcl.eth`
**Applying for:** v2 iteration round ($2,800 USD)
**Current stage:** Mature live v1 delivered under prior Foundation funding ($3,000 initial build + $8,000 follow-on grant).

---

## Where FlagTag Stands Today

FlagTag is a live, server-authoritative multiplayer keep-away game running 24/7 on its own World. The v1 delivered under prior funding includes:

- **Authoritative multiplayer** with anti-cheat validation on all synced components
- **5-minute rounds** aligned to UTC, running continuously
- **Full combat systems**: boomerangs (E), banana traps (F), lightning catch-up mechanic, ghost hazards
- **Coin economy + store**: earn coins from play, unlock boomerang variants and wearables
- **Daily / monthly / all-time leaderboards** with persistence across server restarts
- **Daily ritual pedestal** blessing reward loop
- **Mobile + desktop UI layouts** (separate React-ECS branches)
- **Environmental systems**: water/drowning, updraft, spectator cam, cinematic round-end podium
- **Analytics**: PostHog visitor tracking plus Discord player-join and round-winner notifications
- **Hosted live events**: 2–3 x 1hr sessions per week, already measurably boosting engagement

**The gap v2 solves:** FlagTag has strong core gameplay and social peaks during events, but retention leaks between events when the scene is empty. v2 introduces a three-layer retention system built on top of existing infrastructure.

---

## v2 Goal

**Move D7 retention above 20%** by giving players (a) something to do when the scene is empty, (b) a daily competitive stake that pulls regulars back, and (c) predictable social peaks to plan around.

---

## The Three-Layer Retention System

### Layer 1 — Flag Trials (Solo Mode) *[new build]*

A single-player time-attack mode using the existing castle environment. Players carry the flag through a hand-designed course with checkpoints, hazards, and a run timer. Beat the clock, climb the solo leaderboard.

- **Comprehension in 5 seconds:** "Carry the flag to the goal. Beat the clock."
- **One hand-designed course** at launch, reusing existing terrain and flag/carry systems.
- **Daily modifier rotation** (e.g. Mon = no bananas, Tue = fog, Wed = ghost mode) creates daily variety without procedural cost.
- **Solo leaderboard** (daily + all-time) using existing leaderboard persistence pattern.
- **Mobile-first HUD:** timer, checkpoints, personal best. No click-dependent inputs.
- **Deterministic hazards** — no AI tuning risk (AI hunters scoped to v3 if data supports it).

### Layer 2 — The Daily Crown *[builds on existing systems]*

A crown GLB attaches to the head of the current daily points leader, visible to all players in-world. At UTC midnight the crown holder receives **~$3 USD in MANA**, distributed manually by the studio using existing daily winner tracking. Resets daily.

Leverages existing infrastructure:
- Daily winner tracking (already live)
- Authoritative server (already live)
- `AvatarAttach` patterns (already used elsewhere in the scene)

**Anti-exploit rules baked in:**
- Points only count in matches with 2+ distinct real players
- Per-match hold-time cap prevents single-session farming
- Daily eligibility requires matches against 3+ distinct wallets
- Wallet + device fingerprinting aligned with Foundation's bot detection

Solo grind remains viable — a dedicated player can win the crown across multiple real sessions, which is the intended behavior. Rules will tighten in v3 based on live data.

### Layer 3 — Scheduled Live Events *[formalizing existing practice]*

Continue 2–3 x 1hr hosted events per week at consistent UTC times. This is already proven to boost engagement; v2 formalizes it with:

- **In-world countdown billboard** — turns an empty scene into a "come back at X" hook
- **2x crown points during events** — ties social peaks to the progression system
- **Consistent weekly schedule** posted in-world and on Discord

---

## Play-to-Earn Funding Model (Self-Sustaining)

The MANA reward layer is **funded entirely by hosted-event income**, not by Creator Success funds:

- Foundation pays **$25 USD per hosted event**
- 2–3 events/week → **~$75/week budget**
- Daily crown: ~$3 × 7 days = **~$21/week**
- Remainder funds event-day bonus prizes and reserve

The play-to-earn layer is sustainable indefinitely with no ongoing Foundation subsidy. v2 funding goes entirely to building new player-facing features.

---

## Why This Fits Creator Success 2026

| Criterion | How v2 delivers |
|---|---|
| **>20% D7 retention** | Daily crown reset + daily solo modifier + weekly events = 3 independent return hooks per 7-day window |
| **Clear progression** | Existing coin economy + new solo leaderboard + daily crown pursuit |
| **Mobile-first UI** | Solo mode uses only move/jump; mobile UI branch already exists and will be extended |
| **5–10 sec comprehension** | "Carry the flag. Beat the clock." (solo) / "Hold the flag longest." (multi) |
| **Social-first** | Solo mode funnels into multiplayer via crown competition; events guarantee full lobbies |
| **Replayable** | Daily modifiers, daily crown reset, weekly leaderboard cycles |
| **Self-sustaining P2E** | Event income funds ongoing MANA — no long-term Foundation cost |

---

## Groundwork Already Underway: Vertical Scene Shift

Separate from the v2 funding ask, we are already lifting the entire playable scene vertically to open the ground plane for **interior rooms** accessible via clickable doors throughout the map. This is architectural work, not a v2 feature request — it is the delivery vehicle for future content.

Once complete, the ground plane becomes a portfolio of teleportable interior spaces: minigame rooms, stores, dungeons, NPC hubs, cross-scene portals. This gives us a **second expansion vector for v3**: if solo mode retention data is strong, we double down on Flag Trials variants; if the data suggests players want variety over depth, we lean into interior content (minigames, NPCs, dungeons) using the space we’ve already built.

This is deliberate optionality — v2 ships the retention system, and v3 has two proven directions to choose from based on evidence.

---

## 4-Week Milestone Plan

FlagTag's mature v1 (authoritative server, leaderboard persistence, daily winner tracking, mobile UI layout) lets v2 focus entirely on the new retention layers.

- **Week 1** — Crown GLB modeled + head-attach on daily leader (in-world only, no payout yet). Event countdown billboard live. Solo mode course design + hazard entity scaffolding.
- **Week 2** — Solo mode core loop: flag pickup, checkpoints, timer, mobile HUD. First mobile playtest of solo run. Crown point-scoring rules layered onto existing server logic.
- **Week 3** — Daily modifier rotation, solo leaderboard persistence, anti-exploit checks live (2+ player rule, per-match cap, distinct-wallet requirement). Second mobile playtest.
- **Week 4** — Live World deploy, first hosted event on new build, first manual MANA payout distributed. Data review, v2 sign-off.

Public repo updates delivered by end of Week 4.

---

## v3 Roadmap (For Reference)

Scoped out of v2 to keep the build lean and evidence-driven:

**Direction A — Deepen solo (if Flag Trials retention is strong):**
- Procedural / seeded course variation
- Ghost replays of top solo runs
- AI hunter mode ("Flag Hunt")
- Weekly leaderboard cycle + cosmetic unlocks (rank badges, flag skins, trails)

**Direction B — Expand content variety (using interior-room groundwork):**
- Interior minigame rooms accessible via in-world doors
- NPC hubs with quest/dialogue loops
- Dungeon-style progression zones
- Store / cosmetics rooms
- Cross-scene portals to partner experiences

**Cross-cutting (either direction):**
- Solo → multiplayer cosmetic flex (crown-holder aura, rank visible in multi)
- Automated MANA payout via signed contract call
- Tightened anti-exploit rules based on 60 days of live crown data
- Expanded event formats (tournaments, guest hosts, cross-scene collaborations)

---

## Ask

**v2 funding: $2,800 USD** to deliver the three-layer retention system above, with live playtest data by end of Week 4 to inform v3 scope. Program-standard iteration terms.
