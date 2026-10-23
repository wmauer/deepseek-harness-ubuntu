/** Resolve the Debian control identity fields the Linux packaging configuration supplies. */

/** Environment variable that supplies the Debian `Maintainer` field as `Name <address>`. */
export const LINUX_MAINTAINER_ENV = 'DSH_DESKTOP_LINUX_MAINTAINER'

/**
 * Maintainer recorded when no configuration names the publisher. The reserved `.invalid` domain
 * marks the address as a placeholder rather than a reachable mailbox.
 */
export const DEFAULT_LINUX_MAINTAINER = 'DeepSeek Harness <noreply@deepseek-harness.invalid>'

const MAINTAINER = /^[^<>\r\n]+\S <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/u

/**
 * Resolve the identity fields written into the Debian control file.
 * @param {NodeJS.ProcessEnv} env - Linux packaging settings.
 * @returns {{ maintainer: string }} Validated `Name <address>` maintainer.
 */
export function resolveLinuxPackageSettings(env) {
  const configured = env[LINUX_MAINTAINER_ENV]?.trim()
  const maintainer = configured === undefined || configured === '' ? DEFAULT_LINUX_MAINTAINER : configured
  if (!MAINTAINER.test(maintainer)) {
    throw new Error(`desktop package: ${LINUX_MAINTAINER_ENV} must be "Name <address>" with one email address`)
  }
  return { maintainer }
}
