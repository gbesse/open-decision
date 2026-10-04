import test from "node:test";
import assert from "node:assert/strict";
import { createDecisionClient, createDecisionQueue, createHttpProvider, inspectCompatibility, selectProvider, validateResult, type DecisionProvider, type DecisionRequest } from "../src/index.js";

const request: DecisionRequest = { state: { text: "refund requested" }, questions: { route: { type: "choice", instructions: "Choose the route", criteria: { refund: "Refund", other: "Other" } } } };
const provider = (name: string, locality: "local" | "remote", price?: number): DecisionProvider => ({
  capabilities: { provider: name, adapterVersion: "1", modalities: ["text"], questionTypes: ["choice"], probabilities: true, dataLocality: locality, ...(price === undefined ? {} : { pricing: { inputPerMillion: price } }) },
  async decide() { return { id: "1", provider: name, model: "fixture", answers: { route: { type: "choice", value: "refund", probabilities: { refund: .9, other: .1 } } }, latencyMs: 0 }; },
});

test("selects a compatible local provider deterministically", () => {
  assert.equal(selectProvider([provider("remote", "remote", 1), provider("local", "local", 10)], request).provider.capabilities.provider, "local");
});

test("reports unsupported capabilities instead of silently degrading", () => {
  const report = inspectCompatibility(provider("text", "remote").capabilities, { ...request, modalities: ["image"] });
  assert.equal(report.compatible, false);
  assert.deepEqual(report.missing, ["modality:image"]);
});

test("validates probability mass", () => {
  assert.throws(() => validateResult(request, { id: "1", provider: "x", model: "x", answers: { route: { type: "choice", value: "refund", probabilities: { refund: .9, other: .9 } } }, latencyMs: 1 }), /sum to one/);
});

test("client enforces required capabilities and returns provenance", async () => {
  const client = createDecisionClient({ providers: [provider("fixture", "local")], requirements: { probabilities: true } });
  const result = await client.decide(request);
  assert.equal(result.provider, "fixture");
  assert.equal(result.compatibility.compatible, true);
});

test("generic HTTP adapter uses explicit codecs", async () => {
  let body = "";
  const adapter = createHttpProvider({
    capabilities: provider("http", "local").capabilities,
    endpoint: "http://127.0.0.1/decision",
    fetchImpl: async (_input, init) => { body = String(init?.body); return new Response(JSON.stringify({ selected: "refund" }), { status: 200 }); },
    encode: input => ({ payload: input.state }),
    decode: payload => ({ model: "local", answers: { route: { type: "choice", value: (payload as { selected: string }).selected, probabilities: { refund: 1, other: 0 } } } }),
  });
  const result = await adapter.decide(request);
  assert.match(body, /payload/);
  assert.equal(result.answers.route?.value, "refund");
});

test("queue coalesces compatible requests and splits receipts", async () => {
  let calls = 0;
  let questionCount = 0;
  const queue = createDecisionQueue({ maxWaitMs: 20, decide: async batch => {
    calls++;
    questionCount = Object.keys(batch.questions).length;
    return { id: "batch-1", provider: "fixture", model: "fixture", latencyMs: 2, answers: Object.fromEntries(Object.entries(batch.questions).map(([name, question]) => [name, { type: question.type, value: "refund" }])) };
  } });
  const [a, b] = await Promise.all([queue.enqueue(request), queue.enqueue({ ...request, questions: { escalation: request.questions.route! } })]);
  assert.equal(calls, 1);
  assert.equal(questionCount, 2);
  assert.deepEqual(Object.keys(a.answers), ["route"]);
  assert.deepEqual(Object.keys(b.answers), ["escalation"]);
  assert.equal((a.raw as { batchSize: number }).batchSize, 2);
});

test("queue keeps different states in separate batches", async () => {
  let calls = 0;
  const queue = createDecisionQueue({ maxWaitMs: 0, maxBatchSize: 1, maxPending: 1, decide: async batch => {
    calls++;
    return { id: String(calls), provider: "fixture", model: "fixture", latencyMs: 0, answers: Object.fromEntries(Object.entries(batch.questions).map(([name, question]) => [name, { type: question.type, value: "refund" }])) };
  } });
  await Promise.all([queue.enqueue(request), queue.enqueue({ ...request, state: { text: "other" } })]);
  assert.equal(calls, 2);
});
