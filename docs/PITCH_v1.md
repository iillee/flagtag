# FlagTag v1 — Creator Success Program Pitch

**Studio:** [Your Name]  **Experience:** FlagTag (flagtag.dcl.eth)
**Current status:** Live 24/7 multiplayer keep-away. Seeking v1 funding.

---

## The Problem We're Solving

FlagTag's core loop (5-min rounds of multiplayer keep-away) is strong when the scene is populated but suffers the classic multiplayer retention leak: **an empty scene is a dead scene.** New players who arrive to an empty world bounce and rarely return. Our v1 goal is to fix this with a three-layer retention system that gives players a reason to log in solo, a reason to compete daily, and a reason to show up at scheduled times.

**Target: >20% D7 retention by end of v1.**

---

## The Three-Layer Retention System

### Layer 1 — Flag Trials (Solo Mode)

A single-player time-attack mode. Players carry the flag through a procedurally-seeded obstacle course with hazards, moving platforms, and checkpoints. Beat the clock, climb the leaderboard.

- **Comprehension in 5 seconds:** "Carry the flag to the goal. Don't drop it."
- **Daily seed** rotates the course layout — same rules, fresh run every day.
- **Weekly leaderboard** with ghost replays of top times.
- **Mobile-first:** move + jump only. No click-dependent mechanics.
- **De-risked:** deterministic hazards (no AI tuning problems). If we later want AI hunters, that's a v2 stretch goal — not a v1 dependency.

### Layer 2 — The Daily Crown (Play-to-Earn)

A visible crown GLB attaches to the head of the current daily points leader. At UTC midnight the crown holder receives **100 MANA** paid automatically. Resets daily.

**Why this works:** competitive players will show up daily to defend or contest the crown. Even 2–3 invested regulars is enough to break the "empty scene" problem — new arrivals see live play and stay. The crown itself is free marketing: every player who sees it in-world understands there's something to compete for.

**Points are earned by:**
- Time holding the flag during valid matches
- Tagging the current flag-holder
- Match participation

**Anti-exploit measures (built into v1):**
- Points only count in matches with 2+ distinct real players
- Per-match hold-time cap prevents single-session farming
- Wallet + device fingerprinting aligned with Foundation's bot detection
- Point validation runs on our existing authoritative server (already live)
- Daily eligibility requires matches against 3+ distinct wallets
- MANA payouts distributed manually by the studio in v1 (using existing daily winner tracking) — automated payout is a v2 upgrade once payout patterns are proven

**Solo grind stays viable:** we deliberately keep the crown open to solo grinders willing to play across multiple sessions with different opponents. The intent is to *encourage* dedicated players, not gatekeep. We'll monitor and tighten rules based on live data — this is exactly the kind of thing v2 iteration is for.

### Layer 3 — Scheduled Live Events

2–3 x 1hr hosted events per week at consistent times (e.g. Tue 20:00 UTC, Sat 15:00 UTC). This is already proven — hosted events have measurably boosted engagement in the current live version.

- **In-world countdown billboard** turns an empty scene into a "come back at X" hook instead of a bounce.
- **2x crown points during events** ties social peaks to the progression system.
- **Predictability > frequency** — regulars can plan around it.

---

## Play-to-Earn Funding Model (Self-Sustaining)

The MANA rewards are **funded entirely by hosted-event income**, not by Creator Success funds:

- Foundation pays **$25 USD per hosted event**
- We run **2–3 events per week** → **~$75/week budget**
- Daily crown payout: **100 MANA ≈ $2–4 USD** (at current rates) × 7 days = **~$14–28/week**
- Remaining budget covers occasional weekly bonus rewards, event-day prize pools, and reserve.

This means the play-to-earn layer is **sustainable indefinitely** without ongoing Foundation subsidy, and scales naturally: more events = more budget = larger prize pools = more competitive draw.

---

## Why This Fits Creator Success 2026

| Criterion | How FlagTag v1 delivers |
|---|---|
| **>20% D7 retention** | Daily crown reset + daily solo seed + weekly events = 3 independent return hooks per 7-day window |
| **Progression** | Points, ranks, unlockable cosmetics, weekly leaderboards |
| **Mobile-first UI** | Solo mode uses only move/jump; HUD designed mobile-first, scales to desktop |
| **5–10 sec comprehension** | Solo: "carry the flag." Multi: "hold the flag longest." One sentence each. |
| **Social-first** | Crown & events drive the multiplayer core; solo is the on-ramp and retention layer |
| **Replayable** | Daily course seeds, daily crown reset, weekly leaderboard cycles |
| **Self-sustaining P2E** | Event income funds ongoing MANA rewards — no long-term Foundation cost |

---

## 6-Week Milestone Plan

FlagTag already has a live authoritative server, daily winner tracking, and a leaderboard system, which lets v1 focus on the new retention layers rather than backend groundwork.

- **Week 1** — Solo mode prototype: flag pickup, course structure, timer, mobile HUD sketch. Crown GLB modeled and rigged for head-attach.
- **Week 2** — Core interaction test: playable solo course, first mobile playtest. Crown attaches in-world to the current daily leader (leveraging existing winner tracking).
- **Week 3** — Daily course seed system, solo leaderboard persistence, crown point-scoring rules layered onto existing server logic.
- **Week 4** — Anti-exploit checks live (2+ player rule, per-match cap, distinct-wallet requirement). Second mobile playtest. Manual MANA payout process documented and dry-run.
- **Week 5** — Live World deploy, in-world event countdown billboard, first live event on new build. First real MANA payout distributed manually.
- **Week 6** — Live testing across two hosted events, data review, v1 sign-off.

Public repo delivered by end of Week 6. **Automated payout is scoped as a v2 improvement** once manual distribution has validated the reward model.

---

## Ask

**v1 funding: $3,100 USD** to deliver the three-layer system above, with live playtest data by Week 6 to inform v2. Program-standard iteration terms.