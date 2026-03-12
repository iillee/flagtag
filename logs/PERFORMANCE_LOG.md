# Performance Optimization Log

This document tracks performance optimizations, bottlenecks identified, and their measured impact. Understanding these optimizations is crucial for maintaining good performance as the game evolves.

## Current Performance Baseline

### Scene Specifications
- **Size:** 150 parcels (160m × 240m)
- **Entity Budget:** ~76,800 entities (512 per parcel)
- **Triangle Budget:** ~1.5M triangles (10k per parcel)
- **Target FPS:** 30fps minimum, 60fps preferred

### Existing Optimizations
- **Object Pooling:** VFX entities reused instead of created/destroyed
- **Frame Time Clamping:** Physics delta time capped at 0.1s to prevent lag exploits
- **Entity Cleanup:** Automatic cleanup of expired VFX entities
- **Bounded Particle Systems:** Limited pool sizes prevent runaway entity creation

## Format
```
## [Date] Optimization Title
**Bottleneck Identified:** What was causing performance issues
**Measurement Before:** FPS, entity count, or other metrics before optimization
**Solution Applied:** Technical details of the optimization
**Measurement After:** Performance improvement achieved
**Files Modified:** Which files were changed
**Side Effects:** Any trade-offs or limitations introduced
```

---

## Existing Optimizations Analysis

### VFX Object Pooling System
**Implementation Date:** Pre-existing (analyzed 2026-03-11)
**Bottleneck Identified:** Combat and flag VFX creating/destroying many entities per second
**Solution Applied:** 
- Trail particles: 15-entity pool with hide/reuse pattern
- Beacon particles: 12-entity pool with position/scale animation
- Hit VFX: 18-entity pool (6 spikes × 3 sets) with geometric arrangements  
- Miss VFX: 6-entity pool with clustered sphere configurations
- Hit sounds: 5-entity pool to prevent audio overlap

**Benefits:**
- Eliminates entity creation garbage collection
- Consistent performance under heavy combat
- Bounded memory usage regardless of player activity

**Files:** `src/systems/flagSystem.ts`, `src/systems/combatSystem.ts`

### Physics Delta Time Clamping
**Implementation Date:** Pre-existing (analyzed 2026-03-11)
**Bottleneck Identified:** Frame rate drops could accelerate physics or create exploits
**Solution Applied:** `Math.min(dt, 0.1)` caps delta time at 100ms
**Benefits:**
- Prevents lag-induced physics acceleration
- Consistent game timing regardless of client performance
- Anti-cheat measure for timing-based exploits

**Files:** `src/server/server.ts`, client systems

### Entity Lifecycle Management
**Implementation Date:** Pre-existing (analyzed 2026-03-11)
**Solution Applied:**
- Automatic cleanup of expired VFX entities
- Hidden position (`Vector3.create(0, -100, 0)`) for unused pool entities
- Tween cleanup on entity reuse to prevent conflicts

**Files:** Combat and flag systems

## Performance Monitoring Guidelines

### Key Metrics to Track
- **Entity Count:** Monitor via browser dev tools or SDK logging
- **FPS:** Target 30fps minimum in crowded scenarios  
- **Memory Usage:** Watch for entity leaks during long sessions
- **Network Messages:** Server message rate under high player load

### Bottleneck Warning Signs
- Frame rate drops below 30fps consistently
- Entity count growing without bound during gameplay
- Long garbage collection pauses
- Delayed VFX appearance (pool exhaustion)
- Audio stuttering or overlap

### Testing Scenarios
- **Stress Test:** Multiple players in heavy combat
- **Endurance Test:** 4+ hour continuous gameplay session
- **Edge Cases:** Player disconnection during animations, server restart recovery

---

## Template for New Entries
```
## [YYYY-MM-DD] Optimization Title
**Bottleneck Identified:** 
**Measurement Before:** 
**Solution Applied:** 
**Measurement After:** 
**Files Modified:**
- `file1.ts` - what was optimized
- `file2.ts` - supporting changes

**Side Effects:** 
**Testing:** How the optimization was verified
**Monitoring:** What metrics to watch for regression
```

*Performance optimizations will be logged here as they are implemented.*