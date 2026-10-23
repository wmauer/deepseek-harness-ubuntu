/** Debian package verification against a package built from a minimal installation tree. */

import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { debianVersion, parseArchiveListing, parseDebianControl, parseDesktopEntry, verifyLinuxPackage } from '../scripts/verify-linux-package.ts'
import { DEFAULT_LINUX_MAINTAINER } from '../scripts/linux-package-settings.mjs'
import { LINUX_INSTALL_ROOT } from '../scripts/linux-package-paths.mjs'

const HOMEPAGE = 'https://github.com/deepseek-ai/deepseek-harness'
const DEPENDS = 'ca-certificates, libasound2, libgbm1, libgtk-3-0, libnss3, libxkbcommon0, xdg-utils, libnotify4'
const DESKTOP_ENTRY = [
  '[Desktop Entry]', 'Name=DeepSeek Harness', `Exec="${LINUX_INSTALL_ROOT}/deepseek-harness" %U`, 'Terminal=false', 'Type=Application',
  'Icon=deepseek-harness', 'StartupWMClass=deepseek-harness', 'Comment=Desktop', 'MimeType=x-scheme-handler/dsh;', 'Categories=Development;', '',
].join('\n')

let dpkgAvailable = true
try { execFileSync('dpkg-deb', ['--version'], { stdio: 'ignore' }) } catch { dpkgAvailable = false }

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

interface PackageFixture {
  readonly root: string
  readonly application: string
  readonly unpacked: string
  build(): string
  control(fields: Record<string, string>): void
}

function fixture(options: { setuid?: boolean; strayFile?: boolean; desktopEntry?: string } = {}): PackageFixture {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-deb-fixture-'))
  directories.push(scratch)
  const root = join(scratch, 'root')
  const application = join(root, LINUX_INSTALL_ROOT.slice(1))
  const file = (path: string, content: string, mode = 0o644): void => {
    mkdirSync(join(application, path, '..'), { recursive: true })
    writeFileSync(join(application, path), content, { mode })
  }
  file('deepseek-harness', '#!/bin/sh\nexit 0\n', 0o755)
  file('chrome-sandbox', '#!/bin/sh\nexit 0\n', options.setuid ? 0o4755 : 0o755)
  file('resources/app.asar', 'asar')
  file('resources/apparmor-profile', `profile "deepseek-harness" "${LINUX_INSTALL_ROOT}/deepseek-harness" flags=(unconfined) {}\n`)
  file('resources/icon.png', 'png')
  file('resources/runtime/cli/bin/dsh', '#!/bin/sh\n', 0o755)
  file('resources/runtime/bin/node', '#!/bin/sh\n', 0o755)
  file('resources/runtime/primary-runtime/dependencies/node/bin/node', 'elf', 0o755)
  file('resources/runtime/primary-runtime/runtime.json', '{}')
  file('resources/app.asar.unpacked/dsh/desktop-runtime.json', '{}')
  mkdirSync(join(root, 'usr', 'share', 'applications'), { recursive: true })
  writeFileSync(join(root, 'usr', 'share', 'applications', 'deepseek-harness.desktop'), options.desktopEntry ?? DESKTOP_ENTRY)
  mkdirSync(join(root, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps'), { recursive: true })
  writeFileSync(join(root, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'deepseek-harness.png'), 'png')
  if (options.strayFile) { mkdirSync(join(root, 'usr', 'bin'), { recursive: true }); writeFileSync(join(root, 'usr', 'bin', 'stray'), '') }
  const debian = join(root, 'DEBIAN')
  mkdirSync(debian)
  const control = (fields: Record<string, string>): void => {
    const merged = {
      Package: 'deepseek-harness', Version: '0.2.1~rc.2', Architecture: 'amd64', Maintainer: DEFAULT_LINUX_MAINTAINER,
      Section: 'devel', Priority: 'optional', Homepage: HOMEPAGE, Depends: DEPENDS,
      Description: 'DeepSeek Harness desktop application\n Open-source agent harness.', ...fields,
    }
    writeFileSync(join(debian, 'control'), `${Object.entries(merged).map(([name, value]) => `${name}: ${value}`).join('\n')}\n`)
  }
  control({})
  writeFileSync(join(debian, 'postinst'), `#!/bin/bash\nln -sf '${LINUX_INSTALL_ROOT}/deepseek-harness' '/usr/bin/deepseek-harness'\nchmod 0755 '${LINUX_INSTALL_ROOT}/chrome-sandbox'\nupdate-desktop-database || true\n# apparmor profile\n`, { mode: 0o755 })
  writeFileSync(join(debian, 'postrm'), '#!/bin/bash\nrm -f /usr/bin/deepseek-harness\n', { mode: 0o755 })
  const unpacked = join(scratch, 'linux-unpacked')
  cpSync(application, unpacked, { recursive: true })
  return {
    root, application, unpacked, control,
    build: () => {
      const output = join(scratch, 'package.deb')
      execFileSync('dpkg-deb', ['--build', '--root-owner-group', root, output], { stdio: 'pipe' })
      return output
    },
  }
}

const expectation = { version: '0.2.1-rc.2', arch: 'x64' as const, maintainer: DEFAULT_LINUX_MAINTAINER, homepage: HOMEPAGE }

describe('Debian package verification', () => {
  it('maps prerelease separators to the tilde dpkg orders before the release', () => {
    expect(debianVersion('0.2.1-rc.2.20261023.4.1')).toBe('0.2.1~rc.2.20261023.4.1')
    expect(debianVersion('0.2.1')).toBe('0.2.1')
  })

  it('parses control fields with continuation lines, archive rows, and desktop entries', () => {
    expect(parseDebianControl('Package: a\nDescription: first\n second line\nVersion: 1\n')).toEqual({ Package: 'a', Description: 'first\nsecond line', Version: '1' })
    expect(() => parseDebianControl(' orphan continuation\n')).toThrow(/continuation/u)
    expect(parseArchiveListing([
      'drwxr-xr-x root/root         0 2026-10-23 04:00 ./opt/',
      '-rwxr-xr-x root/root     12345 2026-10-23 04:00 ./opt/DeepSeek Harness/deepseek-harness',
      'lrwxrwxrwx root/root         0 2026-10-23 04:00 ./opt/DeepSeek Harness/link -> target',
    ].join('\n'))).toEqual([
      { mode: 'drwxr-xr-x', owner: 'root/root', path: './opt/' },
      { mode: '-rwxr-xr-x', owner: 'root/root', path: './opt/DeepSeek Harness/deepseek-harness' },
      { mode: 'lrwxrwxrwx', owner: 'root/root', path: './opt/DeepSeek Harness/link' },
    ])
    expect(parseDesktopEntry(`${DESKTOP_ENTRY}[Desktop Action Other]\nName=Other\n`)).toMatchObject({ Exec: `"${LINUX_INSTALL_ROOT}/deepseek-harness" %U`, MimeType: 'x-scheme-handler/dsh;' })
    expect(() => parseDesktopEntry('Name=No group\n')).toThrow(/Desktop Entry/u)
  })

  it.skipIf(!dpkgAvailable)('accepts a package whose identity, scripts, desktop entry and files match the build', async () => {
    const f = fixture()
    const report = await verifyLinuxPackage(f.build(), { ...expectation, unpacked: f.unpacked })
    expect(report.control).toMatchObject({ Package: 'deepseek-harness', Version: '0.2.1~rc.2', Architecture: 'amd64' })
    expect(report.desktopEntry.StartupWMClass).toBe('deepseek-harness')
    expect(report.entries).toBeGreaterThan(10)
  })

  it.skipIf(!dpkgAvailable)('rejects identity mismatches before reading the archive', async () => {
    const f = fixture()
    const built = f.build()
    await expect(verifyLinuxPackage(built, { ...expectation, arch: 'arm64' })).rejects.toThrow(/Architecture/u)
    await expect(verifyLinuxPackage(built, { ...expectation, version: '0.2.2' })).rejects.toThrow(/Version/u)
    await expect(verifyLinuxPackage(built, { ...expectation, maintainer: 'Other <other@example.com>' })).rejects.toThrow(/Maintainer/u)
    f.control({ Depends: 'libgtk-3-0' })
    await expect(verifyLinuxPackage(f.build(), expectation)).rejects.toThrow(/Depends omits ca-certificates/u)
  })

  it.skipIf(!dpkgAvailable)('rejects archive hygiene violations', async () => {
    await expect(verifyLinuxPackage(fixture({ setuid: true }).build(), expectation)).rejects.toThrow(/setuid/u)
    await expect(verifyLinuxPackage(fixture({ strayFile: true }).build(), expectation)).rejects.toThrow(/outside the directories/u)
    const missingScheme = fixture({ desktopEntry: DESKTOP_ENTRY.replace('MimeType=x-scheme-handler/dsh;\n', '') })
    await expect(verifyLinuxPackage(missingScheme.build(), expectation)).rejects.toThrow(/dsh URL scheme/u)
  })

  it.skipIf(!dpkgAvailable)('rejects content that differs from the smoke-tested directory', async () => {
    const f = fixture()
    const built = f.build()
    writeFileSync(join(f.unpacked, 'resources', 'app.asar'), 'changed')
    await expect(verifyLinuxPackage(built, { ...expectation, unpacked: f.unpacked })).rejects.toThrow(/resources\/app\.asar differs/u)
    rmSync(join(f.unpacked, 'resources', 'icon.png'))
    chmodSync(join(f.unpacked, 'resources', 'app.asar'), 0o644)
    await expect(verifyLinuxPackage(built, { ...expectation, unpacked: f.unpacked })).rejects.toThrow(/differs|exists only in the package/u)
  })
})
