# Orivo development tracing kit

This self-contained development kit implements Orivo's captured tracing
protocol. It has no dependency on another local app.
The package name is `@orivo/tracing`; protocol names `STUDIO_TRACE`,
`__studioElementFlowV1`, `X-Studio-Trace` and `Studio-Trace` remain compatible with
already instrumented applications. The Python distribution is `orivo-tracing`; its import remains `studio_tracing` for compatibility. The parser bundle includes its license.

Choose a project folder in Orivo and select **Attach tracing** to start a
supported application with instrumentation supplied by Orivo. No application
hooks, source edits, manifest changes or dependency installations are required
for the managed paths below. Opening an existing URL alone does not instrument
its already-running server. The built-in demo has an explicit integration and
a real Node SQLite request/query path.

## Supported evidence

Managed React/Vite source instrumentation automatically connects default Axios
imports and clients created with `axios.create()`. Both Axios XHR and fetch
transports associate the actual parsed response object with its request; no
application interceptor or fetch-adapter setting is required. Authentication
paths and cross-origin responses remain excluded. Custom interceptors which
replace data with newly constructed objects may lose field identity.

Instrumented Python code supports standard Pydantic v2
`ResponseModel.model_validate(orm_object)` with `from_attributes=True`, including
unchanged scalar fields beside computed fields. Computed fields do not acquire
column origins. Custom validators/serializers and callback-based enum schemas
remain unsupported. SQLAlchemy async query source locations follow the actual
greenlet parent frames, with the same source freshness checks as synchronous
queries.

| Adapter | Captured evidence | Limits |
| --- | --- | --- |
| Managed React / Vite 5–8 | Intrinsic JSX source bindings, supported component props/children and lexical aliases, selected-element React component ancestry with matched source locations, supported JSON collection transformations, same-origin JSON response fields | Installed project dependencies and a local API proxy; original source hashes must match. Runtime component ancestry is available only when React exposes development metadata; transformed source locations still need source-map verification. Unsupported mutation, asynchronous transformations and custom collection methods remain unproven. |
| Managed Next.js 16 / Webpack | Client JSX bindings and same-origin JSON response fields, with original source paths/hashes | Profile source mirror; no Turbopack, SSR/RSC, server actions, server components or server-side fetch provenance. |
| Framework-neutral browser | Explicit DOM binding, request correlation and response fields | Integrator supplies original source site/hash and binding calls. |
| Managed Node HTTP / Express-compatible server | Correlated request context, source/query evidence, direct SQLite and `pg` result-row origins | Node 24.13+, a detected direct entry and one HTTP listener; copied/computed fields remain unproven. |
| Node built-in SQLite | Executed SQL and direct result-column origin | Managed preload tracks unchanged result-row identities; advanced manual integration can use explicit `result.field()` mappings. |
| Managed FastAPI / Starlette | Correlated request, Python source, SQLAlchemy query execution, mapped model/field declarations; supported FastAPI response-model/DTO origins and frozen numeric DTO calculations | Existing project virtual environment; discoverable SQLAlchemy objects and current registered model source. Mutable DTO/dictionary computations and custom serialization remain unproven. |
| Advanced manual Node / Python adapters | Explicit request/query and direct response-field mappings, including Python psycopg | Integrator supplies the documented setup and field mappings. |

Only same-origin requests are supported. Proxy the backend through the frontend
origin. Authentication endpoints are excluded by the automatic browser adapter.
Never enable these adapters in production. Values, request bodies, cookies and
database credentials are unnecessary for the trace graph.

## Automatic attachment in Orivo

1. Choose the development project's source folder.
2. Select **Attach tracing** (or **Attach automatically** in Open project).
3. Select a detected frontend/backend only if the repository contains several
   candidates. Orivo starts its own traced session and opens the ready preview.
4. Use **Select an element** to inspect the captured path. **Stop session** stops
   only the processes Orivo started.

Detection reads bounded manifests and source files without importing the app.
Launch configuration, adapter activation and compiler caches live in Orivo's
profile outside the connected folder. The frontend runner loads the existing
Vite configuration in memory, injects tracing before source transforms, and
retargets an existing local API proxy to the managed backend. No commands need
to be copied and no tracing dependency needs to be added to the project.
Multiple ambiguous API proxy targets or missing dependencies are reported.
The existing development database and application environment must be usable.

Next.js 16 attachment uses the installed framework in Webpack development mode
with a source mirror in Orivo's profile. Original application files,
`next.config.*`, `tsconfig.json` and `next-env.d.ts` remain unchanged. Next's
generated output and TypeScript setup changes stay in that mirror. Client
binding metadata maps mirrored files back to their original paths and hashes;
the host verifies those original bytes before claiming a captured connection.
Existing local backend rewrites are retargeted for the owned session.

The mirror and its watched updates are bounded to 50,000 files/256 MiB and omit
sensitive/data files. Application source symlinks and external tsconfig
references/source layouts outside the focused frontend are unsupported. Normal
source edits update the mirror and trigger HMR; configuration, environment and
TypeScript setup edits require a session restart. A source guard is preloaded
before original configuration evaluation and into child workers, protecting
normal filesystem mutations of the original project while allowing profile
output. This guards framework integrity rather than sandboxing malicious code
or native addons. Next capture covers client DOM and same-origin JSON requests;
it does not trace SSR/RSC, server components/actions or server-side fetch.

Python discovery recognizes FastAPI/Starlette objects and conventional factories
with an existing `.venv`/`venv`, including backend/src layouts. The owned Python
bootstrap installs import instrumentation before application imports, preserves
the app's lifespan, then finds SQLAlchemy engines/sessions in loaded project
modules and `app.state` through bounded ordinary object dictionaries. Direct
response models and supported DTO constructors are enabled without application
hooks. Custom drivers and transformations retain the evidence limits below.

Node discovery accepts safe direct `node server.js`/`.cjs`/`.mjs` entries with
one visible HTTP listener, including ordinary HTTP/Express-compatible servers.
It does not execute arbitrary npm/shell scripts or attach TLS/multiple-listener
entries. The managed Node 24.13+ preload supplies request context and observes
`node:sqlite` statement `all`, `get` and `run`, plus `pg.Client`/`pg.Pool` queries.
For PostgreSQL, actual result-field relation/attribute IDs are resolved by a
read-only catalog query. A table mentioned in SQL alone is insufficient proof.

Automatic Node field origins follow the actual result-row object through plain
JSON envelopes/arrays. They require an unchanged scalar and the actual
serialized document sent at response completion. The adapter observes
`JSON.stringify` and temporarily holds bounded serialized strings and original
scalar comparisons in request memory; it does not write raw response documents,
query parameters or database credentials into evidence or profile launch files.
Copied DTO fields, computed SQL columns, modified properties, getters/proxies,
custom `toJSON`, replacers, duplicate result names, early headers and streamed
responses cannot acquire a guessed origin. Cursor/submittable/native PostgreSQL
drivers and array-row queries are outside this automatic field-origin path.

Owned loopback servers expose a random readiness-token route. Orivo verifies
that token before opening the preview and cleans up owned processes on stop,
startup failure or shutdown. The managed Node backend also exits on host IPC
disconnect, with a bounded 750 ms grace for active sockets. Existing
servers/database services are preserved.
The managed frontend keeps the entered HTTP loopback host and port, including
`localhost` or `[::1]`, and preserves its path, query and fragment. Port conflicts
stop attachment before backend startup; the existing listener stays untouched.
The desktop offers retry at that address or an explicit separate tracing URL.
Stop/start, session restart and saved-workspace reopening retain the chosen
frontend origin. Without an entered URL, an address is allocated once and reused.
This starts a separately instrumented development session; it does not inject
into an arbitrary running process. Application code/configuration executes with
its normal development permissions and can perform ordinary startup/request
database or filesystem operations. Orivo itself does not write tracing hooks
or compiler caches into the selected source tree.

Advanced manual and reviewed guided integration remain available below for
custom entry points and mappings.

## Guided setup in Orivo

Choose **Set up tracing** to inspect the connected repository and existing
activation settings. Inspection and **Preview setup changes** are read only.
For eligible React/Vite applications, review the proposed changes and choose
**Apply reviewed setup** to add **.studio-tracing/** and **dev:studio**. The
original development script remains available. An optional FastAPI backend
entry point accepts application, SQLAlchemy engine and session-factory
references. When both engine and sessions are supplied, that entry point opts
into the direct response-model capture described below.

This advanced guided workflow does not install dependencies or start its
generated commands. Restart the frontend and optional backend yourself using
the displayed commands, or use the separate automatic attachment action.
**Remove generated setup** removes unchanged generated files and preserves
unrelated package edits; modified generated files must be reviewed first.
Existing frontend tracing integrations retain their activation instructions and
can add a separately reviewed Python backend setup under
**.orivo-tracing/backend/**. This backend-only setup preserves the frontend and
its scripts. It accepts an application object or an application factory, and
engine/session references such as `your_package.database:engine` or
`@app.state.database.engine` / `@app.state.database.session_factory`. Application
references are resolved after the original lifespan starts, supporting databases
created at startup. Its direct response-mapping option installs instrumentation
before importing application modules. Preview, explicit apply and undo use the
same ownership checks; no dependencies or servers are started automatically.
Manual integration remains available for other layouts. Use a single backend
tracing integration per server to avoid duplicate duplicate capture.

## React / Vite

Install this folder as a local development dependency in your application:

```powershell
npm install --save-dev C:\path\to\Orivo\adapters\tracing
```

Add the plugin to your existing Vite configuration:

```js
import studioTracing from '@orivo/tracing/vite';

export default {
  plugins: [studioTracing({
    repositoryRoot: '/absolute/path/to/the/root-connected-in-Orivo',
    include: ['src'],
  })],
};
```

Start the existing dev command with tracing enabled:

```powershell
$env:STUDIO_TRACE = '1'
npm run dev
```

The serve-only plugin is absent from production builds. Set `include` for
nonstandard source directories and `excludeRequests` for sensitive endpoints.
Place tracing before other JSX/compiler plugins in the plugin array so its
source hashes describe the original file. The guided configuration uses this order.
Custom component ref forwarding requires explicit `refComponents` declarations.
Supported property reads, optional property access, mappings and spreads preserve
response field evidence. Unsupported calls and expressions remain visible gaps.

## Next.js 16 / Webpack (advanced manual integration)

Use **Attach tracing** for managed client instrumentation without editing the
project. The following wrapper remains available when an application needs an
explicit development integration:

```js
import {withStudioTracing} from '@orivo/tracing/next';
export default withStudioTracing(existingNextConfig, {
  repositoryRoot: '/absolute/path/to/the/root-connected-in-Orivo',
});
```

```powershell
$env:STUDIO_TRACE = '1'
npx next dev --webpack
```

Client components and Pages Router are supported. Production builds, Turbopack,
server components, server-side fetch and server actions are not instrumented.
An API route still needs a backend adapter to supply execution/query evidence.

## Explicit DOM integration

```js
import {bind, request} from '@orivo/tracing/browser';

const response = await request('/api/products');
const price = response.field('products.0.price');
const element = document.querySelector('[data-price]');
element.textContent = price.value;
bind(element, {
  path: 'src/product.mjs',
  line: 12,
  hash: ORIGINAL_SOURCE_SHA256,
  name: 'ProductPrice',
  kind: 'text',
  expression: 'price.value',
}, [price]);
```

The source hash is SHA-256 of the original file bytes. Keep generation on the
development server. Browser code must not receive a native filesystem bridge.
`bind(element, source, [], 'static')` and `'local'` identify frontend-only paths.
`action(element, source, handler)` records requests after a user actually performs
the action. Picking the element itself does not run the handler.

## Node HTTP / Express-compatible middleware and SQLite

Create the adapter once when your development server starts:

```js
const http = require('node:http');
const {createTracing} = require('@orivo/tracing/node-http');

const tracing = createTracing({
  repositoryRoot,
  development: process.env.STUDIO_TRACE === '1',
});

const server = http.createServer(tracing.handler(function products(request, response) {
  const result = tracing.read(database, 'SELECT price FROM products WHERE id = ?', [1]);
  const body = {products: [{price: result.field(0, 'price', 'products.0.price')}]};
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}));
```

For an Express-compatible server, install `app.use(tracing.middleware)` before
the routes, then use the same `tracing.read()` in their handlers. Request context
is carried through asynchronous work. Without explicit development opt-in and
a valid correlation header, reads keep their normal values and no trace header
is emitted. Complete query capture requires reads and field mapping before
response headers are committed; an early `writeHead()` can only advertise the
evidence already available then.

`result.field()` maps a chosen row/result column to its exact JSON path using
SQLite's direct column metadata. It does not infer origins from table names or
equal values. Changed result values, computed columns and ambiguous result
names cannot establish an unchanged column origin. This explicit middleware API
does not capture other Node drivers or ORM projections. The separate managed
Node preload supports direct `pg` rows as described above.

Manual integrations can retain `begin()` from `@orivo/tracing/node-sqlite` and
set `Studio-Trace` themselves. Call its exported `registerRoot(repositoryRoot)`
at development-server startup; direct `begin()` registers lazily on first use.
Use manual `begin()` only after validating the development request's correlation
header.

## FastAPI / SQLAlchemy or psycopg

Install this folder in your existing development Python environment:

```powershell
python -m pip install C:\path\to\Orivo\adapters\tracing
```

Call setup before accepting requests and retain its returned detach function
for shutdown:

```python
detach = studio_tracing.setup(
    app, repository_root,
    development=enabled,
    engine=engine,
    sessions=Session,
    response_models=True,
)
```

`response_models` defaults to **False**. With **True**, a plain Pydantic v2
response model can capture a direct attribute of an ORM object loaded by an
observed query in the current request:

```python
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

class ItemOutput(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    label: str = Field(validation_alias='title')

@app.get('/api/items', response_model=list[ItemOutput])
def items():
    with Session() as session:
        return session.scalars(select(Item)).all()
```

Return the ORM object, list, or a plain envelope containing those objects.
Declared validation/serialization aliases determine structural paths such as
`items.0.label`; values are never searched to guess which attribute supplied a
field. The observer requires an unchanged loaded scalar, a captured successful
query containing its column, and matching route/query source. AsyncEngine and
async session factories/classes are normalized to SQLAlchemy's synchronous
event targets.

SQLAlchemy origins also carry the actual mapper's model class and mapped
attribute, plus optional `modelSource` and `fieldSource` declaration sites.
Each site contains a repository-relative Python path, line, name and SHA-256
hash from the registered startup snapshot. The adapter locates classes by their
lexical qualified names in bounded source ASTs; no model source expression is
evaluated. A mapped attribute whose Python name differs from its database
column retains both names. An inherited declaration can point to its base or
declarative mixin's file. Type class names and nullable flags are metadata;
custom SQL type formatters are not called.

Successful SQLAlchemy queries also report up to twelve distinct model classes
actually loaded by that query, independently of response-field provenance.
`query.models` contains each class name, its verified `modelSource` declaration
site and, when present in the observed SQL tables, its runtime mapped table.
These class definitions remain available when an application returns ordinary
dictionary serializers: viewing the model class or file does not require a
proven response-to-column mapping. Class evidence is a definition reference,
not a claim that every returned field originated in that model.

An actual scalar ORM statement can also reference mapped classes without
loading instances. Those entries carry `evidence: 'query-reference'` and use a
**uses model** edge. This identifies the mapped class used by that execution;
it does not establish a selected response field's column. A subsequently
observed instance load upgrades the same class entry to loaded evidence.

The ORM execution token follows the actual SQL execution into its load context,
so delayed or interleaved result consumption keeps the right query association.
Multiple loaded rows deduplicate to one class reference per query. Scalar-only
queries do not invent a new model load. Table-name matches and reused
identity-map objects cannot add load evidence. Missing or changed class files omit the optional definition while
preserving captured SQL and the application's normal response.

Field highlights require an ordinary `Column`, `mapped_column` or implicit
`Mapped` declaration whose declared column name matches the runtime mapper.
Dynamic replacements, `declared_attr` overrides and ambiguous lexical bindings
keep the verified class location when available without borrowing a base
field's declaration. Rebound class names do not claim an earlier class body.

Declaration evidence is optional and separate from executed-column proof.
Edited, unregistered, external, oversized, dynamic or ambiguous declarations
do not acquire a guessed source location. A dynamic mapped column may have a
verified model-class site without a field declaration site. Supported numeric
calculations retain these model sites on every captured input column. Existing
loaded-value and mutation guards still apply; model metadata never promotes an
unproven value to a database origin.

Custom field/model validators, serializers, computed fields, property aliases,
uninstrumented prebuilt DTOs, changed attributes and objects reused from an
earlier request do not inherit an automatic column origin. They keep their
normal application response. The FastAPI serialization observer is scoped to
opted-in application traces and removed when the last registration detaches.

For an application that builds response objects inside services, opt into
constructor instrumentation **before importing those application modules**:

```python
import studio_tracing

detach_imports = studio_tracing.instrument_project(
    repository_root, include=['backend/src'],
)
from your_package.main import create_app

app = create_app()
detach = studio_tracing.setup(
    app, repository_root, development=True,
    engine=app.state.database.engine,
    sessions=app.state.database.session_factory,
    response_models=True,
)
```

Adjust the include directory and engine/session references for the application.
If those objects are created during lifespan startup, attach their SQLAlchemy
listeners after startup as the generated backend entry point does. Retain both
detach functions for shutdown. Existing factories can keep their normal
configuration; disable a duplicate backend tracing integration when wrapping one.

This instruments direct keyword arguments such as
`ItemResponse(label=record.title)`. The SDK observes the actual ORM instance and
attribute, confirms its loaded query column, and attaches provenance to the
resulting DTO identity. Nested response models and list/envelope containers can
retain that identity after ORM objects have been released. Application values
keep their original types, evaluation order is preserved, and source files are
not rewritten. A projection site/hash is published with the field origin and
verified again by the host before displaying a column.

Frozen, standard Pydantic DTOs also support instrumented keyword arithmetic over
captured, unmodified numeric ORM attributes: `+`, `-`, `*` and `/`, including
numeric constant operands. For example:

```python
from pydantic import BaseModel, ConfigDict

class AmountResponse(BaseModel):
    model_config = ConfigDict(frozen=True)
    amount: float

def project_amount(invoice):
    return AmountResponse(amount=invoice.amount_cents / 100)
```

The graph records the operation and each input column, with constant values
redacted from operation metadata. Exact built-in `int`/`float` operands are
supported; custom numeric types, Decimal, string operations, mutable DTOs,
ordinary dictionary calculations and arbitrary aggregation are not promoted to
computed column evidence. ORM attribute assignments invalidate their captured
read origin even when assigned an equal value or followed by a session flush.
SQLAlchemy observers are detached with the tracing registration. Standard
Pydantic freezing and serialization are required; custom setters, validators
and serializers do not qualify.

Supported browser, Node and Python adapters also capture measured request/query
durations. SQL offsets use their backend request's monotonic clock, not the
browser clock. Missing measurements remain absent. Multiple selected response
fields share their actual request and query identities; they do not multiply
request counts, query counts, timing totals or repeated-read findings.

Expressions such as `record.title.upper()`, positional or `**kwargs` projections,
private attributes, custom validation/serialization and DTO value mutations do
not inherit that direct origin. Detaching removes the import hook and disables
its already-loaded helpers. Installing after a module was imported does not
retroactively instrument it; restart with the hook registered first.

For explicit direct mappings,
`studio_tracing.serialize(model, output_to_attribute_map, path='items.0')`
returns ordinary values and records supported ORM origins together. Starlette
integrations can use that API as well. `read_postgres()` supports psycopg direct
result-column metadata and explicit `result.field()` calls; computed or
ambiguous PostgreSQL columns do not get a direct origin. Review the module
docstrings for connection requirements. Fresh independent native acceptance
covers both SQLAlchemy/SQLite and SQLAlchemy/psycopg with PostgreSQL 17.6;
arbitrary PostgreSQL drivers or application configurations are not covered by
that result.

## Inspect or export the kit

```powershell
node adapters/tracing/cli.mjs doctor D:\path\to\your\app
node adapters/tracing/cli.mjs bundle D:\path\to\a\new\orivo-kit
```

Doctor is read-only. Bundle copies only the kit files to a new folder. The
desktop host exposes the advanced guided preview/apply/undo workflow above.
That workflow does not execute generated commands or install dependencies;
**Attach tracing** separately starts detected owned development processes.

## Evidence boundaries

Files outside the connected root, hidden folders, secrets, symlinks, generated
builds, runtime data and oversized files are excluded from source indexing.
Python setup/middleware and Node startup registration retain their first
bounded backend source snapshots for the lifetime of the process. Changing a
registered source invalidates evidence from old loaded code, including a new
HTTP request. Restart the backend, refresh the connected repository and reload
the application after edits. Direct Python `Trace()` or Node `begin()`
construction registers lazily on first use; register at startup to detect
changes made before that first request.

Python snapshots admit at most 16 roots, 5,000 Python files per root, 40 MiB per
root, 256 KiB per file, 16 directory levels and 40,000 entries. Excluded,
unreadable, new or over-limit sources cannot produce a verified site. Node
registration has its own bounded JavaScript/TypeScript snapshot.

Python and Node metadata headers use compatible `z1.` compression above 3 KiB
and a 6 KiB final budget. Python first tries a compact reference pool for repeated
source, model and field-origin metadata. Both browser adapters decode this format;
serve `trace-codec.mjs` beside `browser.mjs` when hosting a manual adapter kit.
Pool expansion is bounded to 1 MiB, 50,000 values and 18 levels, with a 300,000-byte
wire limit. Python captures that still exceed the header budget preserve fitting
SQL evidence and compatible field claims and mark the capture truncated. Real default Node HTTP proxy checks
verify successful forwarding and unchanged application bodies; this avoids
normal Vite proxy header-overflow failures without increasing its header limit.

Automatic owned sessions use this complete header when it fits. Otherwise they
publish a short `orivo-managed-v1` reference to process-local metadata, retrieved
through the owned frontend's `/__orivo_trace/` route. The backend readiness token
never appears in page metadata. This transport supports 256 captured executions
and 2,048 mapped fields per response, with 2 MiB per payload, 64 MiB total,
256 entries and 90-second expiry. It stores no SQL parameter or response values.
Invalid keys, correlation mismatches, cross-origin redirects, oversized payloads
and expired entries cannot establish evidence. The application response remains
unchanged when an optional capture exceeds its budget.

## Verification

The test scripts in test/ exercise independent applications and supported evidence paths. Dependencies and fixture environments are not bundled in the source project. Run the relevant tests after installing dependencies; coverage claims require fresh fixture results. See ../../docs/TRACING-COVERAGE.md for current scope.
