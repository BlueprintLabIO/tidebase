import * as React from "react"
import { createRoot } from "react-dom/client"
import {
  ActivityIcon,
  CheckCircle2Icon,
  Clock3Icon,
  CopyIcon,
  DatabaseIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  ServerIcon,
  WebhookIcon,
  XCircleIcon,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import "./styles.css"

const API = import.meta.env.VITE_TIDEBASE_API ?? "http://localhost:7373"

type RunStatus = "created" | "running" | "completed" | "failed" | string

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
  output: unknown
  error: unknown
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
  events: RunEvent[]
}

function App() {
  const [runs, setRuns] = React.useState<Run[]>([])
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<RunDetail | null>(null)
  const [query, setQuery] = React.useState("")
  const [lastRefresh, setLastRefresh] = React.useState<Date | null>(null)

  const refreshRuns = React.useCallback(async () => {
    const data = await get<{ runs: Run[] }>("/runs")
    setRuns(data.runs)
    setSelectedRunId((current) => current ?? data.runs[0]?.id ?? null)
    setLastRefresh(new Date())
  }, [])

  const refreshDetail = React.useCallback(async () => {
    if (!selectedRunId) return
    setDetail(await get<RunDetail>(`/runs/${selectedRunId}`))
  }, [selectedRunId])

  React.useEffect(() => {
    void refreshRuns()
    const interval = window.setInterval(refreshRuns, 2500)
    return () => window.clearInterval(interval)
  }, [refreshRuns])

  React.useEffect(() => {
    void refreshDetail()
    if (!selectedRunId) return

    const events = new EventSource(`${API}/runs/${selectedRunId}/events`)
    events.onmessage = () => {
      void refreshRuns()
      void refreshDetail()
    }
    return () => events.close()
  }, [selectedRunId, refreshDetail, refreshRuns])

  const filteredRuns = React.useMemo(() => {
    const value = query.trim().toLowerCase()
    if (!value) return runs
    return runs.filter((run) =>
      [run.id, run.workflowName, run.status].some((item) =>
        item.toLowerCase().includes(value)
      )
    )
  }, [query, runs])

  const metrics = React.useMemo(() => getRunMetrics(runs), [runs])

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <SiteHeader
            title="Runs"
            subtitle="Checkpointed steps, live state, recovery attempts, and timeline events."
            apiUrl={API}
            onRefresh={() => void refreshRuns()}
          />
          <main className="flex flex-1 flex-col gap-4 p-4 pt-0 lg:gap-6 lg:p-6 lg:pt-0">
            <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Total runs"
                value={runs.length}
                icon={<DatabaseIcon />}
                description="Runs stored in Postgres"
              />
              <MetricCard
                label="Completed"
                value={metrics.completed}
                icon={<CheckCircle2Icon />}
                tone="success"
                description="Finished with a result"
              />
              <MetricCard
                label="Running"
                value={metrics.running}
                icon={<RotateCcwIcon />}
                tone="active"
                description="Leased by a worker"
              />
              <MetricCard
                label="Failed"
                value={metrics.failed}
                icon={<XCircleIcon />}
                tone="danger"
                description="Needs resume or recovery"
              />
            </section>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>Recent Runs</CardTitle>
                  <CardDescription>
                    {lastRefresh
                      ? `Updated ${formatTime(lastRefresh.toISOString())}`
                      : "Waiting for API"}
                  </CardDescription>
                  <CardAction>
                    <div className="relative">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        className="h-8 w-64 pl-8"
                        placeholder="Search runs"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </div>
                  </CardAction>
                </CardHeader>
                <CardContent className="p-0">
                  <RunTable
                    runs={filteredRuns}
                    selectedRunId={selectedRunId}
                    onSelect={setSelectedRunId}
                  />
                </CardContent>
              </Card>

              <RunDetailPanel detail={detail} />
            </div>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function MetricCard({
  label,
  value,
  icon,
  description,
  tone = "neutral",
}: {
  label: string
  value: number
  icon: React.ReactNode
  description: string
  tone?: "neutral" | "success" | "active" | "danger"
}) {
  return (
    <Card className="bg-gradient-to-t from-primary/5 to-card shadow-xs">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl font-semibold tabular-nums">
          {value}
        </CardTitle>
        <CardAction>
          <span className={cn("status-icon-chip", tone)}>{icon}</span>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}

function RunTable({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: Run[]
  selectedRunId: string | null
  onSelect: (runId: string) => void
}) {
  return (
    <div className="overflow-hidden">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead>Workflow</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Updated</TableHead>
            <TableHead className="hidden lg:table-cell text-right">
              Attempt
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow
              key={run.id}
              className={cn(
                "cursor-pointer",
                run.id === selectedRunId && "bg-accent"
              )}
              onClick={() => onSelect(run.id)}
            >
              <TableCell>
                <div className="flex items-center gap-3">
                  <StatusIcon status={run.status} />
                  <div className="grid min-w-0 gap-1">
                    <span className="font-medium">{run.workflowName}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {run.id}
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge status={run.status} />
              </TableCell>
              <TableCell className="hidden md:table-cell text-muted-foreground">
                {formatTime(run.updatedAt)}
              </TableCell>
              <TableCell className="hidden lg:table-cell text-right tabular-nums">
                {run.attempt ?? 0}
              </TableCell>
            </TableRow>
          ))}
          {runs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="h-24 text-center">
                No runs found.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}

function RunDetailPanel({ detail }: { detail: RunDetail | null }) {
  if (!detail) {
    return (
      <Card className="min-h-[520px]">
        <CardContent className="flex h-full min-h-[520px] items-center justify-center text-muted-foreground">
          Select a run to inspect checkpoints, state, recovery, and events.
        </CardContent>
      </Card>
    )
  }

  const completedSteps = detail.steps.filter((step) => step.status === "completed").length

  return (
    <Card className="min-w-0">
      <CardHeader className="border-b">
        <CardDescription>Workflow</CardDescription>
        <CardTitle className="flex flex-wrap items-center gap-2 text-2xl">
          {detail.run.workflowName}
          <StatusBadge status={detail.run.status} />
        </CardTitle>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigator.clipboard?.writeText(detail.run.id)}
          >
            <CopyIcon />
            Copy id
          </Button>
        </CardAction>
        <div className="grid gap-2 pt-2 text-sm text-muted-foreground md:grid-cols-4">
          <Fact label="Run id" value={detail.run.id} mono />
          <Fact label="Attempt" value={String(detail.run.attempt ?? 0)} />
          <Fact label="Updated" value={formatTime(detail.run.updatedAt)} />
          <Fact label="Checkpoints" value={`${completedSteps}/${detail.steps.length}`} />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Tabs defaultValue="steps" className="gap-0">
          <div className="border-b px-4 py-3 lg:px-6">
            <TabsList>
              <TabsTrigger value="steps">Steps</TabsTrigger>
              <TabsTrigger value="state">State</TabsTrigger>
              <TabsTrigger value="recovery">Recovery</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="steps" className="m-0 p-4 lg:p-6">
            <div className="grid gap-3">
              {detail.steps.map((step, index) => (
                <div key={step.id} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                  <div className="flex flex-col items-center gap-2 pt-1">
                    <StatusIcon status={step.status} />
                    {index < detail.steps.length - 1 ? (
                      <span className="h-full min-h-10 w-px bg-border" />
                    ) : null}
                  </div>
                  <div className="rounded-lg border bg-card p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-medium">{step.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {step.status}
                        </div>
                      </div>
                      <Badge variant="outline">attempt {step.attempt}</Badge>
                    </div>
                    {step.error ? (
                      <CodeBlock value={step.error} className="mt-3" />
                    ) : null}
                  </div>
                </div>
              ))}
              {detail.steps.length === 0 ? (
                <EmptyState label="No steps recorded yet." />
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="state" className="m-0 p-4 lg:p-6">
            <CodeBlock value={detail.state?.value ?? {}} />
          </TabsContent>

          <TabsContent value="recovery" className="m-0 p-4 lg:p-6">
            <div className="grid gap-3">
              {detail.recoveryAttempts.map((attempt) => (
                <div
                  key={attempt.id}
                  className="flex items-center gap-3 rounded-lg border bg-card p-3"
                >
                  <StatusIcon
                    status={attempt.status === "delivered" ? "completed" : attempt.status}
                  />
                  <div className="grid min-w-0 gap-1">
                    <div className="font-medium">{attempt.reason}</div>
                    <div className="text-sm text-muted-foreground">
                      {attempt.status}
                      {attempt.httpStatus ? ` / HTTP ${attempt.httpStatus}` : ""}
                      {attempt.errorText ? ` / ${attempt.errorText}` : ""}
                    </div>
                  </div>
                </div>
              ))}
              {detail.recoveryAttempts.length === 0 ? (
                <EmptyState label="No recovery attempts for this run." />
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="events" className="m-0 p-4 lg:p-6">
            <div className="grid gap-3">
              {detail.events.map((event) => (
                <div key={event.id} className="rounded-lg border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="font-medium">{event.type}</div>
                    <time className="text-sm text-muted-foreground">
                      {formatTime(event.createdAt)}
                    </time>
                  </div>
                  <CodeBlock value={event.payload} />
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="grid min-w-0 gap-1 rounded-lg border bg-muted/30 p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("truncate font-medium", mono && "font-mono text-xs")}>
        {value}
      </span>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      {label}
    </div>
  )
}

function CodeBlock({
  value,
  className,
}: {
  value: unknown
  className?: string
}) {
  return (
    <pre className={cn("code-block", className)}>
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone = statusTone(status)

  return (
    <Badge
      variant="outline"
      className={cn(
        tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        tone === "active" && "border-cyan-200 bg-cyan-50 text-cyan-700",
        tone === "danger" && "border-red-200 bg-red-50 text-red-700",
        tone === "muted" && "border-slate-200 bg-slate-50 text-slate-600"
      )}
    >
      {status}
    </Badge>
  )
}

function StatusIcon({ status }: { status: string }) {
  const className = cn(
    "size-4",
    status === "completed" && "text-emerald-600",
    status === "running" && "text-cyan-700",
    status === "failed" && "text-red-600",
    status === "created" && "text-muted-foreground"
  )

  if (status === "completed") return <CheckCircle2Icon className={className} />
  if (status === "failed") return <XCircleIcon className={className} />
  if (status === "running") return <RotateCcwIcon className={className} />
  if (status === "created") return <Clock3Icon className={className} />
  return <ActivityIcon className={className} />
}

function getRunMetrics(runs: Run[]) {
  return runs.reduce(
    (metrics, run) => {
      if (run.status === "completed") metrics.completed += 1
      if (run.status === "running") metrics.running += 1
      if (run.status === "failed") metrics.failed += 1
      return metrics
    },
    { completed: 0, running: 0, failed: 0 }
  )
}

function statusTone(status: string) {
  if (status === "completed") return "success"
  if (status === "failed") return "danger"
  if (status === "running") return "active"
  return "muted"
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value))
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`)
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as T
}

createRoot(document.getElementById("root")!).render(<App />)
