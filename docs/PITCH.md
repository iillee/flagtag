# Flagtag V2 — Retention Strategies

**Applying for:** Creator Success 2026 — v2 iteration round ($2,800 USD)
**Experience:** FlagTag — `flagtag.dcl.eth`
**Target metric:** >20% D7 retention by end of v2

## Flagtag V1 Debrief

FlagTag is a live, server-authoritative multiplayer keep-away game running 24/7 in its own world. V1 (delivered under prior Foundation funding: $3,000 initial build + $8,000 follow-on) shipped a mature, feature-rich experience including:

- Authoritative multiplayer with anti-cheat validation on all synced components
- 5-minute rounds aligned to UTC, running continuously
- Full combat: boomerangs, banana traps, lightning catch-up, ghost hazards
- Coin economy + in-game store with unlockable variants and wearables
- Daily / monthly / all-time leaderboards with persistence
- Separate mobile and desktop UI branches (React-ECS)
- PostHog visitor analytics plus Discord player-join and round-winner notifications
- Weekly hosted live events, already measurably boosting engagement

FlagTag has proven strong core gameplay and regularly attracts users for multiplayer events, but the game has a big problem: when users (especially new users) join and there is no one in the scene, they have nothing to do and usually leave immediately. This V2 proposal introduces a series of strategies and experiments that aim to reduce/solve the empty scene problem and lift D7 retention above 20%.

Strategies 1 and 2 are social and incentive driven and aim at increasing the V1 game's traffic baseline and shrinking the amount of time per day that the scene is empty. Strategy 3 adds a game mode designed specifically for solo play that will keep players from leaving the scene by giving them something to do while alone. The goal of this V2 is to pilot all 3 strategies, examine the D7 data, and iterate.

All new UI elements (solo mode HUD, crown indicators, event countdown) will follow a **mobile-first approach**, scaling up to desktop, in line with Creator Success 2026 guidance.

## V2 Strategy 1 — Formalize and Optimize Weekly Events

This is an easy strategy and something I've already begun doing. I've recently started hosting a few test events per week and have begun experimenting with play-to-earn events where users win 25 MANA per win over 12 rounds. Events are working well in bringing back a steadily growing group of core players each event.

I plan on scaling up and formalizing the event schedule to **3–5 hour-long events per week** at consistent UTC times. Live streaming events on X advertises FlagTag to the DCL community, and synchronizing event times with streamers Eve and Stephy showcases FlagTag to viewers outside of Decentraland's social sphere — a meaningful reach into audiences we don't otherwise touch.

An in-world event countdown billboard will turn empty-scene visits into "come back at X" hooks rather than bounces.

The $25/hr pay from the On the Hour program funds the play-to-earn mechanics, keeping this strategy sustainable without ongoing Creator Success subsidy.

## V2 Strategy 2 — The Daily Crown (Play-to-Earn Experiment)

In addition to play-to-earn events, I want to experiment with a daily play-to-earn strategy to keep users coming back and competing day after day.

This strategy will work by awarding the player with the most daily wins a **crown GLB attached to their avatar's head** and shown on the leaderboard. Whoever wears the crown at midnight UTC wins ~$3 USD in MANA. Daily wins then reset and the race begins again.

**Adding the daily crown nests the 5-minute regular game loop into a larger 24-hour competitive loop.** A player who logs in solo now has a longer-term goal to chase, and other players in-world seeing the crown creates natural competitive draw.

**Anti-exploit rules baked in at launch:**
- Points only count in matches with 2+ distinct real players
- Per-match hold-time cap prevents single-session farming
- Daily eligibility requires matches against 3+ distinct wallets
- Wallet + device fingerprinting aligned with Foundation's bot detection

Rules will tighten in v3 based on 60 days of live data. Payouts will be distributed manually by the studio in v2 using existing daily winner tracking; automated payout is scoped as a v3 improvement.

This experiment is funded by the On the Hour program — no ongoing Creator Success subsidy required.

## V2 Strategy 3 — Flag Time Trials (Solo Mode)

This strategy introduces a single-player time trial mode using the existing castle environment. Players carry the flag through a hand-designed course with checkpoints, hazards, and a run timer. Beat the clock, climb the solo leaderboard, and earn coins based on your ranking.

**Comprehension in 5 seconds:** "Carry the flag. Beat the clock."

The first version is hand-crafted, reusing existing terrain, flag, and hazard systems. **Daily modifier rotation** (e.g. Mon = no bananas, Tue = fog, Wed = ghost mode) creates daily variety without procedural cost, and gives players a fresh reason to run the course each day — a direct D7 driver.

If Strategy 3 shows strong retention, a procedurally-generated version that changes the course weekly or monthly becomes a natural v3 expansion. Ghost recordings of the fastest players (Mario Kart-style) is a stretch concept — cool if feasible, scoped to v3 pending v2 data.

Solo mode gets new users comfortable with the level, the mechanic of picking up the flag, and blends easily into a competitive match should another user join and interrupt the time trial with a flag steal. Solo play is the on-ramp; multiplayer is the destination.

The HUD (timer, checkpoint count, personal best) is designed mobile-first with move + jump only — no click-dependent inputs.

## 4-Week Milestone Plan

FlagTag's mature v1 (authoritative server, leaderboard persistence, daily winner tracking, mobile UI layout) lets v2 focus entirely on the new retention layers.

| Week | Deliverables |
|------|--------------|
| **1** | Crown GLB modeled + head-attach on current daily leader (in-world only). Event countdown billboard live. Solo course design + hazard scaffolding. |
| **2** | Solo mode core loop: flag pickup, checkpoints, timer, mobile HUD. First mobile playtest. Crown point-scoring rules layered onto existing server logic. |
| **3** | Daily modifier rotation, solo leaderboard persistence, anti-exploit checks live. Second mobile playtest. |
| **4** | Live World deploy. First hosted event on new build. First manual MANA crown payout. Data review, v2 sign-off. |

Public repo updates delivered by end of Week 4.

## Consideration for V3 — AI Hunter Mode

A stretch concept for solo play: waves of AI opponents that chase the flag carrier, scaling in difficulty. This is deliberately scoped out of v2 because AI tuning is high-risk — bots that feel unfair or dumb actively hurt retention — and Strategy 3 needs to prove the solo loop first. If Flag Time Trials show strong D7 retention, AI Hunters becomes the natural v3 expansion. If not, we pivot to interior build-out minigames (see below).

## Preparing for Future Expansions — Interior Build-Outs

Separate from the v2 funding ask, I've been working on adding interior rooms to the FlagTag level to create more space for interaction. The approach lifts the playable scene vertically and adds a series of doors throughout the level that teleport users to rooms below, where they can interact with NPCs, find game items, or unlock questlines and other parts of the map.

This is architectural groundwork, not a v2 deliverable. It builds structure for easily adding solo minigames, game modes, and interactions in v3 — giving us **two evidence-driven directions** for the next round: deepen solo (AI hunters, procedural courses) if Strategy 3 retention is strong, or expand content variety (interior minigames, NPCs, quests) if players want variety over depth.

## Ask

**V2 funding: $2,800 USD** to deliver Strategies 1–3 above, with live D7 data by end of Week 4 to inform v3 scope.
