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
  queue?: string | null
  dedupeKey?: string | null
  priority?: number
  runAt?: string | null
  maxAttempts?: number
  deadlineAt?: string | null
  cancelRequestedAt?: string | null
  cancelledAt?: string | null
  cancelReason?: string | null
  cancelActor?: string | null
  failureClass?: string | null
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

export type StateVersionImportance = 'transient' | 'normal' | 'checkpoint' | 'milestone'

export type StateWriteOptions = {
  stream?: string
  label?: string
  reason?: string
  importance?: StateVersionImportance
  metadata?: Record<string, unknown>
  createdBy?: string
}

export type StateSaveOptions = Omit<StateWriteOptions, 'label'>

export type StateVersion = {
  id: string
  streamId: string
  runId: string | null
  stepId: string | null
  version: number
  value: unknown
  patch: unknown
  label: string | null
  reason: string | null
  importance: string
  metadata: Record<string, unknown>
  createdBy: string | null
  createdAt: string
}

export type SnapshotCreateOptions = {
  target?: {
    type: string
    id: string
  }
  state: unknown
  reason?: string
  metadata?: Record<string, unknown>
  createdBy?: string
}

export type ChildRunOptions = RunCreateOptions & {
  name?: string
  edgeType?: string
  edgeMetadata?: Record<string, unknown>
}

export type FanoutChild<TInput = unknown, TResult = unknown> = {
  name: string
  workflowName?: string
  input?: TInput
  metadata?: Record<string, unknown>
  recoveryWebhook?: string
  channels?: ChannelOptions[]
  workflow: TideWorkflow<TInput, TResult>
}

export type FanoutOptions = {
  checkpoint?: string
  join?: 'all'
}

export type TideWorkflow<TInput = unknown, TResult = unknown> = (
  run: RunContext,
  input: TInput
) => Promise<TResult> | TResult

export type RecoveryWebhookPayload = {
  type: 'run.resume' | 'run.invoke'
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

export type GateBeginOptions = Omit<GateOptions, 'pollMs'>

export type GateStatus = {
  gateId: string
  name: string
  status: string
  decision: 'approved' | 'rejected' | 'canceled' | null
  actor: string | null
  payload: unknown
}

export type AttachOptions = RunOptions & {
  /** Background lease renewal interval. Pass false to manage the lease yourself. */
  heartbeatMs?: number | false
  /** Called once if the lease cannot be renewed (reclaimed by the reconciler,
   * taken over by another worker, or the run was cancelled). After this fires
   * the session is a zombie: its writes will be fenced by the server. */
  onLeaseLost?: (error: Error) => void
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

export type EnqueueOptions = {
  queue?: string
  input?: unknown
  metadata?: Record<string, unknown>
  recoveryWebhook?: string
  channels?: ChannelOptions[]
  dedupeKey?: string
  delayMs?: number
  runAt?: string | Date
  maxAttempts?: number
  priority?: number
  deadlineMs?: number
}

export type WorkOptions = {
  queues?: string[]
  leaseOwner?: string
  pollMs?: number
  limit?: number
  signal?: AbortSignal
  onError?: (error: unknown, run: TideRun) => void
}

export type QueueConfigOptions = {
  concurrency?: number | null
  ratePerMinute?: number | null
  invokeUrl?: string | null
}

export type ScheduleOptions = {
  cron: string
  workflowName: string
  input?: unknown
  queue?: string
  maxAttempts?: number
  enabled?: boolean
}

/** The run was cancelled (by an operator, a deadline, or the API) while this
 * worker held it. Workflows should let this propagate. */
export class RunCancelledError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} was cancelled`)
    this.name = 'RunCancelledError'
  }
}

export class Tidebase {
  readonly runs: RunsClient
  readonly queues: QueuesClient
  readonly schedules: SchedulesClient
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
    this.queues = new QueuesClient(this)
    this.schedules = new SchedulesClient(this)
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
      if (payload.type !== 'run.resume' && payload.type !== 'run.invoke') {
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
    return this.execute(run.id, run.input as TInput, begin.leaseOwner, workflow)
  }

  /** Execute a workflow against a run whose lease this worker already holds. */
  private async execute<TInput, TResult>(
    runId: string,
    input: TInput,
    leaseOwner: string,
    workflow: TideWorkflow<TInput, TResult>
  ): Promise<TResult> {
    const context = new RunContext(this, runId, leaseOwner)
    try {
      const result = await workflow(context, input)
      await this.request(`/runs/${runId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ result })
      })
      return result
    } catch (error) {
      // A cancelled run is already terminal — reporting failure would be a
      // lifecycle write after the authority has spoken (the server refuses
      // it anyway). Anything else reports failure (and may requeue).
      if (!(error instanceof RunCancelledError)) {
        await this.request(`/runs/${runId}/fail`, {
          method: 'POST',
          body: JSON.stringify({ error: serializeError(error) })
        }).catch(() => undefined)
      }
      throw error
    }
  }

  /** Enqueue a workflow as a durable queued run. Tidebase will hold it until
   * a worker claims it (tide.work) or a push queue dispatches it. */
  async enqueue(workflowName: string, options: EnqueueOptions = {}) {
    const queue = options.queue ?? 'default'
    return this.request<{ run: TideRun; deduplicated: boolean }>(
      `/queues/${encodeURIComponent(queue)}/enqueue`,
      {
        method: 'POST',
        body: JSON.stringify({
          workflowName,
          input: options.input,
          metadata: options.metadata,
          recoveryWebhook: options.recoveryWebhook,
          channels: options.channels,
          dedupeKey: options.dedupeKey,
          delayMs: options.delayMs,
          runAt:
            options.runAt instanceof Date ? options.runAt.toISOString() : options.runAt,
          maxAttempts: options.maxAttempts,
          priority: options.priority,
          deadlineMs: options.deadlineMs
        })
      }
    )
  }

  /** Pull-mode worker loop: claim ready runs from queues and execute their
   * registered workflows (register with tide.workflow(name, fn)). Runs until
   * the AbortSignal fires. */
  async work(options: WorkOptions = {}): Promise<void> {
    const queues = options.queues ?? ['default']
    const pollMs = options.pollMs ?? 1000
    while (!options.signal?.aborted) {
      const claim = await this.request<{ runs: TideRun[]; leaseOwner: string }>(
        '/queues/claim',
        {
          method: 'POST',
          body: JSON.stringify({
            queues,
            leaseOwner: options.leaseOwner,
            limit: options.limit ?? 1
          })
        }
      )
      for (const run of claim.runs) {
        const workflow = this.workflows.get(run.workflowName)
        if (!workflow) {
          await this.request(`/runs/${run.id}/fail`, {
            method: 'POST',
            body: JSON.stringify({
              error: { message: `no workflow registered for ${run.workflowName}` }
            })
          }).catch(() => undefined)
          continue
        }
        try {
          await this.execute(run.id, run.input, claim.leaseOwner, workflow)
        } catch (error) {
          options.onError?.(error, run)
        }
      }
      if (claim.runs.length === 0) {
        await sleep(pollMs)
      }
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
      const text = await response.text()
      try {
        const parsed = JSON.parse(text) as { code?: string }
        if (parsed.code === 'run_cancelled') {
          const match = path.match(/^\/runs\/([^/]+)/)
          throw new RunCancelledError(match?.[1] ?? 'unknown')
        }
      } catch (error) {
        if (error instanceof RunCancelledError) throw error
      }
      throw new Error(`Tidebase request failed: ${response.status} ${text}`)
    }
    return (await response.json()) as T
  }

  eventSource(path: string) {
    // EventSource cannot set headers, so the server accepts the API key as a
    // query token on the SSE endpoint when auth is enabled.
    if (!this.apiKey) return `${this.url}${path}`
    const joiner = path.includes('?') ? '&' : '?'
    return `${this.url}${path}${joiner}token=${encodeURIComponent(this.apiKey)}`
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
      stateStreams: unknown[]
      stateVersions: StateVersion[]
      runEdges: unknown[]
      childRuns: TideRun[]
      recoveryAttempts: unknown[]
      channels: unknown[]
      channelDeliveries: unknown[]
      gates: unknown[]
      events: TideEvent[]
    }>(`/runs/${runId}`)
  }

  /** Attach to a run as a session: acquire its lease and return a handle whose
   * step/gate/state calls stay valid until complete()/fail(). Use this when
   * execution is not function-shaped — a protocol gateway, a REPL, a run that
   * spans many requests. Mirrors tide.run() semantics: omit runId to create,
   * pass one to resume an existing run. */
  async attach(workflowName: string, options: AttachOptions = {}): Promise<RunSession> {
    const run =
      options.runId == null
        ? await this.create(workflowName, {
            input: options.input,
            metadata: options.metadata,
            recoveryWebhook: options.recoveryWebhook,
            channels: options.channels
          })
        : await this.get(options.runId).then((detail) => detail.run)

    if (run.workflowName !== workflowName) {
      throw new Error(
        `Run ${run.id} belongs to workflow ${run.workflowName}, not ${workflowName}`
      )
    }
    if (run.status === 'completed') {
      throw new Error(`Run ${run.id} is already completed`)
    }

    const begin = await this.client.request<{ run: TideRun; leaseOwner: string }>(
      `/runs/${run.id}/begin`,
      { method: 'POST' }
    )
    return new RunSession(this.client, begin.run, begin.leaseOwner, options)
  }

  async recover(runId: string, reason = 'manual') {
    return this.client.request<{ recoveryAttempt: unknown }>(`/runs/${runId}/recover`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    })
  }

  /** Cancel a run. Authoritative and one-way: in-flight workers observe it at
   * their next step or gate boundary; complete/fail cannot resurrect it. */
  async cancel(runId: string, options: { reason?: string; actor?: string } = {}) {
    const response = await this.client.request<{ run: TideRun }>(`/runs/${runId}/cancel`, {
      method: 'POST',
      body: JSON.stringify(options)
    })
    return response.run
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

export class QueuesClient {
  constructor(private readonly client: Tidebase) {}

  async configure(name: string, config: QueueConfigOptions) {
    return this.client.request<{ config: unknown }>(
      `/queues/${encodeURIComponent(name)}/config`,
      { method: 'PUT', body: JSON.stringify(config) }
    )
  }

  async list() {
    return this.client.request<{
      queues: Array<{
        name: string
        queued: number
        running: number
        failed: number
        completed: number
        cancelled: number
        config: QueueConfigOptions | null
      }>
    }>('/queues')
  }
}

export class SchedulesClient {
  constructor(private readonly client: Tidebase) {}

  async set(name: string, options: ScheduleOptions) {
    return this.client.request<{ schedule: unknown }>(
      `/schedules/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify(options) }
    )
  }

  async list() {
    return this.client.request<{ schedules: unknown[] }>('/schedules')
  }

  async delete(name: string) {
    return this.client.request<{ deleted: string }>(
      `/schedules/${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    )
  }
}

export class RunContext {
  readonly state: RunState
  readonly usage: RunUsage
  readonly snapshots: RunSnapshots
  readonly gates: RunGates

  constructor(
    protected readonly client: Tidebase,
    readonly runId: string,
    protected readonly leaseOwner: string
  ) {
    this.state = new RunState(client, runId)
    this.usage = new RunUsage(client, runId)
    this.snapshots = new RunSnapshots(client, runId)
    this.gates = new RunGates(client, runId)
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
    const beginStep = () =>
      this.client.request<
        | { action: 'return'; output: TResult }
        | { action: 'execute'; step: { id: string }; leaseOwner: string }
        | { action: 'locked'; step: { id: string; name: string } }
        | { action: 'cancelled' }
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

    const begin = await beginStep()
    if (begin.action === 'return') return begin.output
    if (begin.action === 'cancelled') throw new RunCancelledError(this.runId)
    if (begin.action === 'input_mismatch') {
      throw new Error(
        `Step ${name} input hash changed for this run. Expected ${begin.expectedInputHash}, got ${begin.actualInputHash}`
      )
    }
    if (begin.action === 'locked') {
      throw new Error(`Step ${name} is currently leased by another worker`)
    }

    const attempts = Math.max(1, (options.retries ?? 0) + 1)
    let current = begin
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        // A retryable failure releases the lease server-side, so each retry must
        // re-begin the step to acquire a fresh lease before reporting results.
        const again = await beginStep()
        if (again.action === 'return') return again.output
        if (again.action === 'cancelled') throw new RunCancelledError(this.runId)
        if (again.action === 'locked') {
          throw new Error(`Step ${name} is currently leased by another worker`)
        }
        if (again.action === 'input_mismatch') {
          throw new Error(
            `Step ${name} input hash changed for this run. Expected ${again.expectedInputHash}, got ${again.actualInputHash}`
          )
        }
        current = again
      }
      try {
        const result = await withTimeout(fn(), options.timeoutMs)
        await this.client.request(
          `/runs/${this.runId}/steps/${current.step.id}/complete`,
          {
            method: 'POST',
            body: JSON.stringify({
              leaseOwner: current.leaseOwner,
              output: result
            })
          }
        )
        return result
      } catch (error) {
        const retryable = attempt < attempts
        await this.client.request(`/runs/${this.runId}/steps/${current.step.id}/fail`, {
          method: 'POST',
          body: JSON.stringify({
            leaseOwner: current.leaseOwner,
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

  /** Open a gate and block until it resolves. Convenience over gates.begin()
   * + gates.get(); use those directly when you cannot block on a human. */
  async gate(name: string, options: GateOptions): Promise<GateDecision> {
    let gate = await this.gates.begin(name, options)

    const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : null
    while (gate.status === 'pending') {
      if (deadline && Date.now() > deadline) {
        throw new Error(`Gate ${name} timed out`)
      }
      await sleep(options.pollMs ?? 1000)
      gate = await this.gates.get(gate.gateId)
    }

    if (gate.decision !== 'approved' && gate.decision !== 'rejected' && gate.decision !== 'canceled') {
      throw new Error(`Gate ${name} resolved with unsupported decision ${gate.decision}`)
    }

    return { ...gate, decision: gate.decision }
  }

  async child<TInput = unknown, TResult = unknown>(
    workflowName: string,
    options: ChildRunOptions,
    workflow: TideWorkflow<TInput, TResult>
  ): Promise<TResult> {
    const edgeName = options.name ?? workflowName
    const response = await this.client.request<{
      run: TideRun
      edge: unknown
      created: boolean
    }>(`/runs/${this.runId}/children`, {
      method: 'POST',
      body: JSON.stringify({
        name: edgeName,
        workflowName,
        input: options.input,
        metadata: options.metadata,
        recoveryWebhook: options.recoveryWebhook,
        channels: options.channels,
        edgeType: options.edgeType ?? 'child',
        edgeMetadata: options.edgeMetadata
      })
    })

    return this.client.run(workflowName, { runId: response.run.id }, workflow)
  }

  async fanout<TResult = unknown>(
    name: string,
    children: FanoutChild[],
    options: FanoutOptions = {}
  ): Promise<TResult[]> {
    const results = await Promise.all(
      children.map((child) =>
        this.child(
          child.workflowName ?? child.name,
          {
            name: child.name,
            input: child.input,
            metadata: child.metadata,
            recoveryWebhook: child.recoveryWebhook,
            channels: child.channels,
            edgeType: 'fanout',
            edgeMetadata: { fanout: name }
          },
          child.workflow
        )
      )
    )

    return this.step(
      `join:${options.checkpoint ?? name}`,
      {
        input: {
          fanout: name,
          join: options.join ?? 'all',
          children: children.map((child) => child.name)
        },
        replay: 'auto',
        checkpointInvariant: 'all child run results were collected'
      },
      () => results as TResult[]
    )
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
  // Mirrors the server's inferReplay: steps without declared side effects (or
  // read-only ones) are presumed safe to replay; external writes need an
  // idempotency key to qualify.
  const namedSideEffects = options.sideEffects?.filter(Boolean) ?? []
  const legacySideEffect = options.sideEffect ?? 'none'
  const readsOnly = namedSideEffects.length > 0 && namedSideEffects.every((effect) => effect === 'read')
  const writesExternally =
    (namedSideEffects.length > 0 && !readsOnly) ||
    legacySideEffect === 'write' ||
    legacySideEffect === 'external'
  if (writesExternally && !options.idempotencyKey) {
    return 'manual_review'
  }
  return 'safe_replay'
}

/** A run handle for session-shaped work: open-ended execution that is not a
 * single workflow function (protocol gateways, REPLs, runs that span many
 * requests). Holds the run lease via a background heartbeat and reports the
 * terminal state explicitly through complete()/fail(). If the process dies,
 * the heartbeat stops, the lease expires, and the reconciler takes over —
 * exactly as if a workflow worker had crashed. */
export class RunSession extends RunContext {
  private heartbeatTimer?: ReturnType<typeof setInterval>

  constructor(
    client: Tidebase,
    readonly run: TideRun,
    leaseOwner: string,
    options: Pick<AttachOptions, 'heartbeatMs' | 'onLeaseLost'> = {}
  ) {
    super(client, run.id, leaseOwner)
    const heartbeatMs = options.heartbeatMs ?? 20_000
    if (heartbeatMs !== false) {
      this.heartbeatTimer = setInterval(() => {
        this.heartbeat().catch((error) => {
          this.stopHeartbeat()
          options.onLeaseLost?.(error instanceof Error ? error : new Error(String(error)))
        })
      }, heartbeatMs)
      // Renewal must not keep an otherwise-finished process alive.
      ;(this.heartbeatTimer as { unref?: () => void }).unref?.()
    }
  }

  /** Renew the run lease once. Throws if the lease was lost — the session is
   * then a zombie and the server will fence its writes. */
  async heartbeat() {
    await this.client.request(`/runs/${this.runId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ leaseOwner: this.leaseOwner })
    })
  }

  async complete<TResult>(result: TResult) {
    this.stopHeartbeat()
    await this.client.request(`/runs/${this.runId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ result })
    })
  }

  async fail(error: unknown) {
    this.stopHeartbeat()
    await this.client.request(`/runs/${this.runId}/fail`, {
      method: 'POST',
      body: JSON.stringify({ error: serializeError(error) })
    })
  }

  /** Stop heartbeating without reporting a terminal state. The lease expires
   * on its own and the reconciler reclaims the run (recovery webhook fires). */
  close() {
    this.stopHeartbeat()
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }
}

type GateRow = {
  id: string
  name: string
  status: string
  decision: 'approved' | 'rejected' | 'canceled' | null
  actor: string | null
  decisionPayload: unknown
}

export class RunGates {
  constructor(
    private readonly client: Tidebase,
    private readonly runId: string
  ) {}

  /** Open (or rejoin) a gate without blocking on its resolution. Idempotent
   * per gate name within a run: re-beginning a resolved gate returns its
   * decision immediately, so retried callers converge on one answer. */
  async begin(name: string, options: GateBeginOptions): Promise<GateStatus> {
    const response = await this.client.request<{ action: 'wait' | 'return'; gate: GateRow }>(
      `/runs/${this.runId}/gates/begin`,
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          prompt: options.prompt,
          data: options.data ?? {},
          channels: options.channels ?? [],
          capability: options.capability ?? null,
          timeoutMs: options.timeoutMs
        })
      }
    )
    return mapGate(response.gate)
  }

  async get(gateId: string): Promise<GateStatus> {
    const response = await this.client.request<{ gate: GateRow; runStatus?: string }>(
      `/runs/${this.runId}/gates/${gateId}`
    )
    if (response.runStatus === 'cancelled') throw new RunCancelledError(this.runId)
    return mapGate(response.gate)
  }
}

function mapGate(gate: GateRow): GateStatus {
  return {
    gateId: gate.id,
    name: gate.name,
    status: gate.status,
    decision: gate.decision,
    actor: gate.actor,
    payload: gate.decisionPayload
  }
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

  async set(value: unknown, options: StateWriteOptions = {}) {
    return this.client.request(`/runs/${this.runId}/state`, {
      method: 'PUT',
      body: JSON.stringify({ value, ...options })
    })
  }

  async patch(value: Record<string, unknown>, options: StateWriteOptions = {}) {
    return this.client.request(`/runs/${this.runId}/state`, {
      method: 'PATCH',
      body: JSON.stringify({ value, ...options })
    })
  }

  async save(label: string, options: StateSaveOptions = {}) {
    return this.client.request<{ stateVersion: StateVersion }>(
      `/runs/${this.runId}/state/save`,
      {
        method: 'POST',
        body: JSON.stringify({ label, ...options })
      }
    )
  }

  async versions(options: { stream?: string; labeled?: boolean } = {}) {
    const params = new URLSearchParams()
    if (options.stream) params.set('stream', options.stream)
    if (options.labeled != null) params.set('labeled', String(options.labeled))
    const suffix = params.size > 0 ? `?${params}` : ''
    return this.client.request<{ stateVersions: StateVersion[] }>(
      `/runs/${this.runId}/state/versions${suffix}`
    )
  }
}

export class RunSnapshots {
  constructor(
    private readonly client: Tidebase,
    private readonly runId: string
  ) {}

  async create(label: string, options: SnapshotCreateOptions) {
    return this.client.request<{ snapshot: StateVersion }>(
      `/runs/${this.runId}/snapshots`,
      {
        method: 'POST',
        body: JSON.stringify({ label, ...options })
      }
    )
  }

  async list() {
    return this.client.request<{ snapshots: StateVersion[] }>(
      `/runs/${this.runId}/snapshots`
    )
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
