/** Environment variable that supplies the Debian `Maintainer` field as `Name <address>`. */
export const LINUX_MAINTAINER_ENV: 'DSH_DESKTOP_LINUX_MAINTAINER'

/** Maintainer recorded when no configuration names the publisher; its `.invalid` domain marks a placeholder. */
export const DEFAULT_LINUX_MAINTAINER: string

/**
 * Resolve the identity fields written into the Debian control file.
 * @param env - Linux packaging settings.
 * @returns Validated `Name <address>` maintainer.
 */
export function resolveLinuxPackageSettings(env: NodeJS.ProcessEnv): { readonly maintainer: string }
