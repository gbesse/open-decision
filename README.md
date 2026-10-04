# Open Decision

A capability-aware, vendor-neutral decision runtime. It routes a finite decision request to TypeSafe Jev, a local model or any HTTP decision engine without pretending that their capabilities are identical.

## Why

Decision providers differ in modalities, answer types, probability support, limits, controls, data locality and price. Open Decision makes those differences explicit. An unsupported requirement fails before a paid request is made; optional losses are returned with the plan and result.

## Install

```sh
npm install @gbesse/open-decision
```

```ts
import { createDecisionClient, createTypeSafeProvider } from "@gbesse/open-decision";

const client = createDecisionClient({
  providers: [createTypeSafeProvider()],
  requirements: { probabilities: true },
});

const result = await client.decide({
  state: { message: "Please refund the duplicate invoice" },
  questions: {
    route: {
      type: "choice",
      instructions: "Select the operational route supported by the message.",
      criteria: { refund: "Explicit refund request", other: "Anything else" },
    },
  },
});
```

`createHttpProvider` supports local and future hosted APIs through explicit encode/decode functions. No undocumented OpenAI Decisions endpoint is hard-coded: add an adapter when its public contract is available.

### Queue and coalescing

`createDecisionQueue` batches independent questions that share the same model,
state, modalities, metadata, controls, requirements and lane. One provider call
is split back into per-caller results with a batch receipt.

```ts
import { createDecisionQueue } from "@gbesse/open-decision";

const queue = createDecisionQueue({
  decide: (request, options) => client.decide(request, options),
  maxBatchSize: 16,
  maxWaitMs: 5,
  maxPending: 1000,
  concurrency: 1,
});

const result = await queue.enqueue(request, {
  priority: 10,
  timeoutMs: 2_000,
  lane: "permissions",
});
```

The queue supports cancellation, deadlines, bounded pending work and explicit
provider concurrency. Batching is conservative: calls with different state or
controls never share a provider request.

## CLI

```sh
open-decision validate examples/request.json
open-decision inspect examples/request.json examples/local-capabilities.json
```

Exit status `2` means invalid input or an incompatible provider.

## Security

API keys are accepted through process configuration and sent only to the configured endpoint. Redirects are rejected. Remote endpoints require HTTPS; plain HTTP is limited to loopback development servers. Requests are cloned before provider execution.

This library performs routing, not sandboxing. A `local` capability is an assertion from the adapter author and should be verified operationally.

## Development

```sh
npm install
npm run release:check
```

MIT licensed. Open Decision is independent of TypeSafe and OpenAI.
