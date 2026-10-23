/** Package terminal launch scripts that reuse the installed Electron runtime. */

import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LAUNCHERS = { darwin: 'dsh', linux: 'dsh-linux', win32: 'dsh.cmd' } as const

/**
 * Copy the platform launcher into the application's public command directory.
 * @param destination - Physical runtime/cli directory prepared for the application.
 * @param platform - Target Desktop operating system.
 */
export function prepareDesktopCli(destination: string, platform: 'darwin' | 'win32' | 'linux'): void {
  const command = join(destination, 'bin', platform === 'win32' ? 'dsh.cmd' : 'dsh')
  mkdirSync(join(destination, 'bin'), { recursive: true })
  copyFileSync(join(import.meta.dirname, '..', 'cli', LAUNCHERS[platform]), command)
  if (platform !== 'win32') chmodSync(command, 0o755)
}
