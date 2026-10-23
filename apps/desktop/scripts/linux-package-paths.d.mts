/** Executable installed below the product directory and linked from `/usr/bin`. */
export const LINUX_EXECUTABLE_NAME: 'deepseek-harness'

/** Debian package name; apt and dpkg address the installation by it. */
export const LINUX_PACKAGE_NAME: 'deepseek-harness'

/** Directory electron-builder installs below `/opt`, derived from the product name. */
export const LINUX_PRODUCT_DIRECTORY: 'DeepSeek Harness'

/** Absolute installation root of the packaged application. */
export const LINUX_INSTALL_ROOT: string

/** Desktop entry filename, which Electron also uses as its application id. */
export const LINUX_DESKTOP_NAME: string

/**
 * Map a Node.js architecture to the Debian architecture electron-builder writes into deb names and control files.
 * @param arch - Target architecture.
 * @returns Debian architecture.
 */
export function debianArchitecture(arch: 'x64' | 'arm64'): 'amd64' | 'arm64'

/**
 * Name the unpacked application directory electron-builder writes beside the package.
 * @param arch - Target architecture.
 * @returns Directory name below the artifacts directory.
 */
export function linuxUnpackedDirectory(arch: 'x64' | 'arm64'): string

/**
 * Name the Debian package one build writes.
 * @param version - Published build version.
 * @param arch - Target architecture.
 * @returns Package filename below the artifacts directory.
 */
export function linuxPackageFilename(version: string, arch: 'x64' | 'arm64'): string
