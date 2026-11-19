/**
 * Attribute drift between OUR SDE bundle and the pinned pyfa's staticdata (same rule as
 * tools/diff/drift.go of the Go twin, capsuleers.fitting-engine-go).
 *
 * pyfa's staticdata trails CCP's. A type our bundle has and pyfa doesn't is caught by the oracle
 * (`dropped`); a type BOTH know but describe differently (CCP rebalanced it after the pin) used to come
 * back as an engine diff: SDE 3720952 cut 97955's CPU from 25 to 16 and four fits read exactly -9 CPU.
 *
 * The rule, per type used by a compared fit that the pinned pyfa knows:
 *   - compared: every attribute of OUR bundle's type (the bundle carries exactly what the engine
 *     reads), plus the type-level mass / volume / capacity (pyfa stores them as attributes 4 / 161 / 38);
 *   - drift: pyfa lacks the attribute, or |ours - pyfa| > 1e-6 * max(1, |pyfa|);
 *   - not compared: attributes only pyfa has (its eve.db keeps some our bundle drops, e.g.
 *     cloneGradeRestriction), and 1367 maxSubSystems, which pyfa's db_update.py forces from 5 to 4 on
 *     purpose (not staticdata drift; not a compared stat).
 *
 * A fit using a drifted type is skipped and reported as oracle SDE drift, like an absent type.
 */

const ATTR_MAX_SUBSYSTEMS = 1367

/** Every typeID a spec uses, in first-seen order. */
export function specTypes(spec) {
    const out = []
    const add = (id) => { if (id && !out.includes(id)) out.push(id) }
    add(spec.shipTypeID)
    for (const s of spec.subsystems ?? []) add(s.typeID)
    add(spec.modeTypeID)
    for (const m of spec.modules ?? []) { add(m.typeID); add(m.chargeTypeID) }
    for (const d of spec.drones ?? []) add(d.typeID)
    for (const f of spec.fighters ?? []) add(f.typeID)
    for (const im of spec.implants ?? []) add(im.typeID)
    for (const b of spec.boosters ?? []) add(b.typeID)
    return out
}

const differs = (ours, pyfa) => Math.abs(ours - pyfa) > 1e-6 * Math.max(1, Math.abs(pyfa))

/**
 * The attributes of one type that differ from the pinned pyfa: [{ attr, name, ours, pyfa }] (pyfa null
 * when it lacks the attribute). Empty when none, or when pyfa doesn't know the type (`py` undefined):
 * that case is the oracle's `dropped`.
 */
export function typeAttrDrift(dataset, type, py) {
    if (!py) return []
    const name = (id) => dataset.attributes.get(id)?.name || String(id)
    const out = []
    const check = (id, label, ours) => {
        const pv = py[String(id)]
        if (pv === undefined) out.push({ attr: id, name: label, ours, pyfa: null })
        else if (differs(ours, pv)) out.push({ attr: id, name: label, ours, pyfa: pv })
    }
    const own = new Set()
    for (const a of type.attributes ?? []) {
        own.add(a.id)
        if (a.id === ATTR_MAX_SUBSYSTEMS) continue
        check(a.id, name(a.id), a.v)
    }
    for (const [id, label, v] of [[4, 'mass', type.mass], [161, 'volume', type.volume], [38, 'capacity', type.capacity]]) {
        if (v != null && !own.has(id)) check(id, label, v)
    }
    return out
}

export const fmtNum = (v) => (v == null ? '—' : String(v))
