/** Debian copyright file for the Linux package, rendered from the repository license. */

/** Installed path of the machine-readable copyright file dpkg and lintian expect for every package. */
export declare const LINUX_COPYRIGHT_PATH: string

/**
 * Render a copyright-format 1.0 file whose single stanza carries the repository license.
 * @param licenseText - Complete text of the repository LICENSE file; its `Copyright` line becomes the holder.
 * @param product - Upstream name, source URL, and SPDX license identifier.
 * @returns File content ending with one newline.
 */
export declare function renderDebianCopyright(licenseText: string, product: { name: string; homepage: string; license: string }): string
