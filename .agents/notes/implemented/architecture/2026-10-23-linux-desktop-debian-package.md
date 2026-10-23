# Agent Note: Ship Desktop for Ubuntu as a Debian package built on hosted runners

Status: implemented

English | [中文](2026-10-23-linux-desktop-debian-package.zh.md)

## Problem

Desktop packaged only macOS disk images and Windows installers, each on a self-hosted runner with machine presets, signing hardware, a Tencent COS update feed, and a mandatory-update policy service. Linux users had no supported installation, although the shell, the bundled dsh runtime, the primary runtime lock, and the sandbox provider already ran on Linux. A Linux release needs an installation format that Ubuntu users expect, builds for both amd64 and arm64 machines, and verification that the package is complete, current, and installable, without inheriting release infrastructure that has no Linux equivalent.

## Decision

Linux is a Desktop release target with two fixed names, `linux-x64` and `linux-arm64`, sharing the macOS and Windows packaging sequence: `build:official`, release packing, runtime preparation under the target Electron, dsh preparation, electron-builder, and the packaged runtime smoke. electron-builder's `deb` target produces `deepseek-harness-<version>-linux-<amd64|arm64>.deb` with the product installed under `/opt/DeepSeek Harness`, an `/usr/bin/deepseek-harness` alternative, a `deepseek-harness.desktop` entry that registers `x-scheme-handler/dsh`, hicolor icons from the rounded-square product bitmap, and electron-builder's maintainer scripts, which grant the Chromium sandbox helper the setuid bit only on kernels without unprivileged user namespaces and install an AppArmor profile on Ubuntu 24.04 and later. The Debian version replaces prerelease hyphens with `~` so dpkg orders prereleases below their release. The `Depends` list names the Electron runtime libraries by their unsuffixed names, which Ubuntu 24.04's `t64` packages provide.

Each architecture builds natively on its own host: `linux-x64` on a Linux x64 host and `linux-arm64` on a Linux arm64 host. The `Package Desktop · Linux` workflow uses GitHub-hosted `ubuntu-24.04` and `ubuntu-24.04-arm` runners, runs on manual dispatch and `dsh-v*` tags, and publishes through retained workflow artifacts with `SHA256SUMS` and, for public repositories, a GitHub artifact attestation. No self-hosted runner, machine preset, or COS upload exists for Linux.

Linux packages carry no code signature, no update feed, and no mandatory-update policy. Packaging reads only the optional `apps/desktop/.env.linux` (application identifier, npm registry, Debian maintainer); `--unsigned` and `--skip-notarization` are rejected because there is no signed variant to distinguish from. The installed application has no `app-update.yml`, so the update coordinator reports the installed version as current, and new versions install through `apt` or `dpkg`. The maintainer defaults to a `.invalid` placeholder address until the `DSH_DESKTOP_LINUX_MAINTAINER` repository variable or `.env.linux` names the publisher.

The shell keeps the Linux native window frame and menu bar with Application, File, and Edit menus, draws the product icon on the main and welcome windows, quits when the main window closes because Linux has no Dock or tray to return from, and installs the `dsh` command at `/usr/local/bin/dsh` through the shared link-and-receipt worker, elevating through `pkexec` when the directory is not writable. Platform API and update-policy requests identify the client as `desktop-linux`.

## Verification

The packaging sequence verifies the package in layers after the existing payload and Host smoke: `verify-linux-package.ts` reads the package with `dpkg-deb` and checks control identity, root ownership without setuid bits, allowed install directories, launcher executability, maintainer scripts, the desktop entry, the AppArmor profile, and byte-for-byte parity with the smoke-tested directory. The workflow adds an audit job (`pnpm audit --prod --audit-level=high` and `check-runtime-currency.ts`, which fails when Electron, the primary-runtime Node.js or CPython, or pnpm is behind its upstream line without a dated hold in `config/runtime-currency.json`), `lintian --fail-on error` with documented Electron suppressions, an `apt-get install` and remove round trip on the runner, and an Xvfb launch of the installed application until the Host opens the welcome window and the process exits cleanly on SIGTERM.

## Alternatives considered

**AppImage or Snap instead of a Debian package.** AppImage needs FUSE and skips desktop integration and dependency resolution; Snap confines Electron and the bundled runtime in ways the Host's subprocess, terminal, and sandbox providers do not tolerate. The request named Ubuntu and a `.deb`, and apt-managed installation gives users upgrades and removal through their package manager.

**Cross-building arm64 on an amd64 runner.** electron-builder can assemble an arm64 package on any host, but runtime preparation installs the dsh dependency tree and runs the payload and Host smoke under the target Electron, which an amd64 host cannot execute without emulation. Native runners keep the smoke evidence for every shipped architecture.

**Reusing the Windows caption chrome on Linux.** The frameless Windows window with caption-drawn menus would look closest to the Windows build, but window-control overlays and vibrancy vary across Linux desktops and compositors, while a native frame and menu bar is what GNOME and KDE applications present. The Web content, which carries the product look, is identical.

**Hiding to a tray on window close.** Ubuntu's GNOME needs an extension for status icons, so a hidden window could become unreachable. Quitting on close follows the Linux convention and still passes through the task-aware quit confirmation.

**Carrying the COS update feed and mandatory-update policy to Linux.** Both require DeepSeek's release infrastructure and platform-specific updater and policy service support; apt already owns upgrades for a Debian package, and the policy service has no Linux client contract. The update coordinator's existing disabled state covers the installed application without new code.

**Pinning a bundled `fpm` from the system.** electron-builder 26 downloads a checksummed `fpm` toolset for linux-amd64 and linux-arm64v8, so the build host needs only `dpkg-deb`, `ar`, `xz`, and `tar`; a system Ruby gem would add an unpinned toolchain to every runner.

## Consequences

Ubuntu and Debian users on amd64 and arm64 install Desktop with `apt`, receive the full bundled runtime, the `dsh` command, and the `dsh://` handler, and verify packages through checksums and artifact attestations. The package pipeline gains a currency check that fails builds whose bundled runtimes fall behind upstream unless a reviewed, dated hold exists, which keeps "up to date" an enforced property rather than a release-time intention. The costs: Linux has no in-app updater, so users rely on apt or dpkg; Linux packages are unsigned until an apt repository with a signing key exists; the product directory under `/opt` contains a space, which the maintainer scripts and launcher quote; and hosted arm64 runners are free for public repositories only, so private forks must supply their own arm64 runner label.
