# D2R Prep Assistant · v0.2

一个本地 Windows / macOS 准备向导。使用你自己购买并导出的 **Switch 1.0.34.0（内部 3.3.94012）及资料片**文件，执行固定版本 `v2.3.0` 的上游工具，支持四大一键本地工作流。没有游戏下载、上传、账号、分析服务或本地 HTTP 服务器。存档不在处理范围内。

## 四大工作流（v0.2.0）

1. **iOS / iPadOS 26+ IPA (Metal 4)**：
   - **标准模式（A17 Pro / M1+）**：使用标准 BC 贴图，产出单独的 `.ipa` 文件。
   - **Legacy 组合包模式（A14–A16 · ≥6 GB RAM）**：自动运行 CPU ASTC 贴图转码与打包流水线，生成带有 `romfs_overlay_astc` 索引的 `.ipa` 并同时输出配对的 `Legacy Device Pack/` 文件夹。
2. **iOS / iPadOS 18–25 IPA (Metal 3)**：同样支持标准模式与 A14–A16 Legacy 组合包模式。
3. **独立 Legacy Device Pack 生成器**：
   - 使用 `astcenc 5.2.0 (--preset thorough)` + `casc_overlay.py pack` + `astc_pack.py finalize`，可直接配合社区预编译 `jiayx v2.3.0` IPA 使用。
   - 输入可为包含 `RomFS/data/` 的父文件夹或直接的 `RomFS` 文件夹（无需 `ExeFS`）。
4. **Android v2.3.0 导入包生成器 (`android/`)**：
   - 运行上游 `dm/tools/d2rm_android.py`，自动管理并从源码编译 `vk-shader-tools`（`glslc`、`spirv-opt --trim-capabilities`、`spirv-val`）。
   - 生成的 `android/` 文件夹与自备的 `RomFS/data`（含 `.build.config` 及 18 个 `.data`）一同拷入手机 `Download/S2X/D2R Mobile/` 即可配合 `D2RMobile-android.apk` 导入。

## 使用说明

1. 解压桌面助手的**完整目录**，Windows 启动 `D2RPrepAssistant.exe`，Mac 打开 `D2R Prep Assistant.app`。桌面助手没有签名或公证，不会自动绕过系统安全提示。
2. 在第一步选择目标工作流；若选择 iOS IPA，请同时选择适配设备架构（A17+/M1+ 或 A14–A16）。4 GB iPhone 13、A12Z 及低内存设备受硬件限制不被支持。
3. 选择包含 `ExeFS/{main,sdk,subsdk0}` 与 `RomFS/data/` 的文件夹（独立 Legacy Device Pack 可仅包含 `RomFS/data/`）。`data/` 中必须有 `build_manifest.psv` 与上游列出的 18 个非空 `.data` 档案。不接受 NSP/XCI/IPA、密钥或下载链接。
4. 在“环境检查”勾选明确的下载许可，点击“准备环境”。助手按所选工作流按需准备应用隔离 Python 3.12、五个固定版本与哈希的 wheel、.NET 10、LLVM-MinGW、`SPIRV-Cross (vulkan-sdk-1.4.363.0)`、`astcenc 5.2.0` 或 `vk-shader-tools`（`shaderc v2026.4` + `SPIRV-Tools 1.4.363.0` + `glslang 16.6.0`）。不改全局 PATH 或注册表。
5. 环境完成后“运行检查”。三个 ExeFS 程序核对上游 SHA-256；资源只做存在、非空、PSV 结构与引用范围检查，**不宣称完整资源密码学验证**。
6. 进入“准备与结果”，允许源码与干净壳下载，开始真实本地准备。原件从不传给上游脚本；所需文件先复制到私有工作区。包含 exFAT 兼容层（针对 `astc_pack.py finalize` 的硬链接回退与独占目录发布）。
7. 所有指导链接均指向官方指南站点 `https://d2rmobileguide.com/` 与上游工具官方页面。

界面默认简体中文，可切换 English。日志在本机，导出时隐藏已知本地路径、URL 与常见敏感字段；导出前仍请自行检查。不要分发生成的含游戏内容产物。

## 支持矩阵与固定版本

| 主机 | 四大准备工作流 (`ios26`, `ios18`, `legacy-pack`, `android`) | 原生 Mac 游戏 `.app` |
|---|---|---|
| Windows x64 | 已集成真实引擎与全量便携工具自动准备 | 不支持跨编译 |
| macOS Apple silicon | 已集成；需 Apple C/C++ 命令行工具 | 本版未实现；上游 `mac_app.sh` + Xcode 单独操作 |
| macOS Intel | 引擎入口存在；需自备兼容工具或受限运行 | 不支持 |
| Linux / Windows ARM | 仅开发测试，不是受支持的用户主机 | 不支持 |

- 固定上游版本：`jhaizhou-ops/d2r-mobile` `v2.3.0` / commit `6a3f1ee29ac6f27cd26cdd9eea1d29696106dac1`
- `PRODUCT`：`3.3.94012-r45` · `CHAIN`：`8455b2f0cc36` · `SHADER_SRC`：`be59c864f087b377` · `SPIRV_CROSS`：`1.4.363.0`

## 开发与测试

需要 Node 22+ 与 Python 3.9+。

```sh
npm test
npm run check
npm run package:win
npm run package:mac
```

详细状态见 `STATUS.json`，第三方许可见 `THIRD_PARTY_NOTICES.md` 和 `licenses/`。

MIT © @0xdcc。
