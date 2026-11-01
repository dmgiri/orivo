# Third-party notices

Orivo source includes third-party resources and declares runtime dependencies as listed below. Electron and optional AI binaries are not installed in this source project. The application itself is currently marked `UNLICENSED`; this file does not grant a license to Orivo's original source code.

| Component | Notice location in a future Windows distribution |
| --- | --- |
| Electron 44.7.0 | `LICENSE` in the distribution root (MIT, Electron contributors and GitHub Inc.) |
| Chromium, Node.js, and components bundled by Electron | `LICENSES.chromium.html` in the distribution root |
| Babel parser bundled with the tracing adapters | `resources/app/adapters/tracing/parser-LICENSE.txt` (MIT) |
| Archify 3.2.0, GitHub commit `a4065941f12be7967436261d9934784e381d423c` | Original files in `resources/app/vendor/archify/`, including `LICENSE` (Apache-2.0), `NOTICE`, historical `LICENSE-MIT`, and `THIRD_PARTY_NOTICES.md` |
| Microsoft VS Code 2026 theme sources, commit `97d01924531421f671b69342f629ba0f9f0f1e2e` | Original theme JSON and MIT license in `resources/app/vendor/vscode-themes/`; `source.json` identifies the upstream revision |
| llama.cpp b11852 CPU runtime | `resources/app/resources/ai/licenses/LLAMA-CPP-LICENSE.txt` (MIT) |
| Qwen3-4B Q4_K_M model | `resources/app/resources/ai/licenses/QWEN-LICENSE.txt` (Apache-2.0); model file in `resources/app/model/` |

Installing Electron supplies its runtime notices. A future packaged distribution must preserve them. Playwright is development tooling.

Archify is sourced from https://github.com/tt-a1i/archify at the pinned commit above. Its distribution is preserved byte-for-byte; `vendor/archify-manifest.json` records the origin, revision and SHA-256 of every imported file. Orivo's diagram service, UI integration, trace projection and global theme mapping are separate additions outside that directory. Theme values in `renderer/archify-theme-data.js` are extracted from the original template; color token adaptation for Orivo does not modify Archify. Upstream brand-mark, font and historical license notices remain included. No sponsorship or endorsement is implied.

VS Code theme data is from https://github.com/microsoft/vscode. `renderer/vscode-theme-data.js` resolves the original 2026 themes and inherited defaults; `renderer/themes.js` maps those colors to Orivo. Segoe UI and Consolas are referenced as installed system fonts and are not redistributed. The original Microsoft theme sources and license remain included.

Local AI assets are optional and absent from this source-only delivery. The retained preparation script verifies pinned official model/runtime assets before use. License texts remain under resources/ai/licenses; retaining these texts does not mean the model or runtime is bundled.

Upstream projects: <https://www.electronjs.org/>, <https://www.chromium.org/>, <https://nodejs.org/>, <https://babeljs.io/>, <https://github.com/ggml-org/llama.cpp>, <https://huggingface.co/Qwen/Qwen3-4B-GGUF>.
