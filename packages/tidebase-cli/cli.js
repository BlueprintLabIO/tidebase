#!/usr/bin/env node
/**
 * tidebase CLI — currently one command:
 *
 *   tidebase init   Write a Tidebase usage block into the project's
 *                   AGENTS.md/CLAUDE.md so AI coding sessions in this repo
 *                   use Tidebase correctly instead of hand-rolling status
 *                   columns. Idempotent: skips files that already have a
 *                   "## Tidebase" section.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const SNIPPET = `## Tidebase (checkpoint layer)

This project uses [Tidebase](https://github.com/BlueprintLabIO/tidebase) (\`@tidebase/sdk\`) to checkpoint long-running agent workflows. Server: \`$TIDEBASE_URL\` (default \`http://localhost:7373\`), Studio dashboard on \`:5173\`.

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
`;
function inject(file) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path))
        return 'created';
    const current = readFileSync(path, 'utf8');
    if (/^## Tidebase\b/m.test(current))
        return 'skipped';
    writeFileSync(path, `${current.replace(/\n*$/, '\n\n')}${SNIPPET}`);
    return 'written';
}
function init() {
    const targets = ['AGENTS.md', 'CLAUDE.md'].filter((f) => existsSync(resolve(process.cwd(), f)));
    if (targets.length === 0) {
        writeFileSync(resolve(process.cwd(), 'AGENTS.md'), SNIPPET);
        console.log('created AGENTS.md with the Tidebase section');
    }
    else {
        for (const file of targets) {
            const result = inject(file);
            console.log(result === 'skipped'
                ? `${file}: already has a "## Tidebase" section, skipped`
                : `${file}: appended the Tidebase section`);
        }
    }
    console.log(`
Next steps:
  - Server + Studio: git clone https://github.com/BlueprintLabIO/tidebase && cd tidebase && docker compose up -d postgres && pnpm install && pnpm dev
  - Give your AI assistant run access (MCP):
      claude mcp add tidebase -e TIDEBASE_URL=http://localhost:7373 -- npx -y @tidebase/mcp
  - Docs for agents and humans: https://tidebase.dev/llms.txt`);
}
const command = process.argv[2];
if (command === 'init') {
    init();
}
else {
    console.log('Usage: tidebase init');
    if (command)
        process.exitCode = 1;
}
