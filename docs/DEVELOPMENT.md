# Development

Use Node.js 24.13 or newer. Run commands from the project root.

~~~powershell
npm.cmd ci
npm.cmd start
npm.cmd run check
npm.cmd test
~~~

Native Electron checks and Python/database fixtures have additional environment requirements. Consult each test script before running it. Capture fresh verification results for changes; do not treat test counts as fixed product claims.

## Project structure

renderer/ contains the workbench; engine/ builds evidence graphs; adapters/tracing/ provides instrumentation. Tests are under test/. Vendor resources and their notices must remain intact. See [architecture](ARCHITECTURE.md).

## Generated files

node_modules, .tmp, evidence, dist and optional model/runtime assets are generated locally and excluded from version control. Do not add connected application credentials or database files to this project.

## Packaging

npm.cmd run pack:source creates a source package without the offline AI model. npm.cmd run build:win currently requires installed Electron and verified local AI assets; a model-free executable build is not implemented. Prepare optional assets only when needed using the [AI setup guide](../resources/ai/README.md). No executable distribution is included in this project.

## Theme motion

Light / Dark reveals the theme from top-right to bottom-left over 780 ms. Speed phases follow elapsed time: slow from 0–20%, medium from 20–60%, then fast from 60–100%. The wave radius reaches 6% at the first boundary and 42% at the second, using linear(0, .06 20%, .42 60%, 1). The crest and reveal stay synchronized. Soft highlights, shadows and two trailing ripples give depth. Rapid input keeps the latest choice; reduced motion applies the theme immediately. Run npm.cmd run test:theme-wave to verify the phases and interaction behavior.
