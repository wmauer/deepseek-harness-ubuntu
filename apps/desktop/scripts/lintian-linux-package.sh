#!/usr/bin/env bash
# Lint one Debian package with lintian, failing on errors the package can fix.
#
# Suppressed tags are properties of every self-contained Electron application rather than defects:
#   dir-or-file-in-opt            electron-builder installs the application under /opt, like Chrome and VS Code.
#   embedded-library              Chromium, Node.js, CPython, and their libraries are bundled by design.
#   unstripped-binary-or-object   Upstream binaries keep their symbol tables; the package does not rebuild them.
#   statically-linked-binary      The bundled CPython and native tools are built as relocatable archives.
#   shared-library-lacks-prerequisites, library-not-linked-against-libc
#                                 Private libraries resolve inside the bundle, not through the system linker.
#   non-standard-dir-perm, non-standard-file-perm, shared-library-is-executable
#                                 The runtime directory keeps upstream permissions; the maintainer script owns the sandbox bit.
#   python3-script-but-no-python3-dep, missing-dep-for-interpreter
#                                 Scripts inside the bundled runtime run under the bundled Node.js and CPython, not system interpreters.
#   shell-script-fails-syntax-check
#                                 python-build-standalone ships sh/Python polyglot launchers in its bin directory.
#   package-installs-python-pycache-dir
#                                 The bundled CPython standard library keeps its precompiled bytecode for startup time.
#   custom-library-search-path    python-build-standalone's Tcl/Tk libraries carry their build RPATH; they load from the bundle.
set -euo pipefail
package=${1:?package path}
report=${2:-}
suppressed=dir-or-file-in-opt,embedded-library,unstripped-binary-or-object,statically-linked-binary,shared-library-lacks-prerequisites,library-not-linked-against-libc,non-standard-dir-perm,non-standard-file-perm,shared-library-is-executable,python3-script-but-no-python3-dep,missing-dep-for-interpreter,shell-script-fails-syntax-check,package-installs-python-pycache-dir,custom-library-search-path
status=0
output=$(lintian --fail-on error --suppress-tags "$suppressed" --no-tag-display-limit --info "$package" 2>&1) || status=$?
printf '%s\n' "$output"
if [ -n "$report" ]; then printf '%s\n' "$output" > "$report"; fi
exit "$status"
