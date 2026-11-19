/**
 * Autonomous EVE SDE acquisition for eve-fit-engine.
 *
 * Downloads the tables the bundle needs from CCP's SDE API
 * (https://sde.evetech.net/tranquility/latest/) and stages them into
 * `.sde-src/` (gitignored, ephemeral) for `build-bundle.ts` to consume.
 *
 * The API record shape differs from the legacy zip (`<table>ID` key instead of
 * `_key`, named fields on "_value" tables and nested lists). Each row is converted
 * back to the legacy zip shape at the download boundary so `build-bundle.ts` is
 * unchanged. Rules mirror docs/claude/sde-legacy-converter.py (verified identical
 * to the zip of the same build).
 *
 *   1. one GET of the index (release, buildNumber, tables[*].jsonl.url, pinned to the release)
 *   2. download only the needed tables (gzip, retry + backoff + timeout), validate each
 *      (non-empty, no `{"error":...}` rows), convert to the legacy shape
 *   3. write .sde-src/.build (buildNumber, kept for compatibility with data/.build)
 *      and .sde-src/.release (release id: buildNumber is not unique across releases)
 *
 * No "skip if unchanged" shortcut: the workflow detects a dataset change with
 * `git diff -- data`, and a new release can reuse the same buildNumber.
 *
 *   node scripts/fetch-sde.mjs
 *
 * Exit: 0 ok, 1 error.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SDE_SRC = path.join(ROOT, '.sde-src')
const INDEX_URL = 'https://sde.evetech.net/tranquility/latest/'

// Keep in sync with SOURCE_FILES in build-bundle.ts.
const TABLES = [
    'types', 'typeDogma', 'dogmaAttributes', 'dogmaEffects', 'dogmaUnits', 'categories',
    'groups', 'metaGroups', 'marketGroups', 'cloneGrades', 'dbuffCollections', 'dynamicItemAttributes',
]

const ATTEMPTS = 5
const TIMEOUT_MS = 120_000

async function getBuffer(url) {
    let lastErr
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'Accept-Encoding': 'gzip' },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            let buf = Buffer.from(await res.arrayBuffer())
            if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf)
            return buf
        } catch (err) {
            lastErr = err
            if (attempt < ATTEMPTS) {
                const wait = 2000 * 2 ** (attempt - 1)
                console.warn(`[fetch-sde] ${url} attempt ${attempt} failed (${err.message}); retry in ${wait / 1000}s`)
                await new Promise((r) => setTimeout(r, wait))
            }
        }
    }
    throw new Error(`${url}: ${lastErr?.message}`)
}

// ── API -> legacy zip conversion (see docs/claude/sde-legacy-converter.py) ──
const VALUE_TABLES = {
    freelanceJobSchemas: 'schemas', masteries: 'levels', skinrComponentPointValues: 'rarities',
    skinrSlotsToMaterials: 'slots', skinrTierThresholds: 'tiers',
}
// path (list fields, dot-separated, '_value' = unwrapped value list) -> rule
const NESTED = {
    appliedProximityEffects: { dbuffs: 'kv' }, linkWithShip: { dbuffs: 'kv' }, proximityTrap: { dbuffs: 'kv' },
    systemDbuffEmitters: { dbuffs: 'kv' }, systemWideEffects: { dbuffs: 'kv' },
    certificates: { skillTypes: 'k' }, contrabandTypes: { factions: 'k' }, epicArcs: { missions: 'k' },
    dynamicItemAttributes: { attributeIDs: 'k' }, planetSchematics: { types: 'k' }, typeBonus: { types: 'kv' },
    freelanceJobSchemas: { _value: 'k', '_value.parameters': 'k' },
    masteries: { _value: 'kv' }, skinrComponentPointValues: { _value: 'kv' }, skinrTierThresholds: { _value: 'kv' },
    missions: { messages: 'msg', extraStandings: 'kv' },
    npcCorporations: { corporationTrades: 'kv', divisions: 'k', investors: 'kv', exchangeRates: 'kv' },
    races: { skills: 'kv' }, shipTreeFactions: { elements: 'kv' },
    shipTreeGroups: { elements: 'kv', preReqSkills: 'k', 'preReqSkills.skills': 'k' },
    stationOperations: { stationTypes: 'kv' }, stationStandingsRestrictions: { services: 'kv' },
    typeElements: { elements: 'kv' },
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

function applyRule(rule, it) {
    if (!isObj(it) || Object.keys(it).length === 0) return it
    const ks = Object.keys(it)
    if (rule === 'kv' && ks.length === 2) return { _key: it[ks[0]], _value: it[ks[1]] }
    if (rule === 'msg') return { _key: it.kind ?? null, ...(it.text || {}) }
    const d = { _key: it[ks[0]] }
    for (const k of ks.slice(1)) d[k] = it[k]
    return d
}

function walk(obj, parts, rule) {
    if (!isObj(obj) || !Array.isArray(obj[parts[0]])) return
    const lst = obj[parts[0]]
    if (parts.length === 1) obj[parts[0]] = lst.map((x) => applyRule(rule, x))
    else for (const x of lst) walk(x, parts.slice(1), rule)
}

export function convert(table, row) {
    const entries = Object.entries(row)
    const out = { _key: entries[0][1] }
    if (table in VALUE_TABLES) out._value = row[VALUE_TABLES[table]] ?? null
    else for (const [k, v] of entries.slice(1)) out[k] = v
    // deepest paths first so parents still have the original key names
    const paths = Object.entries(NESTED[table] ?? {}).sort((a, b) => b[0].split('.').length - a[0].split('.').length)
    for (const [p, rule] of paths) walk(out, p.split('.'), rule)
    return out
}

// Serialize like the legacy zip (sorted keys, ", " / ": " separators, raw non-ASCII):
// downstream object-key iteration order and the staged bytes match the zip path. The API
// loses the int/float distinction (3386.0 -> 3386), which no serializer can restore;
// JSON.parse in build-bundle makes that irrelevant.
function ser(v) {
    if (Array.isArray(v)) return '[' + v.map(ser).join(', ') + ']'
    if (isObj(v)) {
        return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ': ' + ser(v[k])).join(', ') + '}'
    }
    return JSON.stringify(v)
}

function convertTable(table, buf) {
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim())
    if (lines.length === 0) throw new Error(`${table}: empty file`)
    const out = []
    for (const [i, line] of lines.entries()) {
        let row
        try { row = JSON.parse(line) } catch { throw new Error(`${table}: line ${i + 1} is not valid JSON`) }
        if (!isObj(row) || Object.keys(row).length === 0) throw new Error(`${table}: line ${i + 1} is not an object`)
        if ('error' in row && Object.keys(row).length === 1) throw new Error(`${table}: error row ${line.slice(0, 200)}`)
        out.push(ser(convert(table, row)))
    }
    return out.join('\n') + '\n'
}

async function main() {
    const index = JSON.parse((await getBuffer(INDEX_URL)).toString('utf8'))
    const build = String(index.buildNumber ?? '')
    const release = String(index.release ?? '')
    if (!build || !release || !index.tables) throw new Error('index: missing release/buildNumber/tables')
    console.log(`[fetch-sde] upstream release = ${release}, build = ${build}`)

    await rm(SDE_SRC, { recursive: true, force: true })
    await mkdir(SDE_SRC, { recursive: true })
    for (const t of TABLES) {
        const url = index.tables[t]?.jsonl?.url
        if (!url) throw new Error(`index: table ${t} has no jsonl url`)
        const buf = await getBuffer(url)
        await writeFile(path.join(SDE_SRC, `${t}.jsonl`), convertTable(t, buf))
        console.log(`[fetch-sde] ${t}: ${(buf.length / 1048576).toFixed(2)} MB`)
    }
    await writeFile(path.join(SDE_SRC, '.build'), build)
    await writeFile(path.join(SDE_SRC, '.release'), release)
    console.log(`[fetch-sde] staged ${TABLES.length} tables into .sde-src (release ${release}, build ${build})`)
}

main().catch((err) => { console.error('[fetch-sde]', err.message); process.exit(1) })
