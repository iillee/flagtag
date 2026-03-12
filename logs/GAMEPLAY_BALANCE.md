# Gameplay Balance Log

This document tracks game balance changes, playtesting feedback, and the reasoning behind gameplay parameter adjustments. These decisions directly affect player experience and competitive fairness.

## Current Balance Parameters

### Core Game Timing
- **Round Length:** 5 minutes (300 seconds)
- **Round Alignment:** UTC 5-minute boundaries (00:00, 00:05, 00:10, 00:15, etc.)
- **Justification:** Long enough for meaningful competition, short enough to prevent fatigue

### Flag Mechanics
- **Base Position:** (54, 12, 122) - Central elevated platform
- **Carry Offset:** (0, 1.9, -0.6) - Above and behind player
- **Pickup Radius:** 3 meters
- **Drop Distance:** 1.4 meters behind player
- **Follow Speed:** 8 units/second (smooth but responsive)

### Combat System
- **Attack Range:** 2.5 meters
- **Attack Cooldown:** 450ms (prevents spam, allows counterplay)
- **Hit Stagger:** 1.5 seconds movement freeze + emote
- **Stagger Delay:** 100ms (allows hit registration before freeze)

### Physics Parameters
- **Flag Gravity:** 15 m/s² (faster than real gravity for snappy feel)
- **Minimum Y:** 0.5 meters (prevents underground clipping)
- **Carrier Y Window:** 2.0 seconds (ground level estimation)

### Audio/Visual Balance
- **Background Music Volume:** 0.175 (ambient, not distracting)
- **Trail Spawn Rate:** 12.5 particles/second (visible but not overwhelming)
- **Beacon Spawn Rate:** 2.86 particles/second (gentle idle indication)
- **VFX Duration:** 250ms (clear feedback without screen clutter)

## Format
```
## [Date] Balance Change Title
**Parameter Changed:** What value was adjusted
**Old Value → New Value:** Before and after comparison
**Justification:** Why the change was needed
**Player Feedback:** What players reported (if applicable)
**Testing Results:** How the change performed in practice
**Side Effects:** Unintended consequences or interactions
```

---

## Design Philosophy

### Core Principles
1. **Skill Over Luck:** Player ability should determine outcomes
2. **Clear Feedback:** Players should understand what's happening
3. **Fair Competition:** No hidden advantages or exploits
4. **Engaging Flow:** Constant tension without frustration
5. **Accessibility:** Easy to learn, difficult to master

### Balance Considerations
- **Flag Positioning:** Base location affects spawn camping vs central control
- **Combat Timing:** Too fast = spam, too slow = unresponsive
- **Round Length:** Too short = no strategy, too long = fatigue
- **Attack Range:** Too far = unfair, too close = ineffective
- **Stagger Duration:** Too long = frustrating, too short = no impact

## Playtesting Framework

### Key Questions to Evaluate
- Are rounds ending with clear winners or frequent ties?
- Do players feel they have agency over the outcome?
- Is the flag position easy to find and reach?
- Are combat encounters satisfying for both players?
- Does the game maintain engagement throughout the round?

### Metrics to Track
- **Average hold times:** Are they distributed fairly?
- **Win margins:** Close games are more exciting than blowouts  
- **Player retention:** Do people stay for multiple rounds?
- **Combat frequency:** Is fighting common enough to be strategic?
- **Flag uptime:** How much time is the flag being actively held?

---

## Template for New Entries
```
## [YYYY-MM-DD] Balance Change Title  
**Parameter Changed:** 
**Old Value → New Value:** 
**Justification:** 
**Player Feedback:** 
**Testing Results:** 
**Files Modified:**
- `file1.ts` - what constants were changed
- `file2.ts` - related adjustments

**Metrics Impact:** 
**Side Effects:** 
**Future Monitoring:** What to watch for
```

## [2026-03-12 01:05] Flag Stealing Mechanic Implementation
**Parameter Changed:** Combat flag interaction behavior
**Old Behavior:** Flag drops to ground when carrier is hit (anyone can pick up)
**New Behavior:** Flag immediately transfers to the attacker (direct steal)

**Justification:** 
- Creates more dynamic, fast-paced gameplay
- Rewards successful attacks with immediate possession
- Eliminates camping around dropped flags
- Maintains game momentum through continuous flag possession

**Player Impact Analysis:**
- **Attackers:** Immediately rewarded for successful hits (no pickup delay)  
- **Defenders:** Higher stakes for being hit while carrying flag
- **Spectators:** More exciting to watch direct flag exchanges
- **Game Flow:** Faster transitions, less downtime between possession changes

**Potential Balance Considerations:**
- **Attack Range:** Current 2.5m may need adjustment if stealing feels too easy/hard
- **Stagger Duration:** 1.5s stagger still applies to victim but attacker gets flag immediately  
- **Cooldown Impact:** 450ms attack cooldown prevents rapid steal attempts
- **Positioning Strategy:** Changes optimal flag carrier positioning and movement patterns

**Metrics to Monitor:**
- **Steal Success Rate:** How often attacks result in flag transfers
- **Average Possession Time:** Whether steals make possession periods shorter
- **Player Engagement:** If direct stealing increases active pursuit behavior
- **Balance Feedback:** Whether mechanism favors attackers too heavily

**Future Tuning Options:**
- Adjust attack range if stealing too easy/difficult
- Modify stagger duration to balance victim disadvantage  
- Consider steal immunity period if rapid re-stealing becomes problematic
- Monitor for potential spawn camping near flag base

**Expected Outcome:** More aggressive, confrontational gameplay with continuous flag movement and direct player-to-player competition.

---

## [2026-03-12 01:30] Round Duration Reduction  
**Parameter Changed:** Round length timing
**Old Value → New Value:** 10 minutes (600 seconds) → 5 minutes (300 seconds)
**Justification:** User feedback requesting faster-paced gameplay with shorter rounds for more dynamic competition and better sustained player engagement.

**Expected Impact Analysis:**
- **Player Engagement:** 5 minutes better matches typical attention spans for competitive gameplay
- **Win Opportunities:** Doubled frequency of round conclusions = more chances for victory
- **Strategy Changes:** Shorter rounds may favor aggressive play over defensive positioning  
- **Urgency Factor:** Increased time pressure should create more intense flag contests

**Potential Balance Considerations:**
- **Hold Time Accumulation:** Easier to build significant lead in shorter timeframe
- **Comeback Potential:** Less time to recover from early disadvantage
- **Combat Frequency:** May increase aggression due to time pressure
- **Flag Positioning:** Strategic positioning becomes more time-critical

**Metrics to Monitor:**
- **Average Hold Times:** Whether 5-minute rounds change typical possession patterns
- **Win Margins:** If shorter rounds create closer or more decisive outcomes
- **Player Retention:** Whether 5-minute cycles maintain engagement better
- **Combat Activity:** Frequency of flag steals and attacks under time pressure

**Future Tuning Considerations:**
- Monitor for rounds ending without meaningful competition (too short)
- Watch for fatigue from rapid round cycling (too frequent)
- Consider if attack/defense balance changes with time pressure
- Evaluate if 5 minutes allows sufficient strategy development

**UTC Alignment Maintained:** Rounds still align to UTC boundaries for consistent global timing regardless of server presence.

---

*Additional balance changes will be logged here as adjustments are made based on playtesting and feedback.*

---

## Known Balance Considerations

### Potential Areas for Tuning
- **Spawn camping:** Flag base position may need adjustment if spawn camping becomes problematic
- **Attack range vs movement:** Current 2.5m range may need adjustment based on player movement speed
- **Round length:** 5 minutes may be too long/short depending on player engagement patterns
- **Stagger duration:** 1.5s freeze may be too punishing for casual players
- **Flag visibility:** Particle effects may need adjustment for different lighting conditions

### Player Feedback Collection
- In-game chat monitoring for balance complaints
- Discord/community feedback on specific mechanics
- Win rate distribution analysis
- Player session length tracking
- Combat engagement frequency measurement