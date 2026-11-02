# Broken Price Companion Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated, intentionally faulty storefront demo that lets a user trace a displayed `$12,900` price to a bad backend conversion.

**Architecture:** The existing demo remains unchanged. A parallel `demo-broken/` app exposes the same bounded local service and tracing endpoints but deliberately multiplies the first catalog price in its API handler. The desktop host owns one selected demo server at a time; the renderer offers separate working and investigation actions.

**Tech Stack:** Electron, Node.js `http`, `node:sqlite`, existing Orivo tracing adapters, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-01-broken-price-demo-design.md`

## Global Constraints

- Keep the existing working demo and happy-path walkthrough unchanged.
- Add no production or external-service dependencies.
- The broken behavior must be isolated to the companion demo's backend conversion.
- Orivo must expose captured evidence; it must not claim to automatically diagnose the fault.
- Preserve local-only, bounded static-file serving and idempotent server cleanup.

## Review Focus

- Switching demos must not reuse the previous server URL or source root; test in Task 2.
- The faulty response field must retain SQL lineage to `products.price`; test in Task 1.
- Only the `orbit` price must change; test in Task 1.
- The UI must identify the broken route as an investigation; test in Task 3.
- Malformed trace IDs and forbidden static paths must still be rejected; test in Task 1.

---

### Task 1: Isolated broken storefront server and evidence path

**Files:**
- Create: `demo-broken/catalog.sql`, `demo-broken/index.html`, `demo-broken/app.mjs`, `demo-broken/style.css`, `demo-broken/server.cjs`
- Modify: `test/host-demo.test.cjs`

**Interfaces:**
- Produces: `startBrokenDemo() -> Promise<{url: string, root: string, close: () => Promise<void>}>` and `sourceMetadata()` from `demo-broken/server.cjs`.

- [ ] **Step 1: Write the failing companion-server tests**

Import `startBrokenDemo`; assert traced catalog data returns `products[0].price === 12900`, `products[1].price === 248`, `products.0.price` lineage for `products.price`, a source marker at `trace:price`, and rejection of malformed trace IDs and `/server.cjs`.

- [ ] **Step 2: Run the test and confirm failure**

Run `node --test test/host-demo.test.cjs`; expect a missing `demo-broken/server.cjs` module.

- [ ] **Step 3: Implement the isolated server and storefront**

Mirror the working demo's seed, static allowlist, source hashes, trace headers, and cleanup. Map only the `orbit` record's `result.field(index, 'price', 'products.0.price')` through a named faulty cents conversion before serialization, retaining that field as the trace source. Format the supplied value normally in the frontend and bind it with `// trace:price`.

- [ ] **Step 4: Run the test and confirm success**

Run `node --test test/host-demo.test.cjs`; expect all existing and new server tests to pass.

- [ ] **Step 5: Commit**

Commit `demo-broken` and `test/host-demo.test.cjs` as `feat: add broken price trace demo`.

### Task 2: Desktop host support for choosing either demo

**Files:**
- Modify: `main.cjs`, `preload.cjs`, `test/host-demo.test.cjs`

**Interfaces:**
- Consumes: the shared `{url, root, close}` return shape from `startDemo()` and `startBrokenDemo()`.
- Produces: IPC method `open-broken-demo`, exposed as `window.traceAtlas.openBrokenDemo() -> Promise<HostState>`.

- [ ] **Step 1: Write the failing IPC contract test**

Assert `main.cjs` imports and registers the broken server with `open-broken-demo`, and `preload.cjs` exposes `openBrokenDemo` mapped to it.

- [ ] **Step 2: Run the test and confirm failure**

Run `node --test test/host-demo.test.cjs`; expect the IPC contract assertion to fail.

- [ ] **Step 3: Implement selected-demo host lifecycle**

Replace working-demo-only lifecycle state with a selected server promise/session. Close the old demo before starting the chosen kind, connect its root, open its URL in demo mode, and close the selected server on shutdown. Keep `open-demo` working; add `open-broken-demo`. Auto-capture `$129` for the working demo and `$12,900` for the broken demo using `price-orbit`.

- [ ] **Step 4: Run the test and confirm success**

Run `node --test test/host-demo.test.cjs`; expect pass.

- [ ] **Step 5: Commit**

Commit `main.cjs`, `preload.cjs`, and test changes as `feat: open broken demo from desktop host`.

### Task 3: Scenario-selecting UI and documentation

**Files:**
- Modify: `renderer/index.html`, `renderer/app.js`, `renderer/ide.js`, `docs/DEMO.md`, `README.md`, `test/host-demo.test.cjs`

**Interfaces:**
- Consumes: `window.traceAtlas.openDemo()` and `window.traceAtlas.openBrokenDemo()`.
- Produces: distinct **Explore a working demo** and **Investigate a broken price** actions and contextual project copy.

- [ ] **Step 1: Write failing static UI and documentation assertions**

Assert the renderer contains `Investigate a broken price`, invokes `openBrokenDemo`, and documentation explains `$12,900`, the incorrect conversion, and that Orivo presents evidence rather than a diagnosis.

- [ ] **Step 2: Run the test and confirm failure**

Run `node --test test/host-demo.test.cjs`; expect the new copy and handler assertions to fail.

- [ ] **Step 3: Implement the UI action and walkthrough**

Add the broken-demo action to welcome and command-palette UI. Make `handleHost` scenario-aware; wire it to `openBrokenDemo`; preserve all working-demo actions. Add an investigation section to `docs/DEMO.md` and a README callout.

- [ ] **Step 4: Run full verification**

Run `node --test test/host-demo.test.cjs` and `npm.cmd test`; expect pass.

- [ ] **Step 5: Commit**

Commit renderer, documentation, and test changes as `docs: guide broken price investigation`.
