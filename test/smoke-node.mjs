/**
 * Batteries-included smoke: prove `eve-fit-engine/node` computes
 * from an EFT string with ZERO setup (bundled SDE, default All-V skills).
 */
import { computeFromEft, loadBundledDataset, buildAllVSkillProfile } from '../dist/node.js'
import { computeFit } from '../dist/index.js'

const EFT = `[Rifter, Smoke Test]

200mm AutoCannon II, Republic Fleet EMP S
200mm AutoCannon II, Republic Fleet EMP S
200mm AutoCannon II, Republic Fleet EMP S

1MN Afterburner II
Small Shield Extender II

Gyrostabilizer II
Gyrostabilizer II
`

let fails = 0
const check = (label, ok, val) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} ${val}`); if (!ok) fails++ }

const { fit, warnings, computed } = await computeFromEft(EFT)
const d = computed.derived

check('parsed ship = Rifter (587)', fit.shipTypeID === 587, fit.shipTypeID)
check('module lines parsed', fit.modules.length >= 5, `${fit.modules.length} modules`)
check('EHP > 0', d.defense.ehpTotalAgainstProfile > 0, Math.round(d.defense.ehpTotalAgainstProfile))
check('capacitor > 0', d.capacitor.capacity > 0, Math.round(d.capacitor.capacity))
check('velocity > 0 (AB fitted)', d.navigation.maxVelocity > 0, d.navigation.maxVelocity.toFixed(1))
check('weapon DPS > 0 (ammo loaded)', d.offense.totalDps > 0, d.offense.totalDps.toFixed(1))
if (warnings.length) console.log(`   (parse warnings: ${warnings.length} — ${warnings.map(w => w.text).join('; ')})`)

// SDE 3693310 / pyfa b79cd90 regressions. Every expected number below is the
// pyfa oracle's at that pin (`.pyfa`, All-V) for the same fit — not ours.
{
    const ds = await loadBundledDataset()
    const allV = buildAllVSkillProfile(ds)
    const idOf = (name) => { for (const b of Object.values(ds.typesByBucket)) for (const t of b.values()) if (t.name === name) return t.id; throw new Error(`no type ${name}`) }
    const run = (ship, mods, implants = []) => computeFit({
        shipTypeID: idOf(ship), name: 'smoke', visibility: 'PRIVATE', tags: [],
        modules: mods.map(([n, state, charge], i) => ({ id: `m${i}`, slotType: 'LO', position: i, typeID: idOf(n), state, chargeTypeID: charge ? idOf(charge) : undefined })),
        drones: [], fighters: [], cargo: [], boosters: [], subsystems: [],
        implants: implants.map((n, i) => ({ id: `i${i}`, typeID: idOf(n), slot: i + 1 })),
    }, ds, { skillProfile: allV }).derived
    const near = (a, b) => Math.abs(a - b) < 0.01

    // Rig Synchronizer: the faction-module set count must not depend on module
    // order, and an OFFLINE set module still counts (pyfa `type = 'offline'`).
    const guns = [['720mm Howitzer Artillery II', 'ACTIVE', 'Republic Fleet EMP M'], ['720mm Howitzer Artillery II', 'ACTIVE', 'Republic Fleet EMP M']]
    const sync = ['Medium Republic Fleet Synchronizer', 'ONLINE']
    const setMods = [['Republic Fleet Gyrostabilizer', 'OFFLINE'], ['Republic Fleet 10MN Afterburner', 'ACTIVE']]
    for (const [label, mods] of [['synchronizer listed first', [sync, ...setMods, ...guns]], ['synchronizer listed last', [...setMods, ...guns, sync]]]) {
        const r = run('Stabber', mods)
        check(`Stabber DPS, ${label}`, near(r.offense.totalDps, 110.326), r.offense.totalDps.toFixed(3))
        check(`Stabber velocity, ${label}`, near(r.navigation.maxVelocity, 1030.884), r.navigation.maxVelocity.toFixed(3))
    }
    // An implant that trims a rig's drawback must land before the rig applies it.
    const vx = run('Vexor', [['Medium Federation Navy Synchronizer', 'ONLINE']], ["Vigilant Tyrannos 'Xyston' Synchronization Rigging SY-1020"])
    check('Vexor CPU, SY-1020 rigging implant', near(vx.fitting.cpuMax, 360), vx.fitting.cpuMax)
    // Herald / Penitence (pyfa's pre-release custom effects are now CCP dogma).
    const pen = run('Penitence', [])
    check('Penitence drone control range', near(pen.drones.controlRange / 1000, 97.5), pen.drones.controlRange / 1000)
    const her = run('Herald', [['Small Focused Pulse Laser II', 'ACTIVE', 'Imperial Navy Multifrequency S']])
    check('Herald DPS', near(her.offense.totalDps, 124.693), her.offense.totalDps.toFixed(3))
}

console.log(`\nBatteries-included smoke: ${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
