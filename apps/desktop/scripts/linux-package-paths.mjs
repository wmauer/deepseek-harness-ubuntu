/** Fixed names shared by the Linux electron-builder configuration, smoke checks and package verification. */

/** Executable installed below the product directory and linked from `/usr/bin`. */
export const LINUX_EXECUTABLE_NAME = 'deepseek-harness'

/** Debian package name; apt and dpkg address the installation by it. */
export const LINUX_PACKAGE_NAME = 'deepseek-harness'

/** Directory electron-builder installs below `/opt`, derived from the product name. */
export const LINUX_PRODUCT_DIRECTORY = 'DeepSeek Harness'

/** Absolute installation root of the packaged application. */
export const LINUX_INSTALL_ROOT = `/opt/${LINUX_PRODUCT_DIRECTORY}`

/** Desktop entry filename, which Electron also uses as its application id. */
export const LINUX_DESKTOP_NAME = `${LINUX_EXECUTABLE_NAME}.desktop`

/**
 * Map a Node.js architecture to the Debian architecture electron-builder writes into deb names and control files.
 * @param {'x64' | 'arm64'} arch - Target architecture.
 * @returns {'amd64' | 'arm64'} Debian architecture.
 */
export function debianArchitecture(arch) {
  switch (arch) {
    case 'x64': return 'amd64'
    case 'arm64': return 'arm64'
    default: throw new Error(`desktop package: unsupported Linux architecture ${String(arch)}`)
  }
}

/**
 * Name the unpacked application directory electron-builder writes beside the package.
 * @param {'x64' | 'arm64'} arch - Target architecture.
 * @returns {string} Directory name below the artifacts directory.
 */
export function linuxUnpackedDirectory(arch) {
  debianArchitecture(arch)
  return arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`
}

/**
 * Name the Debian package one build writes.
 * @param {string} version - Published build version.
 * @param {'x64' | 'arm64'} arch - Target architecture.
 * @returns {string} Package filename below the artifacts directory.
 */
export function linuxPackageFilename(version, arch) {
  return `deepseek-harness-${version}-linux-${debianArchitecture(arch)}.deb`
}
