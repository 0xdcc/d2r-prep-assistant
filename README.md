# D2R Prep Assistant · v0.1

一个本地 Windows / macOS 准备向导。使用你自己购买并导出的 **Switch 1.0.34.0（内部 3.3.94012）及资料片**文件，执行固定版本的上游工具，准备供你单独签名的 IPA。没有游戏下载、上传、账号、分析服务或本地 HTTP 服务器。存档不在处理范围内。

## 使用

1. 解压桌面助手的**完整目录**，Windows 启动 `D2RPrepAssistant.exe`，Mac 打开 `D2R Prep Assistant.app`。桌面助手没有签名或公证，不会自动绕过系统安全提示。
2. 选择 iOS 18 或 iOS 26、支持 BC 贴图的新设备与独立输出文件夹。A14–A16 Legacy 贴图流程、iPhone 13 4GB、A12Z 不在本版支持范围。
3. 选择包含 `ExeFS/main`、`ExeFS/sdk`、`ExeFS/subsdk0` 和 `RomFS/data` 的父文件夹。`data` 中必须有 `build_manifest.psv` 与上游列出的 18 个非空 `.data` 档案。更多清单引用的 `.data` 也必须齐全。不接受 NSP/XCI/IPA、密钥或下载链接。
4. 在“环境检查”勾选明确的下载许可，点击“准备环境”。下载固定发布者、版本、大小与哈希的便携工具及五个 Python wheel，最多两线程构建 SPIRV-Cross。不需要你安装 pip，不改全局 PATH 或注册表。Mac 若缺 Apple Command Line Tools，需自行通过 Apple 的 `xcode-select --install` 提示安装；助手不会执行提权安装器或 Homebrew 脚本。
5. 环境完成后重新“运行检查”。三个 ExeFS 程序核对上游 SHA-256；资源只做存在、非空、PSV 结构与引用范围检查，**不宣称完整资源密码学验证**。上游没有公布全部资源档案的预期哈希。实际生成时，上游继续检查其使用的派生产物、程序规则和着色器源摘要。
6. 进入“准备与结果”，允许源码、干净壳下载与上游 .NET 首次 NuGet 恢复，开始真实本地准备。原件从不传给上游脚本；所需文件先复制到私有工作区。随时可取消。只有进程退出 0、产物结构/元数据/CRC 全部通过后，才发布唯一命名的 IPA，显示路径及 SHA-256。
7. 使用独立签名工具签名。固定入口可打开 Sideloadly 官方网页，不读取 Apple ID，也不承诺免费永久证书。**IPA 不包含完整游戏资源档案**；仍需自行将那 18 个 `.data` 拷进手机 App 文件夹。无 Metal 路线在手机首次启动时编译着色器。

界面默认简体中文，可切换 English。日志在本机，导出时隐藏已知本地路径、URL 与常见敏感字段；导出前仍请自行检查。不要分发生成的含游戏内容产物。

## 支持矩阵与限制

| 主机 | iOS 18 / 26 IPA 准备 | 原生 Mac 游戏 `.app` |
|---|---|---|
| Windows x64 | 已集成真实引擎与便携工具自动准备 | 不支持跨编译 |
| macOS Apple silicon | 已集成；需 Apple C/C++ 命令行工具 | 本版未实现；上游 `mac_app.sh` + Xcode 单独操作 |
| macOS Intel（可选助手包） | 引擎入口存在；本版无 x64 Python wheel/便携工具锁，自动准备受限 | 不支持 |
| Linux / Windows ARM | 仅开发测试，不是受支持的用户主机 | 不支持 |

固定源码为 `jhaizhou-ops/d2r-mobile` 的 `v1.0.17` / commit `9de307ecaff42b3c9d45e58992c848ee89b8f6a1`，PRODUCT `3.3.94012-r44`。两个干净壳均有真实独立 SHA-256 固定值。清单在 `manifests/`；没有虚构 `main.npdm` 要求或 JSON 游戏输出清单。输出核对实际 `dm/pack_info.txt` 的 PRODUCT，壳的 CHAIN/KIND/SHADER_SRC/SPIRV_CROSS，Info.plist、Mach-O、Guest.framework 和完整壳清单。

缓存位置：Windows `%LOCALAPPDATA%/D2RPrepAssistant`；Mac `~/Library/Application Support/D2R Prep Assistant`。子进程的临时目录、HOME、NuGet、DM_ROOT 都在私有工作区/应用缓存。首次便携工具下载约 0.8–1 GB；游戏输入复制、上游中间产物和输出需要额外数十 GB，预检按实际输入与缓存余量检查。上游打包完成后的作业工作区清理，已验证下载和工具可复用；失败不缓存未验证下载。上游自己的生成过程是否可断点续跑由其工具决定，本版不跨作业保留游戏派生缓存。

网络仅用于用户明确同意的固定发布者依赖。源码/壳/工具/wheel 下载均手动核查重定向、流式大小限制与哈希，`.part` 完成前不解压或执行。打包器自身的 NuGet 恢复依赖 .NET 官方机制；这不是一份完整的离线 NuGet 供应链锁。没有任意 URL/代理/命令输入。安全解压禁止路径穿越、特殊文件、重复/大小写冲突，并限制文件数与展开量。默认拒绝链接；固定 Python Mac 归档的内部链接只物化成普通副本，不创建链接。Mac CMake 仅提取 CLI 与配套数据，排除 Qt GUI 框架。

## 开发与打包

需要 Node 22+，测试机需要 Python 3.9+（这里只用于测试 ZIP 协议，不是 Windows 用户的启动前提）。依赖已精确锁定；首次开发安装使用 `npm ci --ignore-scripts --registry=https://registry.npmjs.org`，不自动执行 Electron 安装脚本。

```sh
npm test
npm run check
npm run review:runtime -- win32 x64
npm run review:runtime -- darwin arm64
npm run package:win
npm run package:mac
```

打包读取 `.cache/electron` 中校验过的官方运行时；缺少时可能需要联网。运行时准备不会全局安装或自动启动 Electron。打包输出在 `artifacts/`，不包含 `evidence/`、测试、源码缓存、工具 SDK、游戏文件、`node_modules` 或开发日志。保留整个运行时目录，Mac bundle 的权限/链接结构不要用不支持它们的压缩工具破坏。构建脚本不签名、不公证、不上传、不发布。网络被沙箱拒绝时保留真实错误，由有权限的父进程补全运行时缓存；不修改代理或全局配置。

## 验证范围

测试只使用明确标记的合成**协议**样例和真实公开源码/干净壳，涵盖拒绝错误游戏版本、资源范围、归档穿越/链接、下载损坏与重定向、输出不覆盖、中文空格路径、子进程失败/取消、IPC 与生产界面事件。协议样例不是游戏、可玩 IPA 或成功游戏构建，不会随包分发。可选真实公开归档测试在本地缺少父进程证据时明确跳过。

父进程已在真实 Windows Electron 中验过中英界面、步骤导航、受限 preload/IPC；实际应用环境引擎完成了私有 Python、五模块、.NET 10、LLVM 和 SPIRV-Cross 的准备与二次缓存复用，私有 Python 子进程也成功寻找到这三项原生工具。工具归档由父进程预先下载并核验发布者哈希，因此这不等于未缓存网络的全流程测试。41 项回归测试通过，无跳过；涵盖 Windows 长路径、取消清理、外接盘不支持硬链接的回退与成品恢复。**这些仍不等于游戏端到端构建。** 本次无自有游戏文件，无真实 Mac：游戏构建、手机运行、Mac 原生执行均未测试。详细状态见 `STATUS.json`。

MIT © @0xdcc。上游与运行时许可见 `THIRD_PARTY_NOTICES.md` 和 `licenses/`。
