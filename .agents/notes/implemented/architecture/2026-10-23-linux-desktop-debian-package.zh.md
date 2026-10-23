# Agent Note: Ship Desktop for Ubuntu as a Debian package built on hosted runners

Status: implemented

[English](2026-10-23-linux-desktop-debian-package.md) | 中文

## Problem

Desktop 以前只打包 macOS 磁盘映像和 Windows 安装程序，各自依赖自托管 runner、机器 preset、签名硬件、腾讯 COS 更新源和强制更新策略服务。Linux 用户没有受支持的安装方式，尽管壳、内置 dsh 运行时、primary runtime 锁定文件和沙箱提供者本已能在 Linux 上运行。Linux 发布需要 Ubuntu 用户习惯的安装格式、面向 amd64 和 arm64 机器的构建，以及对包完整、最新、可安装的验证，同时不继承在 Linux 上没有对应物的发布基础设施。

## Decision

Linux 是 Desktop 发布目标，有两个固定名称 `linux-x64` 和 `linux-arm64`，与 macOS 和 Windows 共用打包流程：`build:official`、发布打包、在目标 Electron 下准备运行时、准备 dsh、electron-builder 和打包后运行时冒烟。electron-builder 的 `deb` 目标生成 `deepseek-harness-<version>-linux-<amd64|arm64>.deb`，产品安装在 `/opt/DeepSeek Harness` 下，带 `/usr/bin/deepseek-harness` alternative、注册 `x-scheme-handler/dsh` 的 `deepseek-harness.desktop` 条目、由圆角方形产品位图生成的 hicolor 图标，以及 electron-builder 的维护脚本：它们只在没有非特权用户命名空间的内核上为 Chromium 沙箱辅助程序授予 setuid 位，并在 Ubuntu 24.04 及更高版本安装 AppArmor 配置文件。Debian 版本把预发布连字符替换为 `~`，使 dpkg 将预发布版本排在正式版之前。`Depends` 列表按不带后缀的名称列出 Electron 运行时库，Ubuntu 24.04 的 `t64` 包提供这些名称。

每种架构在各自主机上原生构建：`linux-x64` 在 Linux x64 主机上，`linux-arm64` 在 Linux arm64 主机上。`Package Desktop · Linux` 工作流使用 GitHub 托管的 `ubuntu-24.04` 和 `ubuntu-24.04-arm` runner，在手动触发和 `dsh-v*` 标签时运行，通过保留的工作流产物发布，附带 `SHA256SUMS`，公开仓库还附带构建来源证明。Linux 没有自托管 runner、机器 preset 或 COS 上传。

Linux 包没有代码签名、更新源和强制更新策略。打包只读取可选的 `apps/desktop/.env.linux`（应用标识、npm registry、Debian 维护者）；`--unsigned` 和 `--skip-notarization` 会被拒绝，因为不存在需要区分的签名变体。已安装应用没有 `app-update.yml`，更新协调器因此报告已安装版本为最新，新版本通过 `apt` 或 `dpkg` 安装。维护者默认为 `.invalid` 占位地址，直到仓库变量 `DSH_DESKTOP_LINUX_MAINTAINER` 或 `.env.linux` 指明发布方。

壳在 Linux 上保留原生窗口边框和菜单栏，提供应用、文件和编辑菜单，在主窗口和欢迎窗口上绘制产品图标，在主窗口关闭时退出（Linux 没有 Dock 或托盘可供找回窗口），并通过共享的链接与回执 worker 在 `/usr/local/bin/dsh` 安装 `dsh` 命令，目录不可写时经由 `pkexec` 提权。Platform API 和更新策略请求把客户端标识为 `desktop-linux`。

## Verification

打包流程在现有载荷与 Host 冒烟之后分层验证包：`verify-linux-package.ts` 用 `dpkg-deb` 回读包，检查控制标识、root 属主且无 setuid 位、允许的安装目录、启动器可执行性、维护脚本、桌面条目、AppArmor 配置文件，以及与冒烟目录逐字节一致。工作流增加审计作业（`pnpm audit --prod --audit-level=high` 和 `check-runtime-currency.ts`，当 Electron、primary runtime 的 Node.js 或 CPython、或 pnpm 落后于上游发布线且 `config/runtime-currency.json` 中没有带日期的保留项时失败）、带有文档化 Electron 抑制项的 `lintian --fail-on error`、在 runner 上的 `apt-get install` 与移除往返，以及在 Xvfb 下启动已安装应用，直到 Host 打开欢迎窗口且进程在 SIGTERM 后干净退出。

## Alternatives considered

**用 AppImage 或 Snap 代替 Debian 包。** AppImage 需要 FUSE，且不做桌面集成和依赖解析；Snap 对 Electron 和内置运行时的限制是 Host 的子进程、终端和沙箱提供者无法容忍的。需求指明了 Ubuntu 和 `.deb`，由 apt 管理的安装让用户通过包管理器升级和移除。

**在 amd64 runner 上交叉构建 arm64。** electron-builder 能在任何主机上组装 arm64 包，但运行时准备要在目标 Electron 下安装 dsh 依赖树并运行载荷与 Host 冒烟，amd64 主机没有模拟无法执行。原生 runner 为每种发布架构保留冒烟证据。

**在 Linux 复用 Windows 标题栏外观。** 无边框 Windows 窗口和标题栏绘制的菜单最接近 Windows 版本，但窗口控件覆盖层和材质效果在各 Linux 桌面与合成器上差异很大，而原生边框和菜单栏正是 GNOME 与 KDE 应用的呈现方式。承载产品外观的 Web 内容完全相同。

**关闭窗口时隐藏到托盘。** Ubuntu 的 GNOME 需要扩展才能显示状态图标，隐藏的窗口可能无法找回。关闭即退出符合 Linux 惯例，并且仍经过感知任务的退出确认。

**把 COS 更新源和强制更新策略带到 Linux。** 两者都需要 DeepSeek 的发布基础设施以及平台特定的更新器和策略服务支持；apt 已经负责 Debian 包的升级，策略服务也没有 Linux 客户端约定。更新协调器现有的禁用状态无需新代码即可覆盖已安装应用。

**使用系统安装的 `fpm`。** electron-builder 26 会下载带校验和的 linux-amd64 和 linux-arm64v8 `fpm` 工具集，构建主机只需 `dpkg-deb`、`ar`、`xz` 和 `tar`；系统 Ruby gem 会给每个 runner 增加一条未固定版本的工具链。

## Consequences

amd64 和 arm64 上的 Ubuntu 与 Debian 用户通过 `apt` 安装 Desktop，获得完整的内置运行时、`dsh` 命令和 `dsh://` 处理程序，并通过校验和与来源证明验证包。打包流水线新增时效检查，在内置运行时落后于上游且没有经审核、带日期的保留项时使构建失败，使“保持最新”成为被强制执行的属性而不是发布时的意愿。代价是：Linux 没有应用内更新器，用户依赖 apt 或 dpkg；在拥有带签名密钥的 apt 仓库之前，Linux 包不签名；`/opt` 下的产品目录含有空格，维护脚本和启动器需要加引号；托管 arm64 runner 只对公开仓库免费，私有分支必须提供自己的 arm64 runner 标签。
