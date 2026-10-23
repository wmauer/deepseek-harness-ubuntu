/** Launch smoke orchestration against a stand-in executable that mimics the remote debugging listing. */

import { chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { smokeLinuxDesktop } from '../scripts/smoke-linux-desktop.ts'

const executable = fileURLToPath(new URL('./fixtures/linux-desktop-fake.mjs', import.meta.url))

afterEach(() => { vi.unstubAllEnvs() })

describe.skipIf(process.platform === 'win32')('Linux desktop launch smoke', () => {
  it('waits for the welcome window, records the browser, and confirms a clean exit', async () => {
    chmodSync(executable, 0o755)
    const lines: string[] = []
    const result = await smokeLinuxDesktop({
      executable, startupTimeoutMs: 30_000, exitTimeoutMs: 10_000, log: (line) => { lines.push(line) },
    })
    expect(result).toMatchObject({ browser: 'Chrome/152.0.0.0', exitCode: 0 })
    expect(result.welcomeUrl).toMatch(/\/renderer\/welcome\.html$/u)
    expect(lines.at(-1)).toContain('opened')
  })

  it('reports a startup failure with its diagnostic', async () => {
    vi.stubEnv('FAKE_DESKTOP_MODE', 'crash')
    await expect(smokeLinuxDesktop({ executable, startupTimeoutMs: 30_000 }))
      .rejects.toThrow(/exited during startup \(3\): fixture startup failure/u)
  })

  it('fails when the welcome window never appears or the process ignores the quit request', async () => {
    vi.stubEnv('FAKE_DESKTOP_MODE', 'loading')
    await expect(smokeLinuxDesktop({ executable, startupTimeoutMs: 1_500, exitTimeoutMs: 5_000 }))
      .rejects.toThrow(/no welcome window within 1500 ms/u)
    vi.stubEnv('FAKE_DESKTOP_MODE', 'hang')
    await expect(smokeLinuxDesktop({ executable, startupTimeoutMs: 30_000, exitTimeoutMs: 5_000 }))
      .rejects.toThrow(/exited with 7 after SIGTERM/u)
  })

  it('refuses a missing installation', async () => {
    await expect(smokeLinuxDesktop({ executable: '/nonexistent/deepseek-harness' })).rejects.toThrow(/is not installed/u)
  })
})
