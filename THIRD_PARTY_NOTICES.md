# Third-party notices

- D2R Prep Assistant (v0.2.0): MIT, Copyright (c) 2026 @0xdcc; see LICENSE.
- Electron 44.9.0: MIT; see licenses/Electron-LICENSE.txt. Packaged runtimes include their own LICENSE and LICENSES.chromium.html for Chromium, Node, V8 and other runtime components. Retain those files with the entire desktop helper.
- @electron/packager 20.3.0: BSD-2-Clause; see licenses/electron-packager-LICENSE.txt. Development/build dependency, not shipped as an app runtime dependency. npm lock records official registry provenance.
- d2r-mobile, jhaizhou-ops/d2r-mobile, pinned v2.3.0 / 6a3f1ee29ac6f27cd26cdd9eea1d29696106dac1: MIT, Copyright (c) 2026 jhaizhou; see licenses/d2r-mobile-MIT.txt. Clean shells and source are downloaded only after consent, not bundled. Their source includes further third-party notices (including Ryujinx, BCDec and SPIR-V components); retain the original source licenses in app-managed extraction. Game assets are not licensed or supplied by this helper.

Optional app-owned tool acquisition is not SDK/compiler redistribution inside the helper bundle. Downloads preserve upstream license files:
- CPython standalone (Python-2.0 plus its bundled dependency licenses)
- .NET SDK 10 (MIT plus third-party notices)
- LLVM-MinGW (Apache-2.0 WITH LLVM-exception and mingw-w64 licenses)
- CMake (BSD-3-Clause and component notices)
- Ninja (Apache-2.0)
- SPIRV-Cross vulkan-sdk-1.4.363.0 (Apache-2.0)
- ARM astc-encoder 5.2.0 (Apache-2.0)
- Google shaderc v2026.4 (Apache-2.0)
- Khronos SPIRV-Tools vulkan-sdk-1.4.363.0 (Apache-2.0)
- Khronos SPIRV-Headers vulkan-sdk-1.4.363.0 (MIT)
- Khronos glslang 16.6.0 (BSD-3-Clause)
- Python wheels retain dist-info license metadata: Pillow (HPND), NumPy (BSD-3-Clause and bundled library notices), lz4 (BSD-3-Clause and LZ4 notices), Capstone (BSD), Unicorn (GPL-2.0 plus component licenses).

Review those upstream licenses before redistributing modified tools or game-generated outputs; this assistant neither grants game rights nor publishes user outputs.

Signing applications and Apple accounts/certificates are separate. No endorsement by Blizzard, Nintendo, Apple, Microsoft, ARM, Khronos, Google, Python, Electron or signing-tool authors is implied.
