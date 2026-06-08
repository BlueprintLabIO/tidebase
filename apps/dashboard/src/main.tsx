import React from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, CheckCircle2, CircleDot, RefreshCw, XCircle } from 'lucide-react'
import './styles.css'

const API = import.meta.env.VITE_TIDEBASE_API ?? 'http://localhost:7373'

type Run = {
  id: string
  workflowName: string
  status: string
  createdAt: string
  updatedAt: string
}

type Step = {
  id: string
  name: string
  status: string
  attempt: number
  inputHash: string
  output: unknown
  error: unknown
}

type Event = {
  id: number
  seq: number
  type: string
  payload: unknown
  createdAt: string
}

type RunDetail = {
  run: Run
  steps: Step[]
  state: { value: unknown; version: number } | null
  recoveryAttempts: Array<{
    id: string
    reason: string
    status: string
    httpStatus: number | null
    errorText: string | null
    createdAt: string
  }>
  events: Event[]
}

function App() {
  const [runs, setRuns] = React.useState<Run[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<RunDetail | null>(null)

  const refreshRuns = React.useCallback(async () => {
    const data = await get<{ runs: Run[] }>('/runs')
    setRuns(data.runs)
    setSelected((current) => current ?? data.runs[0]?.id ?? null)
  }, [])

  const refreshDetail = React.useCallback(async () => {
    if (!selected) return
    setDetail(await get<RunDetail>(`/runs/${selected}`))
  }, [selected])

  React.useEffect(() => {
    void refreshRuns()
    const interval = window.setInterval(refreshRuns, 1500)
    return () => window.clearInterval(interval)
  }, [refreshRuns])

  React.useEffect(() => {
    void refreshDetail()
    if (!selected) return
    const events = new EventSource(`${API}/runs/${selected}/events`)
    events.onmessage = () => {
      void refreshRuns()
      void refreshDetail()
    }
    events.addEventListener('step.started', events.onmessage)
    events.addEventListener('step.completed', events.onmessage)
    events.addEventListener('step.failed', events.onmessage)
    events.addEventListener('state.updated', events.onmessage)
    events.addEventListener('run.completed', events.onmessage)
    events.addEventListener('run.failed', events.onmessage)
    return () => events.close()
  }, [selected, refreshDetail, refreshRuns])

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Tidebase</div>
          <h1>Runs</h1>
        </div>
        <button className="icon-button" onClick={() => void refreshRuns()} title="Refresh">
          <RefreshCw size={18} />
        </button>
      </header>

      <section className="layout">
        <aside className="sidebar">
          <h2>Recent Runs</h2>
          <div className="list">
            {runs.map((run) => (
              <button
                key={run.id}
                className={run.id === selected ? 'run-row active' : 'run-row'}
                onClick={() => setSelected(run.id)}
              >
                <StatusIcon status={run.status} />
                <span>
                  <strong>{run.workflowName}</strong>
                  <small>{run.id}</small>
                </span>
              </button>
            ))}
            {runs.length === 0 ? <p className="empty">No runs yet.</p> : null}
          </div>
        </aside>

        <section className="content">
          {detail ? <RunPanel detail={detail} /> : <p className="empty">Select a run.</p>}
        </section>
      </section>
    </main>
  )
}

function RunPanel({ detail }: { detail: RunDetail }) {
  return (
    <div className="detail">
      <section className="summary">
        <div>
          <div className="eyebrow">Workflow</div>
          <h2>{detail.run.workflowName}</h2>
          <small>{detail.run.id}</small>
        </div>
        <Badge status={detail.run.status} />
      </section>

      <section className="grid">
        <Panel title="Steps">
          <div className="list">
            {detail.steps.map((step) => (
              <div className="step-row" key={step.id}>
                <StatusIcon status={step.status} />
                <span>
                  <strong>{step.name}</strong>
                  <small>
                    {step.status} · attempt {step.attempt}
                  </small>
                </span>
              </div>
            ))}
            {detail.steps.length === 0 ? <p className="empty">No steps recorded.</p> : null}
          </div>
        </Panel>

        <Panel title="State">
          <pre>{JSON.stringify(detail.state?.value ?? {}, null, 2)}</pre>
        </Panel>
      </section>

      <Panel title="Recovery">
        <div className="list">
          {detail.recoveryAttempts.map((attempt) => (
            <div className="step-row" key={attempt.id}>
              <StatusIcon status={attempt.status === 'delivered' ? 'completed' : attempt.status} />
              <span>
                <strong>{attempt.reason}</strong>
                <small>
                  {attempt.status}
                  {attempt.httpStatus ? ` · HTTP ${attempt.httpStatus}` : ''}
                  {attempt.errorText ? ` · ${attempt.errorText}` : ''}
                </small>
              </span>
            </div>
          ))}
          {detail.recoveryAttempts.length === 0 ? (
            <p className="empty">No recovery attempts.</p>
          ) : null}
        </div>
      </Panel>

      <Panel title="Timeline">
        <div className="timeline">
          {detail.events.map((event) => (
            <div className="event-row" key={event.id}>
              <CircleDot size={14} />
              <span>
                <strong>{event.type}</strong>
                <small>{JSON.stringify(event.payload)}</small>
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle2 className="ok" size={18} />
  if (status === 'failed') return <XCircle className="bad" size={18} />
  return <Activity className="active-icon" size={18} />
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`)
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as T
}

createRoot(document.getElementById('root')!).render(<App />)
