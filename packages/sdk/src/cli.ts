#!/usr/bin/env node
/**
 * tidebase CLI:
 *
 *   tidebase signup   Provision a hosted Tidebase (Tidebase Cloud) and write
 *                     TIDEBASE_URL + TIDEBASE_API_KEY into .env — no Docker,
 *                     no Postgres. GitHub device flow by default (works for an
 *                     AI agent: it relays a code, a human approves once), or
 *                     `--email you@example.com` for a magic-link flow.
 *
 *   tidebase init     Write a Tidebase usage block into the project's
 *                     AGENTS.md/CLAUDE.md so AI coding sessions in this repo
 *                     use Tidebase correctly instead of hand-rolling status
 *                     columns. Idempotent: skips files that already have a
 *                     "## Tidebase" section.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_CLOUD_URL = 'https://api.tidebase.dev'

const SNIPPET = `## Tidebase (checkpoint layer)

This project uses [Tidebase](https://github.com/BlueprintLabIO/tidebase) (\`@tidebase/sdk\`) to checkpoint long-running agent workflows. Point the SDK at a server with \`$TIDEBASE_URL\`.

**No server yet?** Either provision a hosted one — \`npx @tidebase/sdk signup\` writes \`TIDEBASE_URL\` and \`TIDEBASE_API_KEY\` into \`.env\` — or self-host: \`docker compose up -d postgres && pnpm dev\` (default \`http://localhost:7373\`, Studio on \`:5173\`).

**When writing multi-step or long-running workflows in this repo, wrap them in Tidebase instead of hand-rolling status columns, retry flags, or checkpoint blobs:**

\`\`\`typescript
import { Tidebase } from '@tidebase/sdk'
const tide = new Tidebase()

await tide.run('workflow-name', { runId }, async (run, input) => {
  const a = await run.step('step-a', () => doA(input))      // checkpointed
  await run.state.patch({ status: 'working', progress: 0.5 }) // live UI state
  return run.step('step-b', () => doB(a))
})
\`\`\`

Rules:

- One \`run.step('name', fn)\` per unit of work you must not repeat (LLM calls, external writes). Re-invoking a run with the same \`runId\` replays completed steps from checkpoints — never re-executes them.
- Steps with external side effects MUST declare a resume contract: \`run.step('send', { sideEffects: ['email.send'], idempotencyKey: \\\`send:\${id}\\\` }, fn)\`. Without an idempotency key, failures park in \`manual_review\` instead of auto-retrying.
- Human approval before a risky action: \`const d = await run.gate('approve-x', { prompt })\`; check \`d.decision === 'approved'\`. Gates are durable and resolve exactly once.
- Parallel subagents: \`run.fanout(name, branches)\` — child runs are idempotent by branch name on resume.
- Record token usage with \`run.usage.record({ kind: 'llm', model, inputTokens, outputTokens, costUsd })\` after LLM calls.
- Do NOT build separate run-status tables, progress columns, or retry-flag columns — query Tidebase (\`GET /runs\`, \`GET /runs/:id\`) instead.
- Debugging a stuck/failed run: check Studio or \`GET $TIDEBASE_URL/runs/:runId\` for steps, failure classification, and pending gates.
`

// ---- init -----------------------------------------------------------------

function inject(file: string): 'written' | 'skipped' | 'created' {
  const path = resolve(process.cwd(), file)
  if (!existsSync(path)) return 'created'
  const current = readFileSync(path, 'utf8')
  if (/^## Tidebase\b/m.test(current)) return 'skipped'
  writeFileSync(path, `${current.replace(/\n*$/, '\n\n')}${SNIPPET}`)
  return 'written'
}

function init() {
  const targets = ['AGENTS.md', 'CLAUDE.md'].filter((f) =>
    existsSync(resolve(process.cwd(), f))
  )

  if (targets.length === 0) {
    writeFileSync(resolve(process.cwd(), 'AGENTS.md'), SNIPPET)
    console.log('created AGENTS.md with the Tidebase section')
  } else {
    for (const file of targets) {
      const result = inject(file)
      console.log(
        result === 'skipped'
          ? `${file}: already has a "## Tidebase" section, skipped`
          : `${file}: appended the Tidebase section`
      )
    }
  }

  console.log(`
Next steps — give this repo a Tidebase server (pick one):
  - Hosted (no Docker):  npx @tidebase/sdk signup
  - Self-host:           git clone https://github.com/BlueprintLabIO/tidebase && cd tidebase && docker compose up -d postgres && pnpm install && pnpm dev
  - Give your AI assistant run access (MCP):
      claude mcp add tidebase -e TIDEBASE_URL=http://localhost:7373 -- npx -y @tidebase/mcp
  - Docs for agents and humans: https://tidebase.dev/llms.txt`)
}

// ---- signup ---------------------------------------------------------------

/** Upsert keys into .env, preserving and not clobbering other lines. */
export function upsertEnv(path: string, vars: Record<string, string>): string {
  const body = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = body.replace(/\n+$/, '').length ? body.replace(/\n+$/, '').split('\n') : []
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`
    const index = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l))
    if (index >= 0) lines[index] = line
    else lines.push(line)
  }
  const next = `${lines.join('\n')}\n`
  writeFileSync(path, next)
  return next
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Credentials = {
  endpoint: string
  apiKey: string
  webhookSecret: string
  slug: string
}
type PollResponse = { status: 'pending' } | { status: 'ready'; credentials: Credentials }

async function post(url: string, body?: unknown) {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    throw new CloudUnreachable()
  }
  const text = await response.text()
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok) {
    throw new Error((json.error as string) ?? `request failed (${response.status})`)
  }
  return json
}

class CloudUnreachable extends Error {}

async function pollUntilReady(pollUrl: string, requestId: string, intervalSec: number) {
  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    await sleep(Math.max(2, intervalSec) * 1000)
    const result = (await post(pollUrl, { requestId })) as unknown as PollResponse
    if (result.status === 'ready') return result.credentials
  }
  throw new Error('signup timed out (the link/code is valid for 15 minutes — run signup again)')
}

function writeCredentials(credentials: Credentials) {
  const path = resolve(process.cwd(), '.env')
  upsertEnv(path, {
    TIDEBASE_URL: credentials.endpoint,
    TIDEBASE_API_KEY: credentials.apiKey,
    TIDEBASE_WEBHOOK_SECRET: credentials.webhookSecret
  })
  console.log(`
✓ Provisioned Tidebase Cloud for "${credentials.slug}".
  Wrote TIDEBASE_URL, TIDEBASE_API_KEY, and TIDEBASE_WEBHOOK_SECRET to .env
  Endpoint: ${credentials.endpoint}

Your code can now \`new Tidebase()\` with no further config. Load .env (e.g. node --env-file=.env, or your framework's loader) and run.`)
}

async function signup() {
  const cloudUrl = (flag('cloud-url') ?? process.env.TIDEBASE_CLOUD_URL ?? DEFAULT_CLOUD_URL).replace(
    /\/$/,
    ''
  )
  const email = flag('email')
  try {
    if (email) {
      const start = await post(`${cloudUrl}/v1/signup/email/start`, { email })
      console.log(`
Tidebase Cloud signup (email)

  Sent a confirmation link to ${email}.
  Open it in any browser, then return here — your API key is issued to this terminal.
`)
      const credentials = await pollUntilReady(
        `${cloudUrl}/v1/signup/email/poll`,
        start.requestId as string,
        (start.interval as number) ?? 5
      )
      writeCredentials(credentials)
    } else {
      const start = await post(`${cloudUrl}/v1/signup/github/start`)
      console.log(`
Tidebase Cloud signup (GitHub)

  1. Open:        ${start.verificationUri}
  2. Enter code:  ${start.userCode}

Waiting for authorization… (an AI agent can relay the code above to its human; no browser needed here.)
`)
      const credentials = await pollUntilReady(
        `${cloudUrl}/v1/signup/github/poll`,
        start.requestId as string,
        (start.interval as number) ?? 5
      )
      writeCredentials(credentials)
    }
  } catch (error) {
    if (error instanceof CloudUnreachable) {
      console.error(`
Couldn't reach Tidebase Cloud at ${cloudUrl}.
It may not be live in your region yet. You can self-host instead:

  git clone https://github.com/BlueprintLabIO/tidebase
  cd tidebase && docker compose up -d postgres && pnpm install && pnpm dev

…then set TIDEBASE_URL=http://localhost:7373.`)
    } else {
      console.error(`signup failed: ${(error as Error).message}`)
    }
    process.exitCode = 1
  }
}

// ---- dispatch -------------------------------------------------------------

const command = process.argv[2]
if (command === 'init') {
  init()
} else if (command === 'signup') {
  void signup()
} else {
  console.log('Usage: npx @tidebase/sdk <signup|init>')
  if (command) process.exitCode = 1
}
