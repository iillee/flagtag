# Gameplay Balance Log

This document tracks game balance changes, playtesting feedback, and the reasoning behind gameplay parameter adjustments. These decisions directly affect player experience and competitive fairness.

## Current Balance Parameters

### Core Game Timing
- **Round Length:** 10 minutes (600 seconds)
- **Round Alignment:** UTC 10-minute boundaries (00:00, 00:10, 00:20, etc.)
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

*Balance changes will be logged here as adjustments are made based on playtesting and feedback.*

---

## Known Balance Considerations

### Potential Areas for Tuning
- **Spawn camping:** Flag base position may need adjustment if spawn camping becomes problematic
- **Attack range vs movement:** Current 2.5m range may need adjustment based on player movement speed
- **Round length:** 10 minutes may be too long/short depending on player engagement patterns
- **Stagger duration:** 1.5s freeze may be too punishing for casual players
- **Flag visibility:** Particle effects may need adjustment for different lighting conditions

### Player Feedback Collection
- In-game chat monitoring for balance complaints
- Discord/community feedback on specific mechanics
- Win rate distribution analysis
- Player session length tracking
- Combat engagement frequency measurement