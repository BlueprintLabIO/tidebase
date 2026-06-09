<script lang="ts">
  import { onMount } from 'svelte'
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import {
    Activity,
    CheckCircle2,
    Clock3,
    Copy,
    Database,
    GitBranch,
    RefreshCw,
    RotateCcw,
    Search,
    Server,
    ShieldAlert,
    Webhook,
    XCircle
  } from '@lucide/svelte'

  const API = import.meta.env.VITE_TIDEBASE_API ?? 'http://localhost:7373'

  type ConsoleView = 'runs' | 'checkpoints' | 'recovery' | 'postgres'
  type RunTab = 'steps' | 'state' | 'usage' | 'recovery' | 'events'
  type RunStatus = 'created' | 'running' | 'completed' | 'failed' | string

  type Run = {
    id: string
    workflowName: string
    status: RunStatus
    createdAt: string
    updatedAt: string
    completedAt?: string | null
    attempt?: number
  }

  type Step = {
    id: string
    name: string
    status: RunStatus
    attempt: number
    resumeContract?: ResumeContract
    output: unknown
    error: unknown
  }

  type Gate = {
    id: string
    name: string
    prompt: string
    data: unknown
    status: string
    decision: string | null
    actor: string | null
    decisionPayload: unknown
    capability: unknown
    resolveToken: string
    createdAt: string
    resolvedAt: string | null
  }

  type ChannelDelivery = {
    id: string
    eventType: string
    status: string
    httpStatus: number | null
    errorText: string | null
    createdAt: string
  }

  type UsageRecord = {
    id: string
    kind: string
    provider: string | null
    model: string | null
    label: string | null
    quantity: number | null
    unit: string | null
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    costUsd: number | null
    createdAt: string
  }

  type ResumeContract = {
    sideEffects: string[]
    idempotencyKey: string | null
    replay: 'auto' | 'manual' | 'never' | string
    checkpointInvariant: unknown
    verifiedBy: unknown
  }

  type RunEvent = {
    id: number
    type: string
    payload: unknown
    createdAt: string
  }

  type RecoveryAttempt = {
    id: string
    reason: string
    status: string
    httpStatus: number | null
    errorText: string | null
    createdAt: string
  }

  type RunDetail = {
    run: Run & {
      input?: unknown
      metadata?: Record<string, unknown>
      result?: unknown
      error?: unknown
      recoveryWebhook?: string | null
    }
    steps: Step[]
    state: { value: unknown; version: number } | null
    recoveryAttempts: RecoveryAttempt[]
    channelDeliveries: ChannelDelivery[]
    gates: Gate[]
    usage: UsageRecord[]
    events: RunEvent[]
  }

  const viewMeta: Record<ConsoleView, { title: string; subtitle: string }> = {
    runs: {
      title: 'Runs',
      subtitle: 'Triage long-running agent workflows from live state and checkpoints.'
    },
    checkpoints: {
      title: 'Checkpoints',
      subtitle: 'Inspect replay boundaries, completed step outputs, and failed attempts.'
    },
    recovery: {
      title: 'Control',
      subtitle: 'Resolve gates, inspect recovery, and audit outbound channel delivery.'
    },
    postgres: {
      title: 'Postgres',
      subtitle: 'The self-hosted storage contract behind Tidebase Studio.'
    }
  }

  let activeView = $state<ConsoleView>('runs')
  let selectedTab = $state<RunTab>('steps')
  let selectedRunId = $state<string | null>(null)
  let query = $state('')
  let streamState = $state<'idle' | 'connected' | 'disconnected'>('idle')
  let source: EventSource | null = null
  const queryClient = useQueryClient()

  const runsQuery = createQuery<{ runs: Run[] }>(() => ({
    queryKey: ['runs'],
    queryFn: () => get<{ runs: Run[] }>('/runs'),
    refetchInterval: 2500
  }))

  const detailQuery = createQuery<RunDetail | null>(() => ({
    queryKey: ['runs', selectedRunId],
    queryFn: () => (selectedRunId ? get<RunDetail>(`/runs/${selectedRunId}`) : null),
    enabled: Boolean(selectedRunId)
  }))

  const runs = $derived(runsQuery.data?.runs ?? [])
  const detail = $derived(detailQuery.data ?? null)
  const filteredRuns = $derived.by(() =>
    query.trim()
      ? runs.filter((run) =>
        [run.id, run.workflowName, run.status].some((value) =>
          value.toLowerCase().includes(query.trim().toLowerCase())
        )
      )
      : runs
  )

  const metrics = $derived.by(() =>
    runs.reduce(
      (result, run) => {
      if (run.status === 'completed') result.completed += 1
      if (run.status === 'running') result.running += 1
      if (run.status === 'failed') result.failed += 1
      return result
      },
      { completed: 0, running: 0, failed: 0 }
    )
  )

  const selectedRun = $derived(detail?.run ?? runs.find((run) => run.id === selectedRunId) ?? null)
  const completedSteps = $derived(detail?.steps.filter((step) => step.status === 'completed').length ?? 0)
  const failedSteps = $derived(detail?.steps.filter((step) => step.status.includes('failed') || step.status === 'manual_review').length ?? 0)
  const latestError = $derived(
    detail?.steps.find((step) => step.status.includes('failed') || step.status === 'manual_review')?.error ?? detail?.run.error ?? null
  )
  const usageTotals = $derived.by(() =>
    (detail?.usage ?? []).reduce(
      (result, usage) => {
        result.inputTokens += usage.inputTokens ?? 0
        result.outputTokens += usage.outputTokens ?? 0
        result.totalTokens += usage.totalTokens ?? 0
        result.costUsd += usage.costUsd ?? 0
        return result
      },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
    )
  )
  const loadingError = $derived(
    runsQuery.error instanceof Error
      ? runsQuery.error.message
      : detailQuery.error instanceof Error
        ? detailQuery.error.message
        : null
  )
  const lastRefresh = $derived(runsQuery.dataUpdatedAt ? new Date(runsQuery.dataUpdatedAt) : null)

  onMount(() => {
    return () => {
      closeStream()
    }
  })

  $effect(() => {
    if (!selectedRunId && runs[0]) {
      selectedRunId = runs[0].id
    }
  })

  $effect(() => {
    if (selectedRunId) {
      openStream(selectedRunId)
    }
  })

  async function refreshRuns() {
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
    if (selectedRunId) {
      await queryClient.invalidateQueries({ queryKey: ['runs', selectedRunId] })
    }
  }

  function selectRun(runId: string) {
    selectedRunId = runId
    activeView = 'runs'
    selectedTab = 'steps'
  }

  function openStream(runId: string) {
    if (source?.url.endsWith(`/runs/${runId}/events`)) return
    closeStream()
    source = new EventSource(`${API}/runs/${runId}/events`)
    streamState = 'connected'
    source.onmessage = () => {
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
      void queryClient.invalidateQueries({ queryKey: ['runs', runId] })
    }
    source.onerror = () => {
      streamState = 'disconnected'
    }
  }

  function closeStream() {
    source?.close()
    source = null
    streamState = 'idle'
  }

  async function copy(text: string) {
    await navigator.clipboard?.writeText(text)
  }

  async function resolveGate(gate: Gate, decision: 'approved' | 'rejected') {
    if (!selectedRunId) return
    await post(`/runs/${selectedRunId}/gates/${gate.id}/resolve`, {
      token: gate.resolveToken,
      decision,
      actor: 'studio:local',
      payload: { source: 'studio' }
    })
    await refreshRuns()
  }

  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${API}${path}`)
    if (!response.ok) throw new Error(await response.text())
    return (await response.json()) as T
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(await response.text())
    return (await response.json()) as T
  }

  function formatTime(value?: string | null) {
    if (!value) return '-'
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(value))
  }

  function json(value: unknown) {
    return JSON.stringify(value ?? {}, null, 2)
  }

  function contractLabel(contract?: ResumeContract) {
    if (!contract) return 'no contract'
    if (contract.replay === 'auto') return 'safe replay'
    if (contract.replay === 'manual') return 'manual review'
    if (contract.replay === 'never') return 'fail hard'
    return contract.replay
  }

  function sideEffectLabel(contract?: ResumeContract) {
    if (!contract?.sideEffects.length) return 'no side effects'
    return contract.sideEffects.join(', ')
  }

  function credentialLabel(contract?: ResumeContract) {
    const credentials = Array.isArray((contract as ResumeContract & { credentials?: unknown[] } | undefined)?.credentials)
      ? ((contract as ResumeContract & { credentials?: unknown[] }).credentials ?? [])
      : []
    if (!credentials.length) return '-'
    return credentials
      .map((credential) =>
        credential && typeof credential === 'object' && 'name' in credential
          ? String((credential as { name: unknown }).name)
          : 'credential'
      )
      .join(', ')
  }

  function formatCost(value: number | null | undefined) {
    if (!value) return '$0.0000'
    return `$${value.toFixed(4)}`
  }

  function formatNumber(value: number | null | undefined) {
    return new Intl.NumberFormat().format(value ?? 0)
  }
</script>

<svelte:head>
  <title>Tidebase Studio</title>
</svelte:head>

<div class="studio">
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-mark"><img src="/tidebase-mark.svg" alt="" /></span>
      <div>
        <strong>Tidebase</strong>
      </div>
    </div>

    <div class="server-status">
      <span class="project-dot"></span>
      <div>
        <strong>Local alpha</strong>
        <span>{API.replace(/^https?:\/\//, '')}</span>
      </div>
    </div>

    <div class="nav-label">Workspace</div>
    <nav class="nav" aria-label="Studio views">
      <button class:active={activeView === 'runs'} class="nav-button" onclick={() => (activeView = 'runs')}>
        <Activity size={17} /> Runs
      </button>
      <button class:active={activeView === 'checkpoints'} class="nav-button" onclick={() => (activeView = 'checkpoints')}>
        <GitBranch size={17} /> Checkpoints
      </button>
      <button class:active={activeView === 'recovery'} class="nav-button" onclick={() => (activeView = 'recovery')}>
        <RotateCcw size={17} /> Control
      </button>
      <button class:active={activeView === 'postgres'} class="nav-button" onclick={() => (activeView = 'postgres')}>
        <Database size={17} /> Postgres
      </button>
    </nav>
  </aside>

  <section class="main">
    <header class="topbar">
      <div>
        <h1>{viewMeta[activeView].title}</h1>
        <p>{viewMeta[activeView].subtitle}</p>
      </div>
      <div class="top-actions">
        <span class="endpoint"><Server size={16} /> {API.replace(/^https?:\/\//, '')}</span>
        <button class="button" onclick={() => void refreshRuns()}><RefreshCw size={16} /> Refresh</button>
      </div>
    </header>

    <main class="content">
      {#if loadingError}
        <section class="card empty">Could not reach Tidebase API: {loadingError}</section>
      {/if}

      <section class="metrics">
        <div class="card metric-card">
          <div>
            <span class="meta">Total runs</span>
            <strong>{runs.length}</strong>
            <p>Runs stored in Postgres</p>
          </div>
          <span class="icon-box"><Database size={17} /></span>
        </div>
        <div class="card metric-card">
          <div>
            <span class="meta">Completed</span>
            <strong>{metrics.completed}</strong>
            <p>Finished with a result</p>
          </div>
          <span class="chip completed"><CheckCircle2 size={16} /></span>
        </div>
        <div class="card metric-card">
          <div>
            <span class="meta">Running</span>
            <strong>{metrics.running}</strong>
            <p>Currently leased</p>
          </div>
          <span class="chip running"><RotateCcw size={16} /></span>
        </div>
        <div class="card metric-card">
          <div>
            <span class="meta">Failed</span>
            <strong>{metrics.failed}</strong>
            <p>Needs resume or recovery</p>
          </div>
          <span class="chip failed"><XCircle size={16} /></span>
        </div>
      </section>

      {#if activeView === 'runs'}
        <section class="workspace">
          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Recent Runs</h2>
                <p>{lastRefresh ? `Updated ${formatTime(lastRefresh.toISOString())}` : 'Waiting for data'}</p>
              </div>
              <label class="search">
                <Search size={16} />
                <input bind:value={query} placeholder="Search workflow, status, run id" />
              </label>
            </div>

            <table class="run-table">
              <colgroup>
                <col style="width: 42%;" />
                <col style="width: 23%;" />
                <col style="width: 21%;" />
                <col style="width: 14%;" />
              </colgroup>
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th>Try</th>
                </tr>
              </thead>
              <tbody>
                {#each filteredRuns as run}
                  <tr class:selected={run.id === selectedRunId} onclick={() => selectRun(run.id)}>
                    <td>
                      <div class="workflow-cell">
                        {@render StatusChip(run.status, true)}
                        <div class="truncate">
                          <strong>{run.workflowName}</strong>
                          <small class="mono truncate">{run.id}</small>
                        </div>
                      </div>
                    </td>
                    <td>{@render StatusChip(run.status)}</td>
                    <td>{formatTime(run.updatedAt)}</td>
                    <td>{run.attempt ?? 0}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </section>

          {@render RunInspector({
            detail,
            selectedRun,
            selectedTab,
            completedSteps,
            failedSteps,
            latestError,
            streamState,
            usageTotals,
            onTab: (tab) => (selectedTab = tab),
            onCopy: (text) => void copy(text)
          })}
        </section>
      {:else if activeView === 'checkpoints'}
        {@render CheckpointsView(detail)}
      {:else if activeView === 'recovery'}
        {@render RecoveryView(detail, (gate, decision) => void resolveGate(gate, decision))}
      {:else}
        {@render PostgresView(API)}
      {/if}
    </main>
  </section>
</div>

{#snippet statusIcon(status: string)}
  {#if status === 'completed'}
    <CheckCircle2 size={15} />
  {:else if status === 'approved'}
    <CheckCircle2 size={15} />
  {:else if status === 'manual_review' || status === 'rejected' || status === 'canceled'}
    <ShieldAlert size={15} />
  {:else if status === 'failed'}
    <XCircle size={15} />
  {:else if status === 'running' || status === 'failed_retryable'}
    <RotateCcw size={15} />
  {:else}
    <Clock3 size={15} />
  {/if}
{/snippet}

{#snippet code(value: unknown)}
  <pre class="code mono">{json(value)}</pre>
{/snippet}

{#snippet empty(label: string)}
  <div class="empty">{label}</div>
{/snippet}

{#snippet fact(label: string, value: string, mono = false)}
  <div class="fact">
    <span class="meta">{label}</span>
    <strong class={mono ? 'mono truncate' : 'truncate'}>{value}</strong>
  </div>
{/snippet}

{#snippet StatusChip(status: string, iconOnly = false)}
  <span class="badge {status}">
    {@render statusIcon(status)}
    {#if !iconOnly}
      {status}
    {/if}
  </span>
{/snippet}

{#snippet RunInspector(props: {
  detail: RunDetail | null
  selectedRun: Run | null
  selectedTab: RunTab
  completedSteps: number
  failedSteps: number
  latestError: unknown
  streamState: string
  usageTotals: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }
  onTab: (tab: RunTab) => void
  onCopy: (text: string) => void
})}
  <section class="panel">
    {#if !props.selectedRun}
      {@render empty('No runs yet. Start the example workflow to populate Studio.')}
    {:else}
      <div class="detail-head">
        <div class="detail-title">
          <div>
            <span class="meta">Workflow</span>
            <h2>{props.selectedRun.workflowName}</h2>
          </div>
          <div class="top-actions">
            {@render StatusChip(props.selectedRun.status)}
            <span class="badge {props.streamState}">SSE {props.streamState}</span>
            <button class="button" onclick={() => props.onCopy(props.selectedRun?.id ?? '')}>
              <Copy size={15} /> Copy id
            </button>
          </div>
        </div>
        <div class="facts">
          {@render fact('Run id', props.selectedRun.id, true)}
          {@render fact('Attempt', String(props.selectedRun.attempt ?? 0))}
          {@render fact('Updated', formatTime(props.selectedRun.updatedAt))}
          {@render fact('Checkpoints', `${props.completedSteps}/${props.detail?.steps.length ?? 0}`)}
          {@render fact('Cost', formatCost(props.usageTotals.costUsd))}
        </div>
        {#if props.latestError}
          <div class="step-card">
            <strong>Latest error</strong>
            <div class="meta">The failed run stopped here. Resume or recovery should continue after completed checkpoints.</div>
            <div style="margin-top: 10px;">{@render code(props.latestError)}</div>
          </div>
        {/if}
      </div>

      <div class="tabs">
        {#each ['steps', 'state', 'usage', 'recovery', 'events'] as tab}
          <button class:active={props.selectedTab === tab} class="tab" onclick={() => props.onTab(tab as RunTab)}>
            {tab}
          </button>
        {/each}
      </div>

      <div class="tab-body">
        {#if props.selectedTab === 'steps'}
          <div class="step-list">
            {#each props.detail?.steps ?? [] as step, index}
              <div class="step-row">
                <div class="step-track">
                  <span class="chip {step.status}">{@render statusIcon(step.status)}</span>
                  {#if index < (props.detail?.steps.length ?? 0) - 1}<span class="track-line"></span>{/if}
                </div>
                <div class="step-card">
                  <div class="step-top">
                    <div>
                      <strong>{step.name}</strong>
                      <small>{step.status}</small>
                    </div>
                    <div class="step-actions">
                      <span class="badge {step.resumeContract?.replay === 'manual' ? 'manual_review' : step.resumeContract?.replay === 'auto' ? 'completed' : 'failed'}">
                        {contractLabel(step.resumeContract)}
                      </span>
                      <span class="badge">attempt {step.attempt}</span>
                    </div>
                  </div>
                  <div class="contract-grid">
                    <div>
                      <span class="meta">Side effects</span>
                      <strong class="truncate">{sideEffectLabel(step.resumeContract)}</strong>
                    </div>
                    <div>
                      <span class="meta">Idempotency</span>
                      <strong class="mono truncate">{step.resumeContract?.idempotencyKey ?? '-'}</strong>
                    </div>
                    <div>
                      <span class="meta">Checkpoint invariant</span>
                      <strong class="truncate">
                        {typeof step.resumeContract?.checkpointInvariant === 'string'
                          ? step.resumeContract.checkpointInvariant
                          : step.resumeContract?.checkpointInvariant
                            ? JSON.stringify(step.resumeContract.checkpointInvariant)
                            : '-'}
                      </strong>
                    </div>
                    <div>
                      <span class="meta">Credentials</span>
                      <strong class="truncate">{credentialLabel(step.resumeContract)}</strong>
                    </div>
                  </div>
                  {#if step.error}
                    <div style="margin-top: 10px;">{@render code(step.error)}</div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {:else if props.selectedTab === 'state'}
          {@render code(props.detail?.state?.value ?? {})}
        {:else if props.selectedTab === 'usage'}
          <div class="usage-summary">
            <div class="fact">
              <span class="meta">Input tokens</span>
              <strong>{formatNumber(props.usageTotals.inputTokens)}</strong>
            </div>
            <div class="fact">
              <span class="meta">Output tokens</span>
              <strong>{formatNumber(props.usageTotals.outputTokens)}</strong>
            </div>
            <div class="fact">
              <span class="meta">Total tokens</span>
              <strong>{formatNumber(props.usageTotals.totalTokens)}</strong>
            </div>
            <div class="fact">
              <span class="meta">Cost</span>
              <strong>{formatCost(props.usageTotals.costUsd)}</strong>
            </div>
          </div>
          <div class="attempt-list usage-list">
            {#each props.detail?.usage ?? [] as usage}
              <div class="attempt-card">
                <span class="badge">{usage.kind}</span>
                <div>
                  <strong>{usage.label ?? usage.provider ?? 'usage'}</strong>
                  <div class="meta">
                    {usage.provider ?? 'custom'}{usage.model ? ` / ${usage.model}` : ''}
                    {usage.totalTokens ? ` / ${formatNumber(usage.totalTokens)} tokens` : ''}
                    {usage.quantity ? ` / ${formatNumber(usage.quantity)} ${usage.unit ?? 'units'}` : ''}
                    {usage.costUsd ? ` / ${formatCost(usage.costUsd)}` : ''}
                  </div>
                </div>
              </div>
            {:else}
              {@render empty('No usage records for this run.')}
            {/each}
          </div>
        {:else if props.selectedTab === 'recovery'}
          <div class="attempt-list">
            {#each props.detail?.recoveryAttempts ?? [] as attempt}
              <div class="attempt-card">
                <span class="chip {attempt.status === 'delivered' ? 'completed' : attempt.status}">
                  {@render statusIcon(attempt.status === 'delivered' ? 'completed' : attempt.status)}
                </span>
                <div>
                  <strong>{attempt.reason}</strong>
                  <div class="meta">
                    {attempt.status}{attempt.httpStatus ? ` / HTTP ${attempt.httpStatus}` : ''}{attempt.errorText ? ` / ${attempt.errorText}` : ''}
                  </div>
                </div>
              </div>
            {:else}
              {@render empty('No recovery attempts for this run.')}
            {/each}
          </div>
        {:else}
          <div class="event-list">
            {#each props.detail?.events ?? [] as event}
              <div class="event-card">
                <div class="event-top">
                  <strong>{event.type}</strong>
                  <span class="meta">{formatTime(event.createdAt)}</span>
                </div>
                <div style="margin-top: 10px;">{@render code(event.payload)}</div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </section>
{/snippet}

{#snippet CheckpointsView(detail: RunDetail | null)}
  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>Checkpoint Table</h2>
        <p>{detail ? `${detail.run.workflowName} / ${detail.run.id}` : 'Select a run first'}</p>
      </div>
    </div>
    {#if detail}
      <table class="run-table">
        <thead>
          <tr>
            <th>Step</th>
            <th>Status</th>
            <th>Attempt</th>
            <th>Replay</th>
            <th>Side effects</th>
            <th>Checkpoint payload</th>
          </tr>
        </thead>
        <tbody>
          {#each detail.steps as step}
            <tr>
              <td>{step.name}</td>
              <td>{@render StatusChip(step.status)}</td>
              <td>{step.attempt}</td>
              <td><span class="badge {step.resumeContract?.replay === 'manual' ? 'manual_review' : step.resumeContract?.replay === 'auto' ? 'completed' : 'failed'}">{contractLabel(step.resumeContract)}</span></td>
              <td><span class="mono truncate">{sideEffectLabel(step.resumeContract)}</span></td>
              <td><span class="mono truncate">{step.status === 'completed' ? JSON.stringify(step.output ?? {}) : JSON.stringify(step.error ?? {})}</span></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <div class="tab-body">{@render empty('Select a run in the Runs view to inspect checkpoints.')}</div>
    {/if}
  </section>
{/snippet}

{#snippet RecoveryView(detail: RunDetail | null, onResolve: (gate: Gate, decision: 'approved' | 'rejected') => void)}
  <section class="workspace">
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Webhook</h2>
          <p>{detail?.run.recoveryWebhook ? 'Configured for selected run' : 'No webhook configured'}</p>
        </div>
        <Webhook size={19} />
      </div>
      <div class="tab-body">
        {@render code({
          runId: detail?.run.id,
          webhook: detail?.run.recoveryWebhook,
          attempts: detail?.recoveryAttempts.length ?? 0,
          gates: detail?.gates.length ?? 0,
          channelDeliveries: detail?.channelDeliveries.length ?? 0
        })}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Attempts</h2>
          <p>Delivery records written by Tidebase.</p>
        </div>
      </div>
      <div class="tab-body attempt-list">
        {#each detail?.recoveryAttempts ?? [] as attempt}
          <div class="attempt-card">
            <span class="chip {attempt.status === 'delivered' ? 'completed' : attempt.status}">
              {@render statusIcon(attempt.status === 'delivered' ? 'completed' : attempt.status)}
            </span>
            <div>
              <strong>{attempt.reason}</strong>
              <div class="meta">{attempt.status}{attempt.httpStatus ? ` / HTTP ${attempt.httpStatus}` : ''}</div>
            </div>
          </div>
        {:else}
          {@render empty('No recovery attempts for this run.')}
        {/each}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Gates</h2>
          <p>Durable decisions for selected run.</p>
        </div>
      </div>
      <div class="tab-body attempt-list">
        {#each detail?.gates ?? [] as gate}
          <div class="attempt-card">
            <span class="chip {gate.status === 'approved' ? 'completed' : gate.status === 'pending' ? 'running' : 'manual_review'}">
              {@render statusIcon(gate.status)}
            </span>
            <div class="gate-copy">
              <strong>{gate.name}</strong>
              <div class="meta">{gate.status}{gate.actor ? ` / ${gate.actor}` : ''}</div>
              <div class="subtle">{gate.prompt}</div>
            </div>
            {#if gate.status === 'pending'}
              <div class="step-actions">
                <button class="button compact" onclick={() => onResolve(gate, 'approved')}>Approve</button>
                <button class="button compact danger" onclick={() => onResolve(gate, 'rejected')}>Reject</button>
              </div>
            {/if}
          </div>
        {:else}
          {@render empty('No gates for this run.')}
        {/each}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Channel Deliveries</h2>
          <p>Outbound notifications written by Tidebase.</p>
        </div>
      </div>
      <div class="tab-body attempt-list">
        {#each detail?.channelDeliveries ?? [] as delivery}
          <div class="attempt-card">
            <span class="chip {delivery.status === 'delivered' ? 'completed' : delivery.status === 'pending' ? 'running' : 'failed'}">
              {@render statusIcon(delivery.status === 'delivered' ? 'completed' : delivery.status)}
            </span>
            <div>
              <strong>{delivery.eventType}</strong>
              <div class="meta">{delivery.status}{delivery.httpStatus ? ` / HTTP ${delivery.httpStatus}` : ''}{delivery.errorText ? ` / ${delivery.errorText}` : ''}</div>
            </div>
          </div>
        {:else}
          {@render empty('No channel deliveries for this run.')}
        {/each}
      </div>
    </div>
  </section>
{/snippet}

{#snippet PostgresView(apiUrl: string)}
  <section class="workspace">
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Server</h2>
          <p>Self-hosted full stack, backed by your Postgres instance.</p>
        </div>
        <Server size={19} />
      </div>
      <div class="tab-body">
        {@render code({ api: apiUrl, database: 'Postgres', migrations: 'migrations/001_init.sql', studio: 'SvelteKit' })}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Tables</h2>
          <p>Current v1 primitives.</p>
        </div>
      </div>
      <div class="tab-body table-list">
        {#each ['runs', 'steps', 'run_state', 'events', 'recovery_attempts', 'channels', 'channel_deliveries', 'gates'] as table}
          <div class="table-card mono">{table}</div>
        {/each}
      </div>
    </div>
  </section>
{/snippet}
