/**
 * Compare the runtimes a Desktop package bundles against their upstream release lines: Electron,
 * the primary-runtime Node.js and CPython, and pnpm. A component behind its line fails the check
 * unless `config/runtime-currency.json` records a reviewed, dated hold for that exact version.
 */

import { readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compare, gt, major, parse, valid } from 'semver'

/** One reviewed exception that keeps a stale component passing until its expiry date. */
export interface RuntimeCurrencyHold {
  readonly component: string
  readonly version: string
  readonly reason: string
  /** ISO calendar date after which the hold no longer applies. */
  readonly expires: string
}

/** Policy read from `config/runtime-currency.json`. */
export interface RuntimeCurrencyPolicy {
  readonly minimumReleaseAgeHours: number
  readonly holds: readonly RuntimeCurrencyHold[]
}

/** Versions the repository currently bundles. */
export interface BundledRuntimes {
  readonly electron: string
  readonly node: string
  readonly python: string
  readonly pythonRelease: string
  readonly pnpm: string
}

/** Result for one component. */
export interface RuntimeCurrencyRow {
  readonly component: string
  readonly bundled: string
  readonly latest: string
  readonly status: 'current' | 'stale' | 'held' | 'unverified'
  readonly detail: string
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse and validate the currency policy.
 * @param value - Parsed JSON.
 * @returns Validated policy.
 */
export function parseRuntimeCurrencyPolicy(value: unknown): RuntimeCurrencyPolicy {
  if (!record(value) || !Array.isArray(value.holds) || typeof value.minimumReleaseAgeHours !== 'number'
    || !Number.isInteger(value.minimumReleaseAgeHours) || value.minimumReleaseAgeHours < 0) {
    throw new Error('runtime currency: policy needs an integer minimumReleaseAgeHours and a holds array')
  }
  const holds = value.holds.map((hold: unknown): RuntimeCurrencyHold => {
    if (!record(hold) || typeof hold.component !== 'string' || typeof hold.version !== 'string' || typeof hold.reason !== 'string'
      || hold.reason.trim() === '' || typeof hold.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(hold.expires)
      || Number.isNaN(Date.parse(hold.expires))) {
      throw new Error('runtime currency: each hold needs component, version, a reason, and an ISO expires date')
    }
    return { component: hold.component, version: hold.version, reason: hold.reason, expires: hold.expires }
  })
  return { minimumReleaseAgeHours: value.minimumReleaseAgeHours, holds }
}

/**
 * Select the newest stable version on the same major line.
 * @param versions - Candidate versions.
 * @param bundled - Version whose line is examined.
 * @returns Newest version of that line, or undefined when none parses.
 */
export function newestOnLine(versions: readonly string[], bundled: string): string | undefined {
  const line = major(bundled)
  return versions.filter(version => valid(version) !== null && parse(version)!.prerelease.length === 0 && major(version) === line)
    .sort(compare).at(-1)
}

/**
 * Read the versions the repository bundles.
 * @param repositoryRoot - Checkout root.
 * @returns Electron, primary-runtime Node and CPython, and pnpm versions.
 */
export function readBundledRuntimes(repositoryRoot: string): BundledRuntimes {
  const require = createRequire(resolve(repositoryRoot, 'apps', 'desktop', 'package.json'))
  const electron = (require('electron/package.json') as { version: string }).version
  const lock = JSON.parse(readFileSync(resolve(repositoryRoot, 'scripts', 'primary-runtime', 'lock.json'), 'utf8')) as {
    nodeVersion: string
    pythonVersion: string
    pythonRelease: string
  }
  const root = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as { packageManager: string }
  const pnpm = /^pnpm@(?<version>[^+]+)/u.exec(root.packageManager)?.groups?.version
  if (pnpm === undefined) throw new Error('runtime currency: packageManager must pin pnpm')
  return { electron, node: lock.nodeVersion, python: lock.pythonVersion, pythonRelease: lock.pythonRelease, pnpm }
}

async function registry(fetchImpl: Fetch, name: string): Promise<{ versions: string[]; time: Record<string, string> }> {
  const response = await fetchImpl(`https://registry.npmjs.org/${name}`)
  if (!response.ok) throw new Error(`registry answered ${String(response.status)} for ${name}`)
  const value = await response.json()
  if (!record(value) || !record(value.versions) || !record(value.time)) throw new Error(`registry document for ${name} is malformed`)
  return { versions: Object.keys(value.versions), time: value.time as Record<string, string> }
}

function finish(
  bundled: string, latest: string | undefined, policy: RuntimeCurrencyPolicy, component: string, now: Date, detail: string,
): RuntimeCurrencyRow {
  if (latest === undefined) return { component, bundled, latest: '?', status: 'unverified', detail: 'no release found on this line' }
  if (!gt(latest, bundled)) return { component, bundled, latest, status: 'current', detail }
  const hold = policy.holds.find(candidate => candidate.component === component && candidate.version === bundled
    && Date.parse(`${candidate.expires}T23:59:59Z`) >= now.getTime())
  if (hold !== undefined) return { component, bundled, latest, status: 'held', detail: `${hold.reason} (until ${hold.expires})` }
  return { component, bundled, latest, status: 'stale', detail }
}

/**
 * Check every bundled runtime against upstream.
 * @param bundled - Versions the repository bundles.
 * @param policy - Release-age window and reviewed holds.
 * @param options - Transport, clock, and optional GitHub token for the python-build-standalone release listing.
 * @returns One row per component.
 */
export async function checkRuntimeCurrency(
  bundled: BundledRuntimes, policy: RuntimeCurrencyPolicy,
  options: { fetch?: Fetch; now?: Date; githubToken?: string } = {},
): Promise<RuntimeCurrencyRow[]> {
  const fetchImpl = options.fetch ?? (fetch as unknown as Fetch)
  const now = options.now ?? new Date()
  const cutoff = now.getTime() - policy.minimumReleaseAgeHours * 3_600_000
  const rows: RuntimeCurrencyRow[] = []
  const guarded = async (component: string, version: string, action: () => Promise<RuntimeCurrencyRow>): Promise<void> => {
    try { rows.push(await action()) }
    catch (error) { rows.push({ component, bundled: version, latest: '?', status: 'unverified', detail: error instanceof Error ? error.message : String(error) }) }
  }
  await guarded('electron', bundled.electron, async () => {
    const { versions, time } = await registry(fetchImpl, 'electron')
    const aged = versions.filter(version => Date.parse(time[version] ?? '') <= cutoff)
    const stable = aged.filter(version => valid(version) !== null && parse(version)!.prerelease.length === 0)
    const newestMajor = Math.max(...stable.map(version => major(version)))
    const supported = major(bundled.electron) >= newestMajor - 2
    const latest = newestOnLine(aged, bundled.electron)
    const row = finish(bundled.electron, latest, policy, 'electron', now, `newest stable major ${String(newestMajor)}`)
    return supported ? row : { ...row, status: row.status === 'held' ? 'held' : 'stale', detail: `major ${String(major(bundled.electron))} is outside the three supported Electron lines (newest ${String(newestMajor)})` }
  })
  await guarded('node', bundled.node, async () => {
    const response = await fetchImpl('https://nodejs.org/dist/index.json')
    if (!response.ok) throw new Error(`nodejs.org answered ${String(response.status)}`)
    const index = await response.json()
    if (!Array.isArray(index)) throw new Error('nodejs.org index is malformed')
    const versions = index.map((entry: unknown) => record(entry) && typeof entry.version === 'string' ? entry.version.replace(/^v/u, '') : '')
    return finish(bundled.node, newestOnLine(versions, bundled.node), policy, 'node', now, 'primary runtime interpreter')
  })
  await guarded('python', bundled.python, async () => {
    const response = await fetchImpl('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest', {
      headers: { accept: 'application/vnd.github+json', ...(options.githubToken === undefined ? {} : { authorization: `Bearer ${options.githubToken}` }) },
    })
    if (!response.ok) throw new Error(`GitHub answered ${String(response.status)} for python-build-standalone`)
    const release = await response.json()
    if (!record(release) || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) throw new Error('release listing is malformed')
    const versions = release.assets.map((asset: unknown) => record(asset) && typeof asset.name === 'string'
      ? /^cpython-(?<version>\d+\.\d+\.\d+)\+\d+-x86_64-unknown-linux-gnu-install_only_stripped\.tar\.gz$/u.exec(asset.name)?.groups?.version ?? '' : '')
    const line = `${String(major(bundled.python))}.${String(parse(bundled.python)!.minor)}.`
    const latest = versions.filter(version => version !== '' && version.startsWith(line)).sort(compare).at(-1)
    return finish(bundled.python, latest, policy, 'python', now, `python-build-standalone ${release.tag_name} (bundled ${bundled.pythonRelease})`)
  })
  await guarded('pnpm', bundled.pnpm, async () => {
    const { versions, time } = await registry(fetchImpl, 'pnpm')
    const aged = versions.filter(version => Date.parse(time[version] ?? '') <= cutoff)
    return finish(bundled.pnpm, newestOnLine(aged, bundled.pnpm), policy, 'pnpm', now, `releases older than ${String(policy.minimumReleaseAgeHours)} h`)
  })
  return rows
}

/**
 * Render rows as a Markdown table.
 * @param rows - Check results.
 * @returns Table text ending with a newline.
 */
export function renderRuntimeCurrency(rows: readonly RuntimeCurrencyRow[]): string {
  const lines = ['| Component | Bundled | Latest | Status | Detail |', '|---|---|---|---|---|',
    ...rows.map(row => `| ${row.component} | ${row.bundled} | ${row.latest} | ${row.status} | ${row.detail.replaceAll('|', '\\|')} |`)]
  return `${lines.join('\n')}\n`
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'allow-unverified': { type: 'boolean', default: false } }, allowPositionals: false })
  const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..')
  const policy = parseRuntimeCurrencyPolicy(JSON.parse(readFileSync(resolve(repositoryRoot, 'apps', 'desktop', 'config', 'runtime-currency.json'), 'utf8')))
  const token = process.env.GITHUB_TOKEN
  const rows = await checkRuntimeCurrency(readBundledRuntimes(repositoryRoot), policy, token === undefined ? {} : { githubToken: token })
  const table = renderRuntimeCurrency(rows)
  process.stdout.write(table)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Bundled runtime currency\n\n${table}\n`)
  const stale = rows.filter(row => row.status === 'stale')
  const unverified = rows.filter(row => row.status === 'unverified')
  if (stale.length > 0) {
    process.stderr.write(`runtime currency: ${stale.map(row => row.component).join(', ')} behind upstream; update the bundled version or record a dated hold in apps/desktop/config/runtime-currency.json\n`)
    process.exitCode = 1
  }
  if (unverified.length > 0 && !values['allow-unverified']) {
    process.stderr.write(`runtime currency: could not verify ${unverified.map(row => row.component).join(', ')}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
