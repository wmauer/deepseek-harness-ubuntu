/**
 * Verify the Debian package electron-builder wrote before it leaves the build: control identity,
 * maintainer scripts, desktop integration, archive hygiene, and file parity with the application
 * directory the runtime smoke exercised.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { resolveDesktopBuildVersion } from './desktop-build-version.mjs'
import { resolveLinuxPackageSettings } from './linux-package-settings.mjs'
import {
  LINUX_DESKTOP_NAME, LINUX_EXECUTABLE_NAME, LINUX_INSTALL_ROOT, LINUX_PACKAGE_NAME, debianArchitecture,
  linuxPackageFilename, linuxUnpackedDirectory,
} from './linux-package-paths.mjs'
import { resolveDesktopPackageTarget } from './package-target.ts'

const run = promisify(execFile)

/** Values the package must declare; packaging derives them from the same settings electron-builder received. */
export interface LinuxPackageExpectation {
  readonly version: string
  readonly arch: 'x64' | 'arm64'
  readonly maintainer: string
  readonly homepage: string
  /** Smoke-tested application directory; its files must match the package byte for byte. */
  readonly unpacked?: string
}

/** Facts read from a verified package. */
export interface LinuxPackageReport {
  readonly control: Readonly<Record<string, string>>
  readonly desktopEntry: Readonly<Record<string, string>>
  readonly entries: number
}

/** Runtime libraries every supported Debian derivative must resolve before Electron starts. */
const REQUIRED_DEPENDS = ['ca-certificates', 'libasound2', 'libgbm1', 'libgtk-3-0', 'libnss3', 'libxkbcommon0', 'xdg-utils']

/** Directories a package may populate; anything else is an ownership mistake. */
const ALLOWED_PREFIXES = [`.${LINUX_INSTALL_ROOT}/`, './usr/share/applications/', './usr/share/icons/hicolor/', './usr/share/mime/']
const ALLOWED_DIRECTORIES = new Set(['./', './opt/', './usr/', './usr/share/', './usr/share/applications/', './usr/share/icons/', './usr/share/icons/hicolor/', './usr/share/mime/'])

const REQUIRED_EXECUTABLES = [
  LINUX_EXECUTABLE_NAME, 'chrome-sandbox', 'resources/runtime/cli/bin/dsh', 'resources/runtime/bin/node',
  'resources/runtime/primary-runtime/dependencies/node/bin/node',
]
const REQUIRED_FILES = ['resources/app.asar', 'resources/apparmor-profile', 'resources/icon.png',
  'resources/runtime/primary-runtime/runtime.json', 'resources/app.asar/../app.asar.unpacked/dsh/desktop-runtime.json']

/**
 * Convert a semantic version to the Debian form electron-builder writes: prerelease separators become `~`,
 * which dpkg orders before the release they precede.
 * @param version - Semantic build version.
 * @returns Debian version string.
 */
export function debianVersion(version: string): string {
  return version.replaceAll('-', '~')
}

/**
 * Parse Debian control fields, folding continuation lines into their field.
 * @param text - Output of `dpkg-deb --field`.
 * @returns Field values keyed by field name.
 */
export function parseDebianControl(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let current: string | undefined
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (/^\s/u.test(line)) {
      if (current === undefined) throw new Error('linux package: control continuation without a field')
      fields[current] = `${fields[current] ?? ''}\n${line.trim()}`
      continue
    }
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error(`linux package: invalid control line ${JSON.stringify(line)}`)
    current = line.slice(0, separator)
    fields[current] = line.slice(separator + 1).trim()
  }
  return fields
}

/**
 * Parse the `[Desktop Entry]` group of a desktop file.
 * @param text - Desktop file contents.
 * @returns Key values of the main group.
 */
export function parseDesktopEntry(text: string): Record<string, string> {
  const entry: Record<string, string> = {}
  let inEntry = false
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) { inEntry = line.trim() === '[Desktop Entry]'; continue }
    if (!inEntry || line.trim() === '' || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error(`linux package: invalid desktop entry line ${JSON.stringify(line)}`)
    entry[line.slice(0, separator)] = line.slice(separator + 1)
  }
  if (!inEntry && Object.keys(entry).length === 0) throw new Error('linux package: desktop file has no [Desktop Entry] group')
  return entry
}

interface ArchiveEntry { readonly mode: string; readonly owner: string; readonly path: string }

/**
 * Parse `dpkg-deb --contents` rows.
 * @param text - Listing output.
 * @returns Mode, owner and archive path of every member; symlink targets are dropped.
 */
export function parseArchiveListing(text: string): ArchiveEntry[] {
  return text.split('\n').filter(line => line !== '').map((line) => {
    const match = /^(?<mode>[-dlrwxsStT]{10})\s+(?<owner>\S+)\s+\d+\s+\S+\s+\S+\s+(?<path>.+?)(?: -> .*)?$/u.exec(line)
    if (match?.groups === undefined) throw new Error(`linux package: unrecognized archive row ${JSON.stringify(line)}`)
    return { mode: match.groups.mode!, owner: match.groups.owner!, path: match.groups.path! }
  })
}

function fail(message: string): never { throw new Error(`linux package: ${message}`) }

function expectField(control: Record<string, string>, name: string, expected: string): void {
  if (control[name] !== expected) fail(`${name} is ${JSON.stringify(control[name])}, expected ${JSON.stringify(expected)}`)
}

/** Describe one file for parity comparison; owners are ignored because dpkg assigns root. */
function describe(path: string): string {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return `link:${readlinkSync(path)}`
  if (info.isDirectory()) return 'directory'
  if (!info.isFile()) fail(`unsupported entry ${path}`)
  const executable = (info.mode & 0o111) !== 0 ? 'x' : '-'
  return `file:${executable}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

function inventory(root: string): Map<string, string> {
  const result = new Map<string, string>()
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      result.set(relative(root, path).split(sep).join('/'), describe(path))
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(root)
  return result
}

/**
 * Verify one Debian package against the identity and content the build intended.
 * @param packagePath - Package electron-builder wrote.
 * @param expectation - Version, architecture, maintainer, homepage, and the smoke-tested application directory.
 * @returns Control and desktop-entry facts after every check passes.
 */
export async function verifyLinuxPackage(packagePath: string, expectation: LinuxPackageExpectation): Promise<LinuxPackageReport> {
  const control = parseDebianControl((await run('dpkg-deb', ['--field', packagePath], { maxBuffer: 1 << 20 })).stdout)
  expectField(control, 'Package', LINUX_PACKAGE_NAME)
  expectField(control, 'Version', debianVersion(expectation.version))
  expectField(control, 'Architecture', debianArchitecture(expectation.arch))
  expectField(control, 'Maintainer', expectation.maintainer)
  expectField(control, 'Section', 'devel')
  expectField(control, 'Priority', 'optional')
  expectField(control, 'Homepage', expectation.homepage)
  if (!control.Description?.startsWith('DeepSeek Harness desktop application')) fail('Description lacks the synopsis')
  const depends = (control.Depends ?? '').split(',').map(item => item.trim().split(/\s/u)[0]).filter(item => item !== '')
  for (const name of REQUIRED_DEPENDS) if (!depends.includes(name)) fail(`Depends omits ${name}`)

  const entries = parseArchiveListing((await run('dpkg-deb', ['--contents', packagePath], { maxBuffer: 64 << 20 })).stdout)
  if (entries.length === 0) fail('archive is empty')
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  for (const entry of entries) {
    if (entry.owner !== 'root/root') fail(`${entry.path} is owned by ${entry.owner}`)
    if (/[sStT]/u.test(entry.mode)) fail(`${entry.path} carries a setuid, setgid or sticky bit; the maintainer script grants the sandbox bit on hosts that need it`)
    const directory = entry.mode.startsWith('d')
    if (directory ? !ALLOWED_DIRECTORIES.has(entry.path) && !ALLOWED_PREFIXES.some(prefix => entry.path.startsWith(prefix))
      : !ALLOWED_PREFIXES.some(prefix => entry.path.startsWith(prefix))) {
      fail(`${entry.path} is outside the directories this package may own`)
    }
  }
  const installed = (path: string): ArchiveEntry => byPath.get(`.${LINUX_INSTALL_ROOT}/${path}`) ?? fail(`archive omits ${path}`)
  for (const path of REQUIRED_EXECUTABLES) {
    if (!/^-rwx/u.test(installed(path).mode)) fail(`${path} is not an executable regular file`)
  }
  for (const path of REQUIRED_FILES) {
    const normalized = path.replace('app.asar/../', '')
    if (!installed(normalized).mode.startsWith('-')) fail(`${normalized} is not a regular file`)
  }
  if (byPath.get(`./usr/share/applications/${LINUX_DESKTOP_NAME}`) === undefined) fail('archive omits the desktop entry')
  if (!entries.some(entry => /^\.\/usr\/share\/icons\/hicolor\/\d+x\d+\/apps\/deepseek-harness\.png$/u.test(entry.path))) {
    fail('archive omits the hicolor application icons')
  }

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-deb-verify-'))
  try {
    const controlDirectory = join(scratch, 'control')
    const dataDirectory = join(scratch, 'data')
    await run('dpkg-deb', ['--control', packagePath, controlDirectory])
    await run('dpkg-deb', ['--extract', packagePath, dataDirectory])
    for (const [script, fragments] of [
      ['postinst', ['chrome-sandbox', `/usr/bin/${LINUX_EXECUTABLE_NAME}`, 'update-desktop-database', 'apparmor']],
      ['postrm', [`/usr/bin/${LINUX_EXECUTABLE_NAME}`]],
    ] as const) {
      const path = join(controlDirectory, script)
      let text: string
      try { text = readFileSync(path, 'utf8') } catch { fail(`control archive omits ${script}`) }
      if ((lstatSync(path).mode & 0o111) === 0) fail(`${script} is not executable`)
      if (!text.startsWith('#!/bin/bash') && !text.startsWith('#!/bin/sh')) fail(`${script} has no shell interpreter line`)
      for (const fragment of fragments) if (!text.includes(fragment)) fail(`${script} does not mention ${fragment}`)
    }
    const desktopEntry = parseDesktopEntry(readFileSync(join(dataDirectory, 'usr', 'share', 'applications', LINUX_DESKTOP_NAME), 'utf8'))
    const executable = `${LINUX_INSTALL_ROOT}/${LINUX_EXECUTABLE_NAME}`
    if (desktopEntry.Type !== 'Application') fail('desktop entry is not an Application')
    if (desktopEntry.Name !== 'DeepSeek Harness') fail(`desktop entry Name is ${JSON.stringify(desktopEntry.Name)}`)
    if (desktopEntry.Exec !== `"${executable}" %U`) fail(`desktop entry Exec is ${JSON.stringify(desktopEntry.Exec)}`)
    if (desktopEntry.Icon !== LINUX_EXECUTABLE_NAME) fail(`desktop entry Icon is ${JSON.stringify(desktopEntry.Icon)}`)
    if (desktopEntry.StartupWMClass !== LINUX_EXECUTABLE_NAME) fail(`desktop entry StartupWMClass is ${JSON.stringify(desktopEntry.StartupWMClass)}`)
    if (!desktopEntry.Categories?.split(';').includes('Development')) fail('desktop entry lacks the Development category')
    if (!desktopEntry.MimeType?.split(';').includes('x-scheme-handler/dsh')) fail('desktop entry does not register the dsh URL scheme')
    const apparmor = readFileSync(join(dataDirectory, LINUX_INSTALL_ROOT.slice(1), 'resources', 'apparmor-profile'), 'utf8')
    if (!apparmor.includes(`"${executable}"`)) fail('AppArmor profile does not name the executable')
    if (expectation.unpacked !== undefined) {
      const packaged = inventory(join(dataDirectory, LINUX_INSTALL_ROOT.slice(1)))
      const smoked = inventory(expectation.unpacked)
      for (const [path, description] of smoked) {
        if (packaged.get(path) !== description) fail(`${path} differs between the package and the smoke-tested directory`)
      }
      for (const path of packaged.keys()) if (!smoked.has(path)) fail(`${path} exists only in the package`)
    }
    return { control, desktopEntry, entries: entries.length }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    package: { type: 'string' }, unpacked: { type: 'string' }, version: { type: 'string' },
  }, allowPositionals: false })
  const target = resolveDesktopPackageTarget(resolveDesktopBuildTarget())
  if (target.platform !== 'linux') throw new Error('linux package: select a Linux target through DSH_DESKTOP_TARGET_PLATFORM')
  const paths = resolveDesktopTargetBuildPaths()
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; homepage: string }
  const version = values.version ?? resolveDesktopBuildVersion(process.env, manifest.version)
  const packagePath = resolve(values.package ?? join(paths.artifacts, linuxPackageFilename(version, target.arch)))
  const unpacked = values.unpacked === undefined && values.package === undefined
    ? join(paths.artifacts, linuxUnpackedDirectory(target.arch)) : values.unpacked === undefined ? undefined : resolve(values.unpacked)
  const report = await verifyLinuxPackage(packagePath, {
    version, arch: target.arch, maintainer: resolveLinuxPackageSettings(process.env).maintainer, homepage: manifest.homepage,
    ...(unpacked === undefined ? {} : { unpacked }),
  })
  process.stdout.write(`linux package: ${packagePath} verified (${String(report.entries)} entries, ${report.control.Version ?? ''} ${report.control.Architecture ?? ''})\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
