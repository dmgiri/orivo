# Orivo architecture

Orivo is an Electron desktop application with a trusted local renderer and an isolated WebContentsView for the inspected application. main.cjs owns native capabilities, process lifecycle and IPC; preload.cjs exposes the bounded bridge. Remote application pages do not receive that bridge.

## Captured route

DOM selection -> frontend source binding -> response field -> request -> backend execution -> SQL -> data origin, where supported instrumentation captured each relationship. A missing relationship remains unproven. Source hashes bind evidence to a source version.

## Modules

| Location | Responsibility |
| --- | --- |
| renderer/ | Workbench, picker controls, graph and inspectors |
| engine/ | Source analysis, graph construction and bounded AI explanation support |
| adapters/tracing/ | Frontend and backend runtime instrumentation, detection and managed setup |
| trace-store.cjs, product-store.cjs | Local captures and workspace state |
| host-security.cjs, page-runtime.cjs, session-navigation.cjs | Host boundaries, loaded runtime checks and navigation rules |
| diagram-studio.cjs, trace-to-diagram.cjs | Retained Archify presentation integration |
| vendor/ | Preserved upstream diagram and theme resources |

Managed attachment starts supported development processes with owned configuration and caches. It is not generic injection into every existing server. Manual reviewed setup can add generated integration files to a connected application. Databases and application dependencies must already exist.

The UI uses compact panes, Light / Dark appearance and system fonts. Diagram tools are accessible through the command palette. The optional local AI provider requires separately prepared model/runtime assets.

Generated files live under .tmp or evidence during development/testing and are excluded from source delivery. See [coverage](TRACING-COVERAGE.md) for evidence limits.
