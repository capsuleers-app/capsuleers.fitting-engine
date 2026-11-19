# Rilascio e manutenzione

Leggi se pubblichi, tocchi la CI di rilascio o il refresh SDE. Flussi completi: `MAINTENANCE.md`, `RELEASE.md`.

See `MAINTENANCE.md` (the two update streams) and `RELEASE.md` (publish + how the
app wires to the package). SDE balance patches are data-only (no package
release); new Pyfa hardcoded mechanics are detected by `npm run drift` and ported
manually, then gated by both suites.

Two CI publish paths (both gate on `npm run test:pyfa` + `npm run audit:coverage` + `npm run test:drones`
and publish with the `prod`-environment `NPM_TOKEN`; both share `concurrency: release`):
- **`.github/workflows/release.yml`** — **automatic on every push to `master`** (= every merged PR):
  gate, bump, `npm publish`, release commit `chore(release): vX.Y.Z [auto]` + tag. Manual
  `workflow_dispatch` (`bump` = `auto`/`minor`/`major`) for a minor/major. PRs never tag: a `preview` job
  only prints the version a merge would release.
  - **Version rule** (`scripts/next-version.sh`): the Go twin's highest tag > mine -> reach it; otherwise
    patch + 1. The twin tag is read with `git ls-remote` (public repo). Twin PRs merged in sequence, in
    either order, end on the same version in both repos.
  - **No loops / no double release** (push only): a tip commit whose subject has `[auto]` (this workflow,
    sde-refresh, pyfa-pin-bump) or that already has a `v*` tag releases nothing; the run always checks out
    the CURRENT tip of master. `paths-ignore`: `**.md`, `docs/**`, `.github/**`, `test/**`, `scripts/**`,
    `oracle/**`, `package-lock.json`, `LICENSE`, `NOTICE`, `.gitignore` (nothing that changes the
    published `dist/`+`data/`). To release a docs-only change anyway: dispatch it.
  - Right before `npm version` it re-checks the version, that master did not move and that neither the
    tag nor the npm version exists (never overwritten); master moved -> red run, the queued run releases
    the new tip.
- **`.github/workflows/sde-refresh.yml`** — daily cron; rebuilds `data/` from CCP's latest SDE and,
  *only if the bundle changed and parity stays green*, commits the new `data/` + bumps + auto-publishes
  (`[auto]` commits). Its version is strictly above BOTH this package and the Go twin
  (`next-version.sh sde`), so it never reuses a version the twin tagged with older data. On parity failure
  it opens an issue and does NOT publish.
  **It runs at 05:00 UTC, so a CCP release in the evening stays uncovered for
  up to ~10 h** — 3538132 landed 2026-09-22 19:31Z, after that day's run had
  already shipped 3528119. When a new SDE is announced, dispatch it by hand:
  `gh workflow run sde-refresh.yml` (v0.2.3 was published this way, gate green).
