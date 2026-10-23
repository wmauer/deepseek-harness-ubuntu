/** Bundled runtime currency against recorded upstream listings. */

import { describe, expect, it } from 'vitest'
import {
  checkRuntimeCurrency, newestOnLine, parseRuntimeCurrencyPolicy, readBundledRuntimes, renderRuntimeCurrency,
  type BundledRuntimes, type RuntimeCurrencyPolicy,
} from '../scripts/check-runtime-currency.ts'

const now = new Date('2026-10-23T12:00:00Z')
const old = '2026-10-01T00:00:00Z'
const fresh = '2026-10-23T06:00:00Z'
const bundled: BundledRuntimes = { electron: '44.9.3', node: '24.22.1', python: '3.12.14', pythonRelease: '20260901', pnpm: '11.28.7' }
const policy: RuntimeCurrencyPolicy = { minimumReleaseAgeHours: 24, holds: [] }

function registry(versions: Record<string, string>): unknown {
  return { 'dist-tags': { latest: Object.keys(versions).at(-1) }, versions: Object.fromEntries(Object.keys(versions).map(v => [v, {}])), time: versions }
}

function transport(documents: Record<string, unknown>, failing: string[] = []) {
  const calls: string[] = []
  const fetchImpl = async (url: string) => {
    calls.push(url)
    if (failing.some(prefix => url.startsWith(prefix))) return { ok: false, status: 503, json: async () => ({}) }
    const document = Object.entries(documents).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (document === undefined) throw new Error(`unexpected ${url}`)
    return { ok: true, status: 200, json: async () => document }
  }
  return { fetchImpl, calls }
}

const upstream = {
  'https://registry.npmjs.org/electron': registry({ '42.0.0': old, '43.1.0': old, '44.7.0': old, '44.9.3': old, '45.0.0': old, '45.0.1': fresh, '46.0.0-alpha.1': old }),
  'https://nodejs.org/dist/index.json': [{ version: 'v25.0.0', lts: false }, { version: 'v24.22.1', lts: 'Krypton' }, { version: 'v24.21.0', lts: 'Krypton' }],
  'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest': { tag_name: '20261001', assets: [
    { name: 'cpython-3.12.14+20261001-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz' },
    { name: 'cpython-3.13.9+20261001-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz' },
  ] },
  'https://registry.npmjs.org/pnpm': registry({ '11.28.5': old, '11.28.7': old, '11.28.8': fresh, '12.15.0': old }),
}

describe('runtime currency', () => {
  it('validates the policy file', () => {
    expect(parseRuntimeCurrencyPolicy({ minimumReleaseAgeHours: 24, holds: [{ component: 'electron', version: '44.7.0', reason: 'addon', expires: '2026-12-31' }] }).holds).toHaveLength(1)
    expect(() => parseRuntimeCurrencyPolicy({ holds: [] })).toThrow(/minimumReleaseAgeHours/u)
    expect(() => parseRuntimeCurrencyPolicy({ minimumReleaseAgeHours: 24, holds: [{ component: 'electron', version: '1', reason: '', expires: '2026-12-31' }] })).toThrow(/reason/u)
    expect(() => parseRuntimeCurrencyPolicy({ minimumReleaseAgeHours: 24, holds: [{ component: 'electron', version: '1', reason: 'x', expires: 'soon' }] })).toThrow(/expires/u)
  })

  it('selects the newest stable release on the bundled line', () => {
    expect(newestOnLine(['44.7.0', '44.9.3', '45.0.0', '44.10.0-beta.1'], '44.7.0')).toBe('44.9.3')
    expect(newestOnLine(['45.0.0'], '44.7.0')).toBeUndefined()
  })

  it('reads the versions this repository bundles', () => {
    const versions = readBundledRuntimes(new URL('../../..', import.meta.url).pathname)
    expect(versions.electron).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(versions.node).toMatch(/^24\./u)
    expect(versions.pnpm).toMatch(/^11\./u)
  })

  it('reports every component current when upstream matches, ignoring releases inside the age window', async () => {
    const { fetchImpl, calls } = transport(upstream)
    const rows = await checkRuntimeCurrency(bundled, policy, { fetch: fetchImpl, now, githubToken: 'token' })
    expect(rows.map(row => [row.component, row.status])).toEqual([['electron', 'current'], ['node', 'current'], ['python', 'current'], ['pnpm', 'current']])
    expect(calls).toHaveLength(4)
  })

  it('marks stale lines, honors unexpired holds, and expires them', async () => {
    const { fetchImpl } = transport(upstream)
    const stale = { ...bundled, electron: '44.7.0', node: '24.21.0', pnpm: '11.28.5' }
    const rows = await checkRuntimeCurrency(stale, policy, { fetch: fetchImpl, now })
    expect(rows.map(row => `${row.component}:${row.status}:${row.latest}`)).toEqual(['electron:stale:44.9.3', 'node:stale:24.22.1', 'python:current:3.12.14', 'pnpm:stale:11.28.7'])
    const held = { minimumReleaseAgeHours: 24, holds: [
      { component: 'electron', version: '44.7.0', reason: 'native addon fingerprint', expires: '2026-12-31' },
      { component: 'node', version: '24.21.0', reason: 'expired hold', expires: '2026-10-01' },
    ] }
    const heldRows = await checkRuntimeCurrency(stale, held, { fetch: fetchImpl, now })
    expect(heldRows.find(row => row.component === 'electron')).toMatchObject({ status: 'held', detail: 'native addon fingerprint (until 2026-12-31)' })
    expect(heldRows.find(row => row.component === 'node')?.status).toBe('stale')
  })

  it('treats an Electron line outside the three supported majors as stale even at its newest patch', async () => {
    const { fetchImpl } = transport(upstream)
    const rows = await checkRuntimeCurrency({ ...bundled, electron: '42.0.0' }, policy, { fetch: fetchImpl, now })
    expect(rows[0]).toMatchObject({ component: 'electron', status: 'stale' })
    expect(rows[0]!.detail).toContain('outside the three supported Electron lines')
  })

  it('reports unverifiable components without hiding the others', async () => {
    const { fetchImpl } = transport(upstream, ['https://nodejs.org'])
    const rows = await checkRuntimeCurrency(bundled, policy, { fetch: fetchImpl, now })
    expect(rows.find(row => row.component === 'node')).toMatchObject({ status: 'unverified', latest: '?' })
    expect(rows.filter(row => row.status === 'current')).toHaveLength(3)
    expect(renderRuntimeCurrency(rows)).toContain('| node | 24.22.1 | ? | unverified |')
  })
})
