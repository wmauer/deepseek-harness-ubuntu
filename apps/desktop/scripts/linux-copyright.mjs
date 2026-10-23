/** Debian copyright file for the Linux package, rendered from the repository license. */

import { LINUX_PACKAGE_NAME } from './linux-package-paths.mjs'

/** Installed path of the machine-readable copyright file dpkg and lintian expect for every package. */
export const LINUX_COPYRIGHT_PATH = `/usr/share/doc/${LINUX_PACKAGE_NAME}/copyright`

/**
 * Render a copyright-format 1.0 file whose single stanza carries the repository license.
 * @param {string} licenseText - Complete text of the repository LICENSE file; its `Copyright` line becomes the holder.
 * @param {{ name: string, homepage: string, license: string }} product - Upstream name, source URL, and SPDX license identifier.
 * @returns {string} File content ending with one newline.
 */
export function renderDebianCopyright(licenseText, product) {
  const lines = licenseText.replace(/\r\n/gu, '\n').trimEnd().split('\n')
  const holder = lines.find(line => /^Copyright\b/u.test(line))
  if (holder === undefined) throw new Error('linux package: the repository LICENSE names no copyright holder')
  const body = lines.map(line => (line.trim() === '' ? ' .' : ` ${line}`)).join('\n')
  return [
    'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/',
    `Upstream-Name: ${product.name}`,
    `Source: ${product.homepage}`,
    'Comment: Bundled components (Electron, Chromium, Node.js, CPython, and npm packages) keep their own',
    ' license files inside the installed application directory.',
    '',
    'Files: *',
    `Copyright: ${holder.replace(/^Copyright\s*(?:\(c\)|©)?\s*/iu, '')}`,
    `License: ${product.license}`,
    body,
    '',
  ].join('\n')
}
