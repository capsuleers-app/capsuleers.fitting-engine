/**
 * Known, accepted differences between eve-fit-engine and pyfa-org/Pyfa.
 *
 * AUTO-MANAGED by scripts/recalibrate-pyfa-pin.mjs — but the REASONS are
 * human-owned. This is the standard differential-testing escape hatch: a
 * reference implementation (pyfa) carries floating-point / modelling / per-ship
 * quirks an independent engine can't match without degrading its own
 * correctness (regressing the 662-fixture parity suite) or replicating a
 * pyfa-specific anomaly. Each entry is annotated with its ROOT CAUSE — it is NOT
 * a place to hide real bugs.
 *
 * Calibrated against pyfa commit: b79cd902b0bfa56a43cc5c08b6266fa842f25e85
 * (kept in lock-step with PYFA_REF in .github/workflows/diff-parity.yml.)
 *
 * Matching is by (ship, fitType, statKey). A matched diff is ACCEPTED and does
 * not fail the run; ANY unlisted diff fails `npm run diff` (exit 1). Entries
 * marked "PENDING REVIEW" were added by the recalibration script at a pin bump
 * and MUST be classified (and their reason replaced) before release.
 *
 * Invariant: never regress `npm run test:pyfa` (662/0) to satisfy this harness.
 */

/** @typedef {{ ship: string, fitType: string, key: string, reason: string }} KnownDiff */

/** @type {KnownDiff[]} */
export const KNOWN_DIFFS = [

]

const _key = (d) => `${d.ship}|${d.fitType}|${d.key}`
const _set = new Set(KNOWN_DIFFS.map(_key))
const _reason = new Map(KNOWN_DIFFS.map(d => [_key(d), d.reason]))

/** True if this diff is a documented, accepted difference. */
export function isKnownDiff(d) { return _set.has(_key(d)) }

/** The documented root cause for an accepted diff (or undefined). */
export function knownDiffReason(d) { return _reason.get(_key(d)) }
