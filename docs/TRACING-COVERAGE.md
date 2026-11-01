# Tracing coverage

Coverage depends on the executed code and available adapters, not the app's name or whether its URL opens.

| Area | Scope |
| --- | --- |
| Browser | DOM selection; source and response bindings require supported instrumentation |
| Frontend | React/Vite and selected Next.js client paths; supported fetch/Axios response tracking |
| Backend | Supported FastAPI/Starlette and direct Node entry paths |
| Database | Supported SQLAlchemy, psycopg, SQLite and Node/database paths; consult the adapter guide for integration details |
| Field origin | Direct mappings and selected observed transformations; executed SQL alone does not prove a selected value's column |
| Other stacks | No universal automatic support; Spring Boot/Angular and other stacks require compatible instrumentation |

Custom serializers, validators, unsupported transformations, cross-origin dependencies, closed shadow roots and canvas content can interrupt complete paths. Source edits can invalidate evidence. Only executed behavior is captured.

Frontend runtime readiness is distinct from backend, SQL and column evidence. Read Coverage details for the selected capture. Standard indexing is bounded to 5,000 files / 40 MiB / 256 KiB per file; the Large profile increases these to 25,000 files / 256 MiB / 1 MiB per file. Exclusions and other traversal limits remain.

Tests are included in test/. Run npm.cmd run check and npm.cmd test after installing dependencies. Python and native integration fixtures need their documented external environments. Run the relevant integration fixtures for each stack before making a coverage claim.

See [adapter instructions](../adapters/tracing/README.md) for supported evidence, integration steps and bounds.
