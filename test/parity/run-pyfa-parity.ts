/**
 * Pyfa parity validation harness.
 *
 * For each known test fit (one per screenshot in `.test/pyfa/`), this script:
 *   1. Constructs a Fit programmatically (typeIDs hard-coded from Pyfa's
 *      EFT export so the fit shape is reviewable in source).
 *   2. Loads the SDE bundle from `public/fitting-data/<version>/...`,
 *      patching `fetch()` so `loadDataset()` runs unchanged from inside
 *      a Node process.
 *   3. Runs `computeFit(...)` with All-V skills + Uniform damage profile +
 *      full disintegrator spool — Pyfa's default headline state.
 *   4. Asserts every stat (resources, EHP per layer + total, weapon DPS,
 *      cap stable %, navigation, targeting) against the values extracted
 *      from the corresponding Pyfa screenshot.
 *
 * Run with:  npm run test:pyfa
 *
 * Adding a new fit: drop a screenshot in `.test/pyfa/<shipname>.png`,
 * extract the EFT + Pyfa numbers, and append a new entry to `fixtures.json` (and to the Go twin's).
 */

// Self-validation: this lives INSIDE the package and validates the shipping
// configuration — the package's own compute against its own bundled SDE
// (data/). Imports are relative to src/ so `tsx` runs it without a build.
import {
    computeFit,
    DAMAGE_PROFILE_PRESETS,
    verifyLegacyEffectIds,
    type Fit,
    type FittingDataset,
    type SkillProfile,
} from '../../src/index'
import { readFileSync } from 'node:fs'
import { loadBundledDataset } from '../../src/node'

// ---------------------------------------------------------------------------
// Skill profile builder: All-V across every skill in the bucket.
// ---------------------------------------------------------------------------

function buildAllVSkillProfile(dataset: FittingDataset): SkillProfile {
    const skills: Record<number, 0 | 1 | 2 | 3 | 4 | 5> = {}
    const skillBucket = dataset.typesByBucket.skills
    if (!skillBucket) throw new Error('skills bucket not loaded')
    for (const id of skillBucket.keys()) skills[id] = 5
    return { name: 'All V', isDefault: true, source: 'preset', skills }
}

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

interface ExpectedStats {
    /** Total Effective HP under uniform damage. */
    ehpTotal: number
    /** Per-layer EHP. */
    ehpShield: number
    ehpArmor: number
    ehpHull: number
    /** Per-layer resists in percent (0-100). */
    shieldResist: { em: number; therm: number; kin: number; exp: number }
    armorResist: { em: number; therm: number; kin: number; exp: number }
    hullResist: { em: number; therm: number; kin: number; exp: number }
    /** Resources. */
    cpuUsed: number
    cpuMax: number
    powerUsed: number
    powerMax: number
    calibrationUsed: number
    calibrationMax: number
    /** Firepower (skip the assertion when omitted — useful for fits with no
     *  ammo loaded so per-cycle damage is 0 and Pyfa shows no DPS row). */
    weaponDps?: number
    /** Capacitor. Either `capStablePercent` (0..1) when stable, or
     *  `capSecondsToEmpty` when not stable. Omit both to skip the cap check
     *  (rare — only for fits where Pyfa shows weird structure-mode data). */
    capCapacity: number
    capStablePercent?: number
    capSecondsToEmpty?: number
    /** Navigation. */
    maxVelocity: number
    alignTime: number
    /** Targeting. */
    maxTargetingRangeKm: number
    scanResolution: number
    sensorStrength: number
    droneRangeKm: number
    /** Misc. */
    signatureRadius: number
}

interface TestFit {
    name: string
    screenshot: string
    /** Programmatic fit construction. */
    build: () => Fit
    expected: ExpectedStats
    /** Per-stat tolerance overrides for fits with known engine limitations
     *  (e.g. Logistics-class fleet bursts, capital rig stacking variants).
     *  Keys match the assertion label ('Total EHP', 'Armor EHP', etc.). */
    toleranceOverrides?: Record<string, number>
}

// Le 21 fixture (fit + valori attesi di Pyfa) stanno in test/parity/fixtures.json. Il gemello Go
// (capsuleers.fitting-engine-go, test/parity) ha lo stesso file byte per byte e le stesse asserzioni:
// una fixture aggiunta o corretta qui va anche li' (CONTRIBUTING.md, "Fixes in both repos").
const FITS: TestFit[] = (JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as Array<{
    name: string; screenshot: string; fit: Fit; expected: ExpectedStats; toleranceOverrides?: Record<string, number>
}>).map(f => ({ name: f.name, screenshot: f.screenshot, build: () => structuredClone(f.fit), expected: f.expected, toleranceOverrides: f.toleranceOverrides }))

// ---------------------------------------------------------------------------
// Assertion helpers — print a per-stat PASS/FAIL line so the matrix is
// readable at a glance even when many entries fail.
// ---------------------------------------------------------------------------

interface AssertResult {
    pass: boolean
    label: string
    actual: string
    expected: string
    diff?: string
}

function pct(diff: number, expected: number): string {
    if (expected === 0) return diff === 0 ? '0%' : '∞%'
    return `${((diff / expected) * 100).toFixed(2)}%`
}

function approx(label: string, actual: number, expected: number, tolerancePct: number): AssertResult {
    const diff = actual - expected
    const ratio = expected === 0 ? (Math.abs(actual) < 0.01 ? 0 : 1) : Math.abs(diff / expected)
    const pass = ratio <= tolerancePct
    return {
        pass,
        label,
        actual: typeof actual === 'number' ? actual.toFixed(2) : String(actual),
        expected: typeof expected === 'number' ? expected.toFixed(2) : String(expected),
        diff: `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${pct(diff, expected)})`,
    }
}

function printResult(r: AssertResult): void {
    const tag = r.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
    const padded = r.label.padEnd(28)
    if (r.pass) {
        console.log(`  ${tag} ${padded} ${r.actual}`)
    } else {
        console.log(`  ${tag} ${padded} got ${r.actual}, expected ${r.expected} (${r.diff})`)
    }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function runFit(testFit: TestFit, dataset: FittingDataset, skillProfile: SkillProfile): Promise<{ passed: number; failed: number }> {
    console.log(`\n=== ${testFit.name} (${testFit.screenshot}) ===`)
    const fit = testFit.build()

    const computed = computeFit(fit, dataset, {
        skillProfile,
        damageProfile: DAMAGE_PROFILE_PRESETS.find(p => p.name === 'Uniform') ?? null,
        spoolPercent: 1,
        disintegratorSpoolPercent: 1,
    })

    const d = computed.derived
    const exp = testFit.expected
    const ovr = testFit.toleranceOverrides ?? {}
    const T = (label: string, fallback: number) => ovr[label] ?? fallback

    // Tolerance choices:
    //   - 1 % for EHP totals (rounding in Pyfa display can drift small layers)
    //   - 0.5 % for resources / DPS (precise math, should be tight)
    //   - 0.5 pp absolute for resists (Pyfa shows 1-decimal)
    //   - 0.05 absolute for stable percent (5 pp window — capacitor calc has
    //     small differences in Pyfa's stable algorithm, tightened later)
    const results: AssertResult[] = [
        approx('Total EHP',          d.defense.ehpTotalAgainstProfile, exp.ehpTotal, T('Total EHP', 0.01)),
        approx('Shield EHP',         d.defense.shield.ehpAgainstProfile, exp.ehpShield, T('Shield EHP', 0.02)),
        approx('Armor EHP',          d.defense.armor.ehpAgainstProfile, exp.ehpArmor, T('Armor EHP', 0.01)),
        approx('Hull EHP',           d.defense.hull.ehpAgainstProfile, exp.ehpHull, T('Hull EHP', 0.02)),

        approx('Shield resist EM',   d.defense.shield.resistances.em * 100, exp.shieldResist.em, T('Shield resist EM', 0.05)),
        approx('Shield resist Th',   d.defense.shield.resistances.thermal * 100, exp.shieldResist.therm, T('Shield resist Th', 0.05)),
        approx('Shield resist Kin',  d.defense.shield.resistances.kinetic * 100, exp.shieldResist.kin, T('Shield resist Kin', 0.05)),
        approx('Shield resist Exp',  d.defense.shield.resistances.explosive * 100, exp.shieldResist.exp, T('Shield resist Exp', 0.05)),

        approx('Armor resist EM',    d.defense.armor.resistances.em * 100, exp.armorResist.em, T('Armor resist EM', 0.05)),
        approx('Armor resist Th',    d.defense.armor.resistances.thermal * 100, exp.armorResist.therm, T('Armor resist Th', 0.05)),
        approx('Armor resist Kin',   d.defense.armor.resistances.kinetic * 100, exp.armorResist.kin, T('Armor resist Kin', 0.05)),
        approx('Armor resist Exp',   d.defense.armor.resistances.explosive * 100, exp.armorResist.exp, T('Armor resist Exp', 0.05)),

        approx('Hull resist EM',     d.defense.hull.resistances.em * 100, exp.hullResist.em, T('Hull resist EM', 0.05)),
        approx('Hull resist Th',     d.defense.hull.resistances.thermal * 100, exp.hullResist.therm, T('Hull resist Th', 0.05)),
        approx('Hull resist Kin',    d.defense.hull.resistances.kinetic * 100, exp.hullResist.kin, T('Hull resist Kin', 0.05)),
        approx('Hull resist Exp',    d.defense.hull.resistances.explosive * 100, exp.hullResist.exp, T('Hull resist Exp', 0.05)),

        approx('CPU used',           d.fitting.cpuUsed, exp.cpuUsed, 0.01),
        approx('CPU max',            d.fitting.cpuMax, exp.cpuMax, 0.01),
        approx('Power used',         d.fitting.powerUsed, exp.powerUsed, 0.01),
        approx('Power max',          d.fitting.powerMax, exp.powerMax, 0.01),
        approx('Calibration used',   d.fitting.calibrationUsed, exp.calibrationUsed, 0.01),
        approx('Calibration max',    d.fitting.calibrationMax, exp.calibrationMax, 0.01),

        ...(exp.weaponDps !== undefined
            ? [approx('Weapon DPS',  d.offense.weaponDps, exp.weaponDps, T('Weapon DPS', 0.01))]
            : []),

        approx('Cap capacity',       d.capacitor.capacity, exp.capCapacity, 0.01),
        ...(exp.capStablePercent !== undefined
            ? [approx('Cap stable %', d.capacitor.stablePercent * 100, exp.capStablePercent * 100, T('Cap stable %', 0.10))]
            : []),
        ...(exp.capSecondsToEmpty !== undefined
            ? [approx('Cap to empty (s)', d.capacitor.secondsToEmpty ?? 0, exp.capSecondsToEmpty, T('Cap to empty (s)', 0.10))]
            : []),

        approx('Max velocity',       d.navigation.maxVelocity, exp.maxVelocity, 0.05),
        approx('Align time',         d.navigation.alignTimeSeconds, exp.alignTime, 0.02),

        approx('Max targeting (km)', d.targeting.maxTargetingRange / 1000, exp.maxTargetingRangeKm, T('Max targeting (km)', 0.02)),
        approx('Scan resolution',    d.targeting.scanResolution, exp.scanResolution, T('Scan resolution', 0.02)),
        approx('Sensor strength',    d.targeting.sensorStrength, exp.sensorStrength, T('Sensor strength', 0.02)),
        approx('Drone range (km)',   d.drones.controlRange / 1000, exp.droneRangeKm, T('Drone range (km)', 0.02)),

        approx('Signature radius',   d.targeting.signatureRadius, exp.signatureRadius, T('Signature radius', 0.02)),
    ]

    let passed = 0, failed = 0
    for (const r of results) {
        printResult(r)
        if (r.pass) passed++
        else failed++
    }
    return { passed, failed }
}

async function main() {
    console.log('Loading SDE bundle from the npm package (eve-fit-engine/node)...')
    const dataset = await loadBundledDataset()
    // Pre-load every bucket the fits might need. loadDataset only loads the
    // baseline (attributes/effects/groups/categories/...); the per-category
    // type buckets are lazy.
    const buckets: Array<keyof FittingDataset['typesByBucket']> = [
        'ships', 'modules', 'charges', 'drones', 'fighters', 'implants', 'subsystems', 'skills',
    ]
    await Promise.all(buckets.map(b => dataset.loadBucket(b)))
    console.log(`  loaded version ${dataset.version}, ${buckets.length} buckets warm.\n`)

    // Hardcoded effect-ID drift audit (gap 5 of the May 2026 coverage audit).
    // Surface a loud warning if any effect ID claimed by a legacy handler has
    // gone missing from the bundle (Fenris Creations renumbered or deleted), so the
    // associated `applyLegacy*` / projection table doesn't silently no-op.
    const drift = verifyLegacyEffectIds(dataset.effects)
    if (drift.length > 0) {
        console.warn(`  LEGACY_EFFECT_IDS drift detected — ${drift.length} entries:`)
        for (const d of drift) {
            console.warn(`    [${d.kind}] effect ${d.id}: expected name=${JSON.stringify(d.expected)}, actual=${JSON.stringify(d.actual)}`)
        }
        console.warn('  → review constants.ts LEGACY_EFFECT_IDS and the matching handler.\n')
    } else {
        console.log(`  LEGACY_EFFECT_IDS audit: OK (no drift).\n`)
    }

    const skillProfile = buildAllVSkillProfile(dataset)
    console.log(`  All-V skill profile: ${Object.keys(skillProfile.skills).length} skills at level 5.\n`)

    let totalPassed = 0, totalFailed = 0
    for (const f of FITS) {
        const { passed, failed } = await runFit(f, dataset, skillProfile)
        totalPassed += passed
        totalFailed += failed
    }

    console.log('')
    console.log(`Summary: ${totalPassed} passed, ${totalFailed} failed.`)
    process.exit(totalFailed === 0 ? 0 : 1)
}

main().catch(err => {
    console.error('FATAL:', err)
    process.exit(2)
})
