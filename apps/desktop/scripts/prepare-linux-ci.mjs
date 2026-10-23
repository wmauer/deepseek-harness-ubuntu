/** Resolve the Linux Actions build version and record it for the packaging steps. */
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { desktopCiVersion } from './desktop-ci-version.mjs'
import { localLinuxPackageEnvironment, validateDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { debianArchitecture } from './linux-package-paths.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const product = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'))
const arch = process.env.PACKAGE_ARCH
if (arch !== 'x64' && arch !== 'arm64') throw new Error('PACKAGE_ARCH must be x64 or arm64')
// Linux has no machine preset: default version mode numbers the build from the run identity.
const version = desktopCiVersion({ ...process.env, DSH_PACKAGING_PRESET: undefined }, product.version)
const environment = localLinuxPackageEnvironment(process.env, appRoot)
validateDesktopPackageEnvironment(environment, { platform: 'linux', arch })
if (!process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY) throw new Error('Run this adapter from GitHub Actions')
appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ndebian_arch=${debianArchitecture(arch)}\n`)
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Linux ${debianArchitecture(arch)} Debian package\n\nVersion: ${version}\n\nCommit: ${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}\n\nSource: ${process.env.GITHUB_REF_NAME ?? ''}\n\nMaintainer: ${environment.DSH_DESKTOP_LINUX_MAINTAINER ?? '(documented placeholder)'}\n`)
