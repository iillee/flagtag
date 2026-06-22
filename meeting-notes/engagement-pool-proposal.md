# Proposal: Engagement-Based Creator Payout Pool

## The Problem

- Too few players to charge directly — paywalls kill growth at this stage
- Grants require applications, committees, and don't scale
- Creators have no predictable revenue, making it irrational to invest serious development time vs. building on Roblox/Fortnite Creative
- Foundation has no public scene metrics — creators can't prove value, Foundation can't identify what's working

## The Solution

**A monthly payout pool distributed automatically to scenes based on transparent engagement metrics.**

No applications. No committees. Build something players love, get paid proportionally.

## How It Works

1. **Foundation publishes real-time scene analytics** — publicly accessible, auditable
2. **A fixed monthly pool** (e.g. $X MANA/month from DAO treasury) is allocated to creator payouts
3. **Distribution is formulaic** — based on a weighted engagement score, paid monthly to scene deployer wallets

## Metric Weighting (Suggested)

| Metric | Why | Weight |
|--------|-----|--------|
| Unique return visitors | Proves retention, not drive-bys | High |
| Average session duration | Proves quality (capped to prevent AFK farming) | High |
| Total unique visitors | Reach/discovery | Medium |
| Player-to-player interactions | Proves real multiplayer engagement | Medium |
| Day-over-day retention | The gold standard for games | High |

Raw visit counts alone are gameable. **Retention and session depth are what matter.**

## Anti-Bot Requirements

Payouts based on metrics will attract manipulation. The system needs:

- **Wallet eligibility criteria** — minimum age, prior activity, or verified identity
- **Behavioral analysis** — flag accounts that enter/exit on timers, don't move, or repeat identical paths
- **Public dashboards** — let the creator community scrutinize each other's numbers
- **Anomaly detection** — sudden spikes without corresponding social/marketing activity get flagged for review
- **Penalties** — scenes caught botting lose eligibility for N months

Transparency is the best defense. If metrics are public, the community self-polices.

## Why This Works

- **Aligns incentives** — Foundation wants retention, creators want revenue, players want good content. All three win when engagement is rewarded.
- **Forces transparency** — Foundation must publish real analytics to justify payouts. This data benefits the entire ecosystem (sponsors, land owners, investors).
- **Scales without committees** — 10 scenes or 1,000 scenes, the formula works the same.
- **Rewards what's already working** — no speculative grants for vaporware. Ships first, gets paid after.
- **Creates a competitive marketplace** — creators compete on quality, not grant-writing ability.

## What Foundation Needs to Build

1. **Public scene analytics API + dashboard** — visits, session duration, retention, multiplayer activity
2. **Anti-bot detection layer** — behavioral, not just volume-based
3. **Payout smart contract** — monthly distribution based on formula, verifiable on-chain
4. **Eligibility criteria** — minimum thresholds to qualify (prevents dust payouts to empty scenes)

## Case Study: Flag Tag

- 24/7 multiplayer keep-away game running on Foundation's authoritative server
- Complex economy: coins, upgrades, combat, rounds, leaderboards
- Real retention loops: 5-minute rounds, persistent progression, competitive leaderboard
- 104-file codebase, entity pooling, performance-optimized for mobile
- Studio-quality development — this is what the platform needs more of
- Currently funded by: grants and hope

With an engagement pool, scenes like this get rewarded automatically for doing what they're already doing — keeping players coming back.

## The Ask

1. **Commit to transparent, public scene metrics** — this is the foundation (pun intended) for everything else
2. **Pilot an engagement pool** — even a small monthly allocation proves the model
3. **Publish the formula** — creators need to know what's rewarded so they can optimize for it
4. **Ship it quickly** — creators are making build-or-leave decisions now, not next year

## One-Liner

> Stop paying creators to build. Start paying creators to retain. The metrics will tell you who deserves it — but only if you publish them.
