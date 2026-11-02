# Broken price companion demo — design

## Intent

Give first-time Orivo users a concrete debugging story: a storefront visibly
shows an implausible price, and a captured trace leads from that value to the
specific backend calculation that caused it.

## Goals

- Add a self-contained, intentionally broken companion to the existing working
  Orbit storefront demo.
- Make the symptom obvious: a product priced at `$129` is rendered as
  `$12,900`.
- Preserve the evidence-first story: selected UI value → response field →
  backend execution → SQL query → `products.price`, with the bad conversion
  visible in backend source.
- Provide concise instructions suitable for the README and a LinkedIn
  follow-up.

## Non-goals

- Do not change the current working demo or its happy-path walkthrough.
- Do not claim that tracing automatically diagnoses the fault; Orivo exposes
  the captured evidence for the developer to inspect.
- Do not add production or external-service dependencies.

## Approaches considered

1. **Separate demo (selected).** A distinct source directory and Orivo entry
   point make the choice and outcome unambiguous, while keeping the existing
   working demo intact.
2. **Toggle in the existing demo.** Fewer files, but the two teaching stories
   blur and the happy-path walkthrough becomes more fragile.

## Proposed implementation

- Add a `demo-broken/` storefront derived from the local Orbit demo, with an
  independent server and static frontend.
- Seed the same catalog data, but return one product's `price` after an
  intentionally incorrect cents-to-dollars conversion in the API handler.
- Surface the new option in Orivo next to **Explore a working demo**, labelled
  **Investigate a broken price**.
- Add a demo walkthrough that directs the user to select the visibly wrong
  price and inspect the backend source card where the conversion is shown.
- Add focused automated coverage for launching/stopping the new demo and its
  advertised trace scenario.

## Success criteria

A user can launch the broken demo, see `$12,900`, select it in Orivo, and use
the trace to reach the intentionally faulty conversion without affecting the
existing working-demo flow.
