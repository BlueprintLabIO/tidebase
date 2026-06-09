import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export type TidebaseOptions = {
  url?: string
  apiKey?: string
  webhookSecret?: string
}

export type RunCreateOptions = {
  input?: unknown
  metadata?: Record<string, unknown>
  recoveryWebhook?: string
  channels?: ChannelOptions[]
}

export type RunOptions = {
  runId?: string
  input?: unknown
  metadata?: Record<string, unknown>
  recoveryWebhook?: string
  channels?: ChannelOptions[]
}

export type ChannelOptions = {
  type: 'webhook'
  url: string
  secret?: string
  events?: string[]
}

export type CapabilityIntent = {
  name: string
  scopes?: string[]
  reason?: string
}

export type CredentialIntent = CapabilityIntent

export type StepOptions = {
  input?: unknown
  inputHash?: string
  retries?: number
  timeoutMs?: number
  sideEffects?: string[]
  idempotencyKey?: string
  replay?: 'auto' | 'manual' | 'never'
  checkpointInvariant?: string | Record<string, unknown>
  verifiedBy?: string | Record<string, unknown>
  credentials?: CredentialIntent[]
  /**
   * @deprecated Use sideEffects for named external operations.
   */
  sideEffect?: 'none' | 'read' | 'write' | 'external'
  /**
   * @deprecated Use replay.
   */
  onAmbiguousFailure?: 'retry' | 'fail' | 'review'
}

export type TideRun = {
  id: string
  workflowName: string
  input: unknown
  metadata: Record<string, unknown>
  status: string
  result: unknown
  error: unknown
  createdAt: string
  updatedAt: string
}

export type TideEvent = {
  id: number
  runId: string
  seq: number
  type: string
  payload: unknown
  createdAt: string
}

export type TideWorkflow<TInput = unknown, TResult = unknown> = (
  run: RunContext,
  input: TInput
) => Promise<TResult> | TResult

export type RecoveryWebhookPayload = {
  type: 'run.resume'
  runId: string
  workflowName: string
  reason: string
  attempt?: number
}

export type GateOptions = {
  prompt: string
  data?: unknown
  channels?: ChannelOptions[]
  capability?: CapabilityIntent
  timeoutMs?: number
  pollMs?: number
}

export type GateDecision = {
  gateId: string
  name: string
  status: string
  decision: 'approved' | 'rejected' | 'canceled'
  actor: string | null
  payload: unknown
}

export type UsageRecordOptions = {
  stepId?: string
  kind?: string
  provider?: string
  model?: string
  label?: string
  quantity?: number
  unit?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
  metadata?: Record<string, unknown>
}

export type WebhookOptions = {
  secret?: string
}

export class Tidebase {
  readonly runs: RunsClient
  private readonly url: string
  private readonly apiKey?: string
  private readonly webhookSecret?: string
  private readonly workflows = new Map<string, TideWorkflow>()

  constructor(options: TidebaseOptions = {}) {
    this.url = stripTrailingSlash(
      options.url ?? process.env.TIDEBASE_URL ?? 'http://localhost:7373'
    )
    this.apiKey = options.apiKey ?? process.env.TIDEBASE_API_KEY
    this.webhookSecret = options.webhookSecret ?? process.env.TIDEBASE_WEBHOOK_SECRET
    this.runs = new RunsClient(this)
  }

  workflow<TInput = unknown, TResult = unknown>(
    name: string,
    workflow: TideWorkflow<TInput, TResult>
  ) {
    this.workflows.set(name, workflow as TideWorkflow)
    return this
  }

  webhook(options: WebhookOptions = {}) {
    const secret = options.secret ?? this.webhookSecret
    return async (request: Request): Promise<Response> => {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'method not allowed' }, 405)
      }

      const body = await request.text()
      if (secret && !verifySignature(body, request.headers.get('x-tidebase-signature'), secret)) {
        return jsonResponse({ error: 'invalid signature' }, 401)
      }

      const payload = JSON.parse(body) as RecoveryWebhookPayload
      if (payload.type !== 'run.resume') {
        return jsonResponse({ error: 'unsupported webhook type' }, 400)
      }

      const workflow = this.workflows.get(payload.workflowName)
      if (!workflow) {
        return jsonResponse(
          { error: `unknown workflow ${payload.workflowName}` },
          404
        )
      }

      await this.run(payload.workflowName, { runId: payload.runId }, workflow)
      return jsonResponse({
        accepted: true,
        runId: payload.runId,
        workflowName: payload.workflowName,
        reason: payload.reason
      })
    }
  }

  async run<TInput = unknown, TResult = unknown>(
    workflowName: string,
    options: RunOptions,
    workflow: TideWorkflow<TInput, TResult>
  ): Promise<TResult> {
    const run =
      options.runId == null
        ? await this.runs.create(workflowName, {
            input: options.input,
            metadata: options.metadata,
            recoveryWebhook: options.recoveryWebhook,
            channels: options.channels
          })
        : await this.runs.get(options.runId).then((detail) => detail.run)

    if (run.workflowName !== workflowName) {
      throw new Error(
        `Run ${run.id} belongs to workflow ${run.workflowName}, not ${workflowName}`
      )
    }

    if (run.status === 'completed') {
      return run.result as TResult
    }

    const begin = await this.request<{ run: TideRun; leaseOwner: string }>(
      `/runs/${run.id}/begin`,
      { method: 'POST' }
    )
    const context = new RunContext(this, run.id, begin.leaseOwner)

    try {
      const result = await workflow(context, run.input as TInput)
      await this.request(`/runs/${run.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ result })
      })
      return result
    } catch (error) {
      await this.request(`/runs/${run.id}/fail`, {
        method: 'POST',
        body: JSON.stringify({ error: serializeError(error) })
      }).catch(() => undefined)
      throw error
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...init.headers
      }
    })
    if (!response.ok) {
      throw new Error(`Tidebase request failed: ${response.status} ${await response.text()}`)
    }
    return (await response.json()) as T
  }

  eventSource(path: string) {
    return `${this.url}${path}`
  }
}

export class RunsClient {
  constructor(private readonly client: Tidebase) {}

  async create(workflowName: string, options: RunCreateOptions = {}) {
    const response = await this.client.request<{ run: TideRun }>(
      `/runs/${encodeURIComponent(workflowName)}`,
      {
        method: 'POST',
        body: JSON.stringify(options)
      }
    )
    return response.run
  }

  async list() {
    return this.client.request<{ runs: TideRun[] }>('/runs')
  }

  async get(runId: string) {
    return this.client.request<{
      run: TideRun
      steps: unknown[]
      state: unknown
      recoveryAttempts: unknown[]
      channels: unknown[]
      channelDeliveries: unknown[]
      gates: unknown[]
      events: TideEvent[]
    }>(`/runs/${runId}`)
  }

  async recover(runId: string, reason = 'manual') {
    return this.client.request<{ recoveryAttempt: unknown }>(`/runs/${runId}/recover`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    })
  }

  async *subscribe(runId: string): AsyncGenerator<TideEvent> {
    const EventSourceImpl = globalThis.EventSource
    if (!EventSourceImpl) {
      throw new Error('EventSource is not available in this runtime')
    }
    const source = new EventSourceImpl(this.client.eventSource(`/runs/${runId}/events`))
    const queue: TideEvent[] = []
    let notify: (() => void) | undefined
    let error: unknown

    source.onmessage = (event) => {
      queue.push(JSON.parse(event.data) as TideEvent)
      notify?.()
    }
    source.onerror = () => {
      error = new Error('Tidebase event stream failed')
      notify?.()
    }

    try {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!
          continue
        }
        if (error) throw error
        await new Promise<void>((resolve) => {
          notify = resolve
        })
        notify = undefined
      }
    } finally {
      source.close()
    }
  }
}

export class RunContext {
  readonly state: RunState
  readonly usage: RunUsage

  constructor(
    private readonly client: Tidebase,
    readonly runId: string,
    private readonly leaseOwner: string
  ) {
    this.state = new RunState(client, runId)
    this.usage = new RunUsage(client, runId)
  }

  async step<TResult>(
    name: string,
    fn: () => Promise<TResult> | TResult
  ): Promise<TResult>
  async step<TResult>(
    name: string,
    options: StepOptions,
    fn: () => Promise<TResult> | TResult
  ): Promise<TResult>
  async step<TResult>(
    name: string,
    optionsOrFn: StepOptions | (() => Promise<TResult> | TResult),
    maybeFn?: () => Promise<TResult> | TResult
  ): Promise<TResult> {
    const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
    if (!fn) throw new Error(`Missing function for step ${name}`)

    const inputHash = options.inputHash ?? hashStable(options.input ?? null)
    const begin = await this.client.request<
      | { action: 'return'; output: TResult }
      | { action: 'execute'; step: { id: string }; leaseOwner: string }
      | { action: 'locked'; step: { id: string; name: string } }
      | {
          action: 'input_mismatch'
          step: { id: string; name: string }
          expectedInputHash: string
          actualInputHash: string
        }
    >(`/runs/${this.runId}/steps/begin`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        inputHash,
        input: options.input ?? null,
        options,
        leaseOwner: this.leaseOwner
      })
    })

    if (begin.action === 'return') return begin.output
    if (begin.action === 'input_mismatch') {
      throw new Error(
        `Step ${name} input hash changed for this run. Expected ${begin.expectedInputHash}, got ${begin.actualInputHash}`
      )
    }
    if (begin.action === 'locked') {
      throw new Error(`Step ${name} is currently leased by another worker`)
    }

    const attempts = Math.max(1, (options.retries ?? 0) + 1)
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await withTimeout(fn(), options.timeoutMs)
        await this.client.request(
          `/runs/${this.runId}/steps/${begin.step.id}/complete`,
          {
            method: 'POST',
            body: JSON.stringify({
              leaseOwner: begin.leaseOwner,
              output: result
            })
          }
        )
        return result
      } catch (error) {
        const retryable = attempt < attempts
        await this.client.request(`/runs/${this.runId}/steps/${begin.step.id}/fail`, {
          method: 'POST',
          body: JSON.stringify({
            leaseOwner: begin.leaseOwner,
            retryable,
            resumeDecision: retryable ? 'auto_retry' : classifyResumeDecision(options),
            error: serializeError(error)
          })
        }).catch(() => undefined)
        if (!retryable) throw error
      }
    }
    throw new Error(`Step ${name} failed`)
  }

  async gate(name: string, options: GateOptions): Promise<GateDecision> {
    const begin = await this.client.request<{
      action: 'wait' | 'return'
      gate: {
        id: string
        name: string
        status: string
        decision: 'approved' | 'rejected' | 'canceled' | null
        actor: string | null
        decisionPayload: unknown
      }
    }>(`/runs/${this.runId}/gates/begin`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        prompt: options.prompt,
        data: options.data ?? {},
        channels: options.channels ?? [],
        capability: options.capability ?? null,
        timeoutMs: options.timeoutMs
      })
    })

    const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : null
    let gate = begin.gate
    while (gate.status === 'pending') {
      if (deadline && Date.now() > deadline) {
        throw new Error(`Gate ${name} timed out`)
      }
      await sleep(options.pollMs ?? 1000)
      const response = await this.client.request<{ gate: typeof gate }>(
        `/runs/${this.runId}/gates/${gate.id}`
      )
      gate = response.gate
    }

    if (gate.decision !== 'approved' && gate.decision !== 'rejected' && gate.decision !== 'canceled') {
      throw new Error(`Gate ${name} resolved with unsupported decision ${gate.decision}`)
    }

    return {
      gateId: gate.id,
      name: gate.name,
      status: gate.status,
      decision: gate.decision,
      actor: gate.actor,
      payload: gate.decisionPayload
    }
  }
}

function classifyResumeDecision(options: StepOptions) {
  if (options.replay === 'manual' || options.onAmbiguousFailure === 'review') {
    return 'manual_review'
  }
  if (options.replay === 'never' || options.onAmbiguousFailure === 'fail') {
    return 'fail_hard'
  }
  if (options.replay === 'auto' || options.onAmbiguousFailure === 'retry') {
    return 'safe_replay'
  }
  const namedSideEffects = options.sideEffects?.filter(Boolean) ?? []
  const legacySideEffect = options.sideEffect ?? 'none'
  const writesExternally =
    namedSideEffects.length > 0 || legacySideEffect === 'write' || legacySideEffect === 'external'
  if (writesExternally && !options.idempotencyKey) {
    return 'manual_review'
  }
  return 'fail_hard'
}

export class RunUsage {
  constructor(
    private readonly client: Tidebase,
    private readonly runId: string
  ) {}

  async record(options: UsageRecordOptions) {
    return this.client.request(`/runs/${this.runId}/usage`, {
      method: 'POST',
      body: JSON.stringify(options)
    })
  }
}

export class RunState {
  constructor(
    private readonly client: Tidebase,
    private readonly runId: string
  ) {}

  async set(value: unknown) {
    return this.client.request(`/runs/${this.runId}/state`, {
      method: 'PUT',
      body: JSON.stringify({ value })
    })
  }

  async patch(value: Record<string, unknown>) {
    return this.client.request(`/runs/${this.runId}/state`, {
      method: 'PATCH',
      body: JSON.stringify({ value })
    })
  }
}

function stripTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function hashStable(value: unknown) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`
}

async function withTimeout<T>(promiseOrValue: Promise<T> | T, timeoutMs?: number) {
  if (!timeoutMs) return await promiseOrValue
  return await Promise.race([
    promiseOrValue,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
    })
  ])
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  }
  return { message: String(error) }
}

function verifySignature(body: string, signatureHeader: string | null, secret: string) {
  if (!signatureHeader?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  const actual = signatureHeader.slice('sha256='.length)
  const expectedBuffer = Buffer.from(expected, 'hex')
  const actualBuffer = Buffer.from(actual, 'hex')
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  )
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

export function newRunId() {
  return `run_${randomUUID().replaceAll('-', '')}`
}
