import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  id?: string
  name?: string
  if?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
interface Job {
  needs?: string[]
  'runs-on': string
  permissions?: Record<string, string>
  strategy?: { 'fail-fast': boolean; matrix: { include: string } }
  env?: Record<string, string>
  steps: Step[]
}

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/linux-package.yml'), 'utf8')) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  env: Record<string, string>
  jobs: Record<string, Job>
}
const steps = (job: string): Step[] => workflow.jobs[job]!.steps

describe('Linux packaging workflow', () => {
  it('runs on manual dispatch and release tags with read-only repository access', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on.push).toEqual({ tags: ['dsh-v*'] })
    expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: {
      architectures: { type: 'choice', options: ['both', 'amd64', 'arm64'], default: 'both' },
      version_mode: { type: 'choice', options: ['default', 'product', 'auto', 'manual'], default: 'default' },
      build_version: { type: 'string', default: '', required: false },
    } })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({ group: 'linux-desktop-package-${{ github.ref }}', 'cancel-in-progress': false })
    expect(workflow.env.PACKAGE_VERSION_MODE).toContain("github.event_name == 'push' && 'product'")
    expect(Object.keys(workflow.jobs)).toEqual(['plan', 'audit', 'package'])
  })

  it('builds each architecture natively on its hosted runner after the audit gates', () => {
    const plan = steps('plan').find(step => step.id === 'plan')!.run!
    expect(plan).toContain('"arch":"x64","debian":"amd64","runner":"ubuntu-24.04"')
    expect(plan).toContain('"arch":"arm64","debian":"arm64","runner":"ubuntu-24.04-arm"')
    const job = workflow.jobs.package!
    expect(job.needs).toEqual(['plan', 'audit'])
    expect(job['runs-on']).toBe('${{ matrix.runner }}')
    expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { include: '${{ fromJSON(needs.plan.outputs.matrix) }}' } })
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write', attestations: 'write' })
    expect(job.env).toMatchObject({ PACKAGE_ARCH: '${{ matrix.arch }}', DSH_DESKTOP_LINUX_MAINTAINER: '${{ vars.DSH_DESKTOP_LINUX_MAINTAINER }}' })
  })

  it('audits dependencies and bundled runtimes before any package is built', () => {
    const runs = steps('audit').map(step => step.run ?? '')
    expect(runs).toContain('pnpm audit --prod --audit-level=high')
    expect(runs.some(run => run.includes('check-runtime-currency.ts'))).toBe(true)
    expect(steps('audit').find(step => step.run?.includes('check-runtime-currency'))?.env).toEqual({ GITHUB_TOKEN: '${{ github.token }}' })
  })

  it('checks, builds, lints, installs, launches, and removes the package in order without reading raw inputs', () => {
    const job = steps('package')
    for (const step of job) expect(step.run ?? '').not.toContain('${{ inputs.')
    expect(job.find(step => step.id === 'checkout')?.with).toMatchObject({ 'persist-credentials': false, clean: true })
    expect(job.find(step => step.uses?.startsWith('pnpm/action-setup@'))?.with?.dest)
      .toBe('${{ runner.temp }}/setup-pnpm-${{ github.run_id }}-${{ github.run_attempt }}')
    const names = job.map(step => step.name ?? step.uses ?? '')
    const order = [
      'Install Debian packaging, linting, and headless display tools',
      'Install locked dependencies',
      'Resolve the build version',
      'Check packaging configuration and toolchain',
      'Build the package and verify its runtime and structure',
      'Locate the package',
      'Lint the package with lintian',
      'Install the package with apt and check its system integration',
      'Launch the installed application under Xvfb',
      'Remove the package and check that nothing stays behind',
      'Attest the package build origin',
    ]
    const positions = order.map(name => names.indexOf(name))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    for (const name of order) expect(names).toContain(name)
    const commands = job.filter(step => step.run?.includes('package:desktop:linux'))
    expect(commands).toHaveLength(2)
    expect(commands[0]!.run).toContain('--check')
    for (const step of commands) expect(step.env?.PACKAGE_VERSION).toBe('${{ steps.settings.outputs.version }}')
    expect(job.find(step => step.name === 'Launch the installed application under Xvfb')?.run).toContain('smoke-linux-desktop.ts --xvfb')
    expect(job.find(step => step.name === 'Attest the package build origin')?.if).toBe('github.event.repository.private == false')
  })

  it('retains diagnostics on failure and only verified packages with checksums on success', () => {
    const uploads = steps('package').filter(step => step.uses?.startsWith('actions/upload-artifact@'))
    expect(uploads).toHaveLength(2)
    expect(uploads[0]?.if).toBe("always() && steps.checkout.outcome == 'success'")
    expect(uploads[0]?.with).toMatchObject({ path: 'apps/desktop/.desktop-build/packaging-runs/', 'include-hidden-files': true })
    expect(uploads[1]?.if).toBe('success()')
    expect(uploads[1]?.with).toMatchObject({ path: '${{ runner.temp }}/linux-package/*', 'if-no-files-found': 'error' })
    expect(steps('package').find(step => step.id === 'artifact')?.run).toContain('sha256sum -- *.deb > SHA256SUMS')
  })
})
