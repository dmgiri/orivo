# Optional local AI assets

Offline AI assets are **not included** in the Orivo source project. Prepare the model, runtime binaries and asset manifest separately when local AI is needed. AI Explain needs those assets; tracing does not.

To restore them intentionally, run npm.cmd run prepare:ai from the project root after installing dependencies. This downloads the pinned Qwen3-4B Q4_K_M model (about 2.5 GB) and llama.cpp Windows x64 CPU runtime and verifies integrity. The model is written under model/ and runtime resources under resources/ai/. These generated assets are excluded from version control.

The provider starts an owned local llama-server when used and stops it on shutdown. There is no bundled model or automatic model download during normal application startup in the source project. The release builder currently requires prepared assets.

Retained license texts describe the optional upstream assets: Qwen (Apache-2.0) and llama.cpp (MIT). They do not indicate the binaries are installed. See engine/ai-assets.cjs for pinned asset identities and scripts/prepare-local-ai.mjs for preparation.
