import { createHash, randomUUID } from "node:crypto";

export type Modality = "text" | "image" | "audio";
export type QuestionType = "choice" | "boolean" | "score";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface BooleanQuestion {
  type: "boolean";
  instructions: string;
}
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  min?: number;
  max?: number;
}
export type DecisionQuestion = ChoiceQuestion | BooleanQuestion | ScoreQuestion;

export interface DecisionRequest {
  model?: string;
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
  modalities?: Modality[];
  metadata?: Record<string, string>;
}

export interface DecisionAnswer {
  type: QuestionType;
  value: string | boolean | number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface DecisionResult {
  id: string;
  provider: string;
  model: string;
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
  raw?: unknown;
}

export interface ProviderCapabilities {
  provider: string;
  adapterVersion: string;
  modalities: Modality[];
  questionTypes: QuestionType[];
  probabilities: boolean;
  maxQuestions?: number;
  maxChoices?: number;
  reasoningControls?: string[];
  dataLocality?: "local" | "remote";
  pricing?: { inputPerMillion?: number; outputPerMillion?: number; currency?: string };
}

export interface DecisionProvider {
  capabilities: ProviderCapabilities;
  decide(request: DecisionRequest, options?: { signal?: AbortSignal; controls?: Record<string, unknown> }): Promise<DecisionResult>;
}

export interface Requirements {
  modalities?: Modality[];
  questionTypes?: QuestionType[];
  probabilities?: boolean;
  locality?: "local" | "remote";
  reasoningControls?: string[];
  maxInputPricePerMillion?: number;
}

export interface CompatibilityReport {
  compatible: boolean;
  losses: string[];
  missing: string[];
}

function unique<T>(items: T[]): T[] { return [...new Set(items)]; }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export function inspectCompatibility(capabilities: ProviderCapabilities, request: DecisionRequest, requirements: Requirements = {}): CompatibilityReport {
  const missing: string[] = [];
  const losses: string[] = [];
  const modalities = unique([...(request.modalities ?? ["text"]), ...(requirements.modalities ?? [])]);
  const questionTypes = unique([...Object.values(request.questions).map(q => q.type), ...(requirements.questionTypes ?? [])]);
  for (const modality of modalities) if (!capabilities.modalities.includes(modality)) missing.push(`modality:${modality}`);
  for (const type of questionTypes) if (!capabilities.questionTypes.includes(type)) missing.push(`question:${type}`);
  if (requirements.probabilities && !capabilities.probabilities) missing.push("probabilities");
  if (requirements.locality && capabilities.dataLocality !== requirements.locality) missing.push(`locality:${requirements.locality}`);
  for (const control of requirements.reasoningControls ?? []) if (!capabilities.reasoningControls?.includes(control)) missing.push(`control:${control}`);
  const questions = Object.values(request.questions);
  if (capabilities.maxQuestions !== undefined && questions.length > capabilities.maxQuestions) missing.push(`maxQuestions:${capabilities.maxQuestions}`);
  if (capabilities.maxChoices !== undefined) {
    for (const [name, question] of Object.entries(request.questions)) {
      if (question.type === "choice" && Object.keys(question.criteria).length > capabilities.maxChoices) missing.push(`${name}:maxChoices:${capabilities.maxChoices}`);
    }
  }
  if (!capabilities.probabilities && !requirements.probabilities) losses.push("Provider does not expose probabilities");
  if (requirements.maxInputPricePerMillion !== undefined) {
    const price = capabilities.pricing?.inputPerMillion;
    if (price === undefined) missing.push("pricing:unknown");
    else if (price > requirements.maxInputPricePerMillion) missing.push(`pricing:${price}`);
  }
  return { compatible: missing.length === 0, losses, missing };
}

export function validateRequest(request: DecisionRequest): void {
  assert(request && typeof request === "object", "Request is required");
  assert(request.state && typeof request.state === "object" && !Array.isArray(request.state), "state must be an object");
  assert(request.questions && typeof request.questions === "object" && Object.keys(request.questions).length > 0, "At least one question is required");
  for (const [name, question] of Object.entries(request.questions)) {
    assert(name.length > 0, "Question names cannot be empty");
    assert(question.instructions?.trim(), `${name}: instructions are required`);
    assert(["choice", "boolean", "score"].includes(question.type), `${name}: unsupported question type`);
    if (question.type === "choice") assert(Object.keys(question.criteria).length >= 2, `${name}: choice questions need at least two criteria`);
  }
}

export function selectProvider(providers: DecisionProvider[], request: DecisionRequest, requirements: Requirements = {}): { provider: DecisionProvider; report: CompatibilityReport } {
  validateRequest(request);
  const evaluated = providers.map(provider => ({ provider, report: inspectCompatibility(provider.capabilities, request, requirements) }));
  const candidates = evaluated.filter(item => item.report.compatible);
  assert(candidates.length > 0, `No compatible provider: ${evaluated.map(x => `${x.provider.capabilities.provider}(${x.report.missing.join(",")})`).join("; ")}`);
  candidates.sort((a, b) => {
    const localA = a.provider.capabilities.dataLocality === "local" ? 0 : 1;
    const localB = b.provider.capabilities.dataLocality === "local" ? 0 : 1;
    const priceA = a.provider.capabilities.pricing?.inputPerMillion ?? Number.POSITIVE_INFINITY;
    const priceB = b.provider.capabilities.pricing?.inputPerMillion ?? Number.POSITIVE_INFINITY;
    return localA - localB || priceA - priceB || a.provider.capabilities.provider.localeCompare(b.provider.capabilities.provider);
  });
  return candidates[0]!;
}

export function createDecisionClient(options: { providers: DecisionProvider[]; requirements?: Requirements; timeoutMs?: number }) {
  assert(options.providers.length > 0, "At least one provider is required");
  const timeoutMs = options.timeoutMs ?? 30_000;
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000, "timeoutMs must be between 1 and 300000");
  return {
    plan(request: DecisionRequest, requirements: Requirements = {}) {
      return selectProvider(options.providers, request, { ...options.requirements, ...requirements });
    },
    async decide(request: DecisionRequest, call: { signal?: AbortSignal; controls?: Record<string, unknown>; requirements?: Requirements } = {}) {
      const selected = selectProvider(options.providers, request, { ...options.requirements, ...call.requirements });
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
      const started = performance.now();
      const result = await selected.provider.decide(structuredClone(request), { signal, ...(call.controls ? { controls: call.controls } : {}) });
      validateResult(request, result);
      return { ...result, latencyMs: Math.round((performance.now() - started) * 100) / 100, compatibility: selected.report };
    },
  };
}

export function validateResult(request: DecisionRequest, result: DecisionResult): void {
  assert(result && typeof result === "object", "Provider returned no result");
  assert(typeof result.provider === "string" && result.provider.length > 0, "Result provider is missing");
  assert(typeof result.model === "string" && result.model.length > 0, "Result model is missing");
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = result.answers?.[name];
    assert(answer, `Missing answer: ${name}`);
    assert(answer.type === question.type, `${name}: answer type mismatch`);
    if (answer.probabilities) {
      const probabilities = Object.values(answer.probabilities);
      assert(probabilities.every(p => Number.isFinite(p) && p >= 0 && p <= 1), `${name}: invalid probabilities`);
      const total = probabilities.reduce((sum, p) => sum + p, 0);
      assert(Math.abs(total - 1) <= 0.001, `${name}: probabilities must sum to one`);
    }
  }
}

export function createTypeSafeProvider(options: { apiKey?: string; endpoint?: string; model?: string; fetchImpl?: typeof fetch } = {}): DecisionProvider {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  assert(apiKey, "Set TYPESAFE_API_KEY");
  const endpoint = new URL(options.endpoint ?? "https://api.typesafe.ai/v1/systemone");
  assert(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)), "Endpoint must use HTTPS (loopback HTTP is allowed)");
  assert(!endpoint.username && !endpoint.password, "Endpoint must not contain credentials");
  const fetchImpl = options.fetchImpl ?? fetch;
  const capabilities: ProviderCapabilities = {
    provider: "typesafe-jev", adapterVersion: "0.1.0", modalities: ["text"],
    questionTypes: ["choice", "boolean", "score"], probabilities: true,
    reasoningControls: [], dataLocality: "remote",
  };
  return {
    capabilities,
    async decide(request, call = {}) {
      validateRequest(request);
      const model = request.model ?? options.model ?? "jev-1.13.0";
      const response = await fetchImpl(endpoint, {
        method: "POST", redirect: "error", ...(call.signal ? { signal: call.signal } : {}),
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, state: request.state, questions: request.questions }),
      });
      assert(response.ok, `TypeSafe Jev returned HTTP ${response.status}`);
      const raw = await response.json() as { model?: string; answers?: Record<string, { type: QuestionType; choice?: string; value?: string | boolean | number; probabilities?: Record<string, number>; confidence?: number }> };
      const answers: Record<string, DecisionAnswer> = {};
      for (const [name, answer] of Object.entries(raw.answers ?? {})) answers[name] = { type: answer.type, value: answer.value ?? answer.choice ?? false, ...(answer.probabilities ? { probabilities: answer.probabilities } : {}), ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}) };
      return { id: randomUUID(), provider: capabilities.provider, model: raw.model ?? model, answers, latencyMs: 0, raw };
    },
  };
}

export function createHttpProvider(options: {
  capabilities: ProviderCapabilities;
  endpoint: string;
  headers?: Record<string, string>;
  encode?: (request: DecisionRequest, controls?: Record<string, unknown>) => unknown;
  decode: (payload: unknown, request: DecisionRequest) => Omit<DecisionResult, "id" | "provider" | "latencyMs">;
  fetchImpl?: typeof fetch;
}): DecisionProvider {
  const url = new URL(options.endpoint);
  assert(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)), "Endpoint must use HTTPS (loopback HTTP is allowed)");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    capabilities: structuredClone(options.capabilities),
    async decide(request, call = {}) {
      const response = await fetchImpl(url, {
        method: "POST", redirect: "error", ...(call.signal ? { signal: call.signal } : {}),
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify(options.encode ? options.encode(request, call.controls) : request),
      });
      assert(response.ok, `${options.capabilities.provider} returned HTTP ${response.status}`);
      const decoded = options.decode(await response.json(), request);
      return { id: randomUUID(), provider: options.capabilities.provider, latencyMs: 0, ...decoded };
    },
  };
}

export function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export interface QueueCallOptions {
  signal?: AbortSignal;
  priority?: number;
  timeoutMs?: number;
  controls?: Record<string, unknown>;
  requirements?: Requirements;
  lane?: string;
}

export interface DecisionQueueOptions {
  decide: (request: DecisionRequest, options?: { signal?: AbortSignal; controls?: Record<string, unknown>; requirements?: Requirements }) => Promise<DecisionResult & { compatibility?: CompatibilityReport }>;
  maxBatchSize?: number;
  maxWaitMs?: number;
  maxPending?: number;
  concurrency?: number;
}

interface QueuedDecision {
  id: string;
  request: DecisionRequest;
  options: QueueCallOptions;
  resolve: (result: DecisionResult & { compatibility?: CompatibilityReport }) => void;
  reject: (error: unknown) => void;
  enqueuedAt: number;
  settled: boolean;
}

export class DecisionQueue {
  readonly maxBatchSize: number;
  readonly maxWaitMs: number;
  readonly maxPending: number;
  readonly concurrency: number;
  #decide: DecisionQueueOptions["decide"];
  #pending: QueuedDecision[] = [];
  #timer: NodeJS.Timeout | undefined;
  #active = 0;
  #closed = false;

  constructor(options: DecisionQueueOptions) {
    this.#decide = options.decide;
    this.maxBatchSize = options.maxBatchSize ?? 16;
    this.maxWaitMs = options.maxWaitMs ?? 5;
    this.maxPending = options.maxPending ?? 1_000;
    this.concurrency = options.concurrency ?? 1;
    assert(Number.isInteger(this.maxBatchSize) && this.maxBatchSize > 0, "maxBatchSize must be positive");
    assert(Number.isInteger(this.maxWaitMs) && this.maxWaitMs >= 0, "maxWaitMs cannot be negative");
    assert(Number.isInteger(this.maxPending) && this.maxPending >= this.maxBatchSize, "maxPending must be at least maxBatchSize");
    assert(Number.isInteger(this.concurrency) && this.concurrency > 0, "concurrency must be positive");
  }

  get stats(): { pending: number; active: number; closed: boolean } {
    return { pending: this.#pending.filter(item => !item.settled).length, active: this.#active, closed: this.#closed };
  }

  enqueue(request: DecisionRequest, options: QueueCallOptions = {}): Promise<DecisionResult & { compatibility?: CompatibilityReport }> {
    validateRequest(request);
    assert(!this.#closed, "Decision queue is closed");
    assert(this.stats.pending < this.maxPending, "Decision queue is full");
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error("Decision cancelled"));
    return new Promise((resolve, reject) => {
      const item: QueuedDecision = { id: randomUUID(), request: structuredClone(request), options, resolve, reject, enqueuedAt: Date.now(), settled: false };
      const cancel = () => this.#settle(item, () => reject(options.signal?.reason ?? new Error("Decision cancelled")));
      options.signal?.addEventListener("abort", cancel, { once: true });
      this.#pending.push(item);
      this.#pending.sort((a, b) => (b.options.priority ?? 0) - (a.options.priority ?? 0) || a.enqueuedAt - b.enqueuedAt);
      if (this.stats.pending >= this.maxBatchSize || this.maxWaitMs === 0) void this.flush();
      else if (!this.#timer) this.#timer = setTimeout(() => { this.#timer = undefined; void this.flush(); }, this.maxWaitMs);
    });
  }

  async flush(): Promise<void> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    while (this.#active < this.concurrency) {
      const seed = this.#pending.find(item => !item.settled);
      if (!seed) return;
      const key = queueKey(seed);
      const batch = this.#pending.filter(item => !item.settled && queueKey(item) === key).slice(0, this.maxBatchSize);
      this.#pending = this.#pending.filter(item => !batch.includes(item));
      this.#active++;
      void this.#run(batch).finally(() => { this.#active--; void this.flush(); });
    }
  }

  async drain(): Promise<void> {
    await this.flush();
    while (this.#active > 0 || this.stats.pending > 0) await new Promise(resolve => setTimeout(resolve, 1));
  }

  close(error: Error = new Error("Decision queue closed")): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const item of this.#pending) this.#settle(item, () => item.reject(error));
    this.#pending = [];
  }

  async #run(batch: QueuedDecision[]): Promise<void> {
    const live = batch.filter(item => !item.settled && !item.options.signal?.aborted);
    if (!live.length) return;
    const questions: Record<string, DecisionQuestion> = {};
    const mapping = new Map<string, { item: QueuedDecision; original: string }>();
    for (const item of live) for (const [name, question] of Object.entries(item.request.questions)) {
      const merged = `${item.id}:${name}`;
      questions[merged] = question;
      mapping.set(merged, { item, original: name });
    }
    const seed = live[0]!;
    const controller = new AbortController();
    const timeoutMs = Math.min(...live.map(item => item.options.timeoutMs ?? 30_000));
    const timeout = setTimeout(() => controller.abort(new Error("Decision batch timed out")), timeoutMs);
    try {
      const result = await this.#decide({ ...seed.request, questions }, { signal: controller.signal, ...(seed.options.controls ? { controls: seed.options.controls } : {}), ...(seed.options.requirements ? { requirements: seed.options.requirements } : {}) });
      const answersByItem = new Map<QueuedDecision, Record<string, DecisionAnswer>>();
      for (const [merged, answer] of Object.entries(result.answers)) {
        const target = mapping.get(merged);
        if (!target) continue;
        const answers = answersByItem.get(target.item) ?? {};
        answers[target.original] = answer;
        answersByItem.set(target.item, answers);
      }
      const batchFingerprint = fingerprint({ state: seed.request.state, questions, provider: result.provider, model: result.model });
      for (const item of live) this.#settle(item, () => {
        const split = { ...result, id: item.id, answers: answersByItem.get(item) ?? {}, raw: { batchId: result.id, batchSize: live.length, batchFingerprint } };
        validateResult(item.request, split);
        item.resolve(split);
      });
    } catch (error) {
      for (const item of live) this.#settle(item, () => item.reject(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  #settle(item: QueuedDecision, action: () => void): void {
    if (item.settled) return;
    item.settled = true;
    action();
  }
}

function queueKey(item: QueuedDecision): string {
  return fingerprint({ model: item.request.model ?? null, state: item.request.state, modalities: item.request.modalities ?? ["text"], metadata: item.request.metadata ?? {}, controls: item.options.controls ?? {}, requirements: item.options.requirements ?? {}, lane: item.options.lane ?? "default" });
}

export function createDecisionQueue(options: DecisionQueueOptions): DecisionQueue {
  return new DecisionQueue(options);
}
