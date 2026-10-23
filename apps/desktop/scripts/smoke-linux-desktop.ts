/**
 * Launch an installed Linux Desktop against a private home, wait for its Host to open the welcome
 * window, then quit it. The check uses Chromium's remote debugging listing as the readiness signal,
 * so it needs no renderer instrumentation and runs under Xvfb on a headless runner.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { LINUX_EXECUTABLE_NAME, LINUX_INSTALL_ROOT } from './linux-package-paths.mjs'

/** What one launch check observed. */
export interface LinuxDesktopSmokeResult {
  readonly browser: string
  readonly welcomeUrl: string
  readonly startupMs: number
  readonly exitCode: number
}

interface DebuggingTarget { readonly type?: string; readonly url?: string; readonly title?: string }

/** Launch settings; defaults name the package installation and a four-minute startup budget. */
export interface LinuxDesktopSmokeOptions {
  readonly executable?: string
  readonly startupTimeoutMs?: number
  readonly exitTimeoutMs?: number
  /** Wrap the launch in `xvfb-run` when no display is available. */
  readonly xvfb?: boolean
  readonly log?: (line: string) => void
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { reject(new Error('linux desktop smoke: could not allocate a port')); return }
      server.close(() => { resolvePort(address.port) })
    })
  })
}

async function debuggingTargets(port: number): Promise<DebuggingTarget[] | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return undefined
    const value: unknown = await response.json()
    return Array.isArray(value) ? value as DebuggingTarget[] : undefined
  } catch {
    // The debugging server listens only after Chromium initializes; polling retries until the deadline.
    return undefined
  }
}

async function browserVersion(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`, { signal: AbortSignal.timeout(2_000) })
  const value = await response.json() as { Browser?: string }
  return value.Browser ?? 'unknown'
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveExit) => { child.once('exit', (code) => { resolveExit(code) }) })
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms) })

/**
 * Run the launch check once.
 * @param options - Executable, deadlines, and display wrapping.
 * @returns Observed browser identity, welcome document, startup time, and exit code.
 */
export async function smokeLinuxDesktop(options: LinuxDesktopSmokeOptions = {}): Promise<LinuxDesktopSmokeResult> {
  const executable = options.executable ?? `${LINUX_INSTALL_ROOT}/${LINUX_EXECUTABLE_NAME}`
  const startupTimeoutMs = options.startupTimeoutMs ?? 240_000
  const exitTimeoutMs = options.exitTimeoutMs ?? 60_000
  const log = options.log ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  if (!existsSync(executable)) throw new Error(`linux desktop smoke: ${executable} is not installed`)
  const home = mkdtempSync(join(tmpdir(), 'dsh-linux-smoke-'))
  const diagnosticFile = join(home, 'startup-diagnostic.txt')
  const outputFile = join(home, 'desktop-output.log')
  for (const name of ['config', 'cache', 'state', 'dsh', 'tmp']) mkdirSync(join(home, name))
  const port = await freePort()
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:DSH_|ELECTRON_|npm_|pnpm_)/iu.test(name))),
    HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
    TMPDIR: join(home, 'tmp'), DSH_HOME: join(home, 'dsh'), DSH_TELEMETRY_DISABLED: '1',
    DSH_DESKTOP_DIAGNOSTIC_FILE: diagnosticFile,
    // No network reaches the smoke; the shell must still open its welcome window without an account.
    ELECTRON_ENABLE_LOGGING: '1',
  }
  const arguments_ = [`--remote-debugging-port=${String(port)}`, '--disable-gpu']
  const [command, commandArguments] = options.xvfb && !process.env.DISPLAY
    ? ['xvfb-run', ['--auto-servernum', '--server-args=-screen 0 1280x900x24', executable, ...arguments_]]
    : [executable, arguments_]
  const started = Date.now()
  log(`linux desktop smoke: launching ${command} ${commandArguments.join(' ')}`)
  const child = spawn(command, commandArguments, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const output: string[] = []
  const record = (chunk: Buffer): void => { output.push(chunk.toString()) }
  child.stdout?.on('data', record)
  child.stderr?.on('data', record)
  const exit = exited(child)
  const flush = (): void => { writeFileSync(outputFile, output.join('')) }
  const terminate = (): void => {
    // xvfb-run owns a process group; signal the group so the application receives the request too.
    if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ } }
  }
  let welcomeUrl: string | undefined
  let done = false
  try {
    while (!done) {
      if (Date.now() - started > startupTimeoutMs) {
        throw new Error(`linux desktop smoke: no welcome window within ${String(startupTimeoutMs)} ms; output in ${outputFile}`)
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const diagnostic = existsSync(diagnosticFile) ? readFileSync(diagnosticFile, 'utf8') : ''
        throw new Error(`linux desktop smoke: exited during startup (${String(child.exitCode ?? child.signalCode)}): ${diagnostic || 'no startup diagnostic'}; output in ${outputFile}`)
      }
      if (existsSync(diagnosticFile)) throw new Error(`linux desktop smoke: startup failure: ${readFileSync(diagnosticFile, 'utf8')}`)
      const targets = await debuggingTargets(port)
      const welcome = targets?.find(target => target.type === 'page' && target.url?.endsWith('/renderer/welcome.html'))
      if (welcome?.url !== undefined) { welcomeUrl = welcome.url; done = true } else await sleep(500)
    }
    if (welcomeUrl === undefined) throw new Error('linux desktop smoke: welcome window missing')
    const startupMs = Date.now() - started
    const browser = await browserVersion(port)
    log(`linux desktop smoke: ${browser} opened ${welcomeUrl} after ${String(startupMs)} ms`)
    terminate()
    const code = await Promise.race([exit, sleep(exitTimeoutMs).then(() => 'timeout' as const)])
    if (code === 'timeout') {
      if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
      throw new Error(`linux desktop smoke: did not exit within ${String(exitTimeoutMs)} ms after SIGTERM; output in ${outputFile}`)
    }
    if (code !== 0) throw new Error(`linux desktop smoke: exited with ${String(code)} after SIGTERM; output in ${outputFile}`)
    flush()
    return { browser, welcomeUrl, startupMs, exitCode: 0 }
  } catch (error) {
    flush()
    terminate()
    await Promise.race([exit, sleep(5_000)])
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    process.stderr.write(output.join('').slice(-16_384))
    throw error
  } finally {
    if (child.exitCode !== null || child.signalCode !== null) rmSync(home, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: {
    executable: { type: 'string' }, xvfb: { type: 'boolean', default: false },
    'startup-timeout-ms': { type: 'string' }, 'exit-timeout-ms': { type: 'string' },
  }, allowPositionals: false })
  const result = await smokeLinuxDesktop({
    ...(values.executable === undefined ? {} : { executable: values.executable }), xvfb: values.xvfb,
    ...(values['startup-timeout-ms'] === undefined ? {} : { startupTimeoutMs: Number(values['startup-timeout-ms']) }),
    ...(values['exit-timeout-ms'] === undefined ? {} : { exitTimeoutMs: Number(values['exit-timeout-ms']) }),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
