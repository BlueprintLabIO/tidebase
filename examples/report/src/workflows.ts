import type { TideWorkflow } from '@tidebase/sdk'

export const researchReport: TideWorkflow<{ topic: string }, { report: string }> = async (
  run,
  input
) => {
  const plan = await run.step('plan', { input: { topic: input.topic } }, async () => {
    await delay(250)
    await run.usage.record({
      kind: 'llm',
      provider: 'example',
      model: 'planner-mock',
      label: 'plan',
      inputTokens: 180,
      outputTokens: 120,
      costUsd: 0.003
    })
    return {
      sections: ['problem', 'current workaround', 'recommended shape'],
      topic: input.topic
    }
  })

  const sources = await run.step(
    'fetch-sources',
    {
      input: { sections: plan.sections },
      sideEffects: ['source.fetch'],
      replay: 'auto',
      checkpointInvariant: 'source list captured for the planned sections'
    },
    async () => {
      await delay(250)
      await run.usage.record({
        kind: 'tool',
        provider: 'example',
        label: 'fetch-sources',
        quantity: 3,
        unit: 'sources',
        costUsd: 0.001
      })
      return [
        'teams need checkpointed multi-step workflows',
        'retries must not duplicate completed external work',
        'state should stream to product UI'
      ]
    }
  )

  await run.state.set({
    status: process.env.REQUIRE_APPROVAL === '1' ? 'waiting_for_approval' : 'writing',
    progress: 0.7,
    sections: plan.sections
  })

  if (process.env.REQUIRE_APPROVAL === '1') {
    const decision = await run.gate('approve-report', {
      prompt: `Send the ${input.topic} report?`,
      data: {
        topic: input.topic,
        sections: plan.sections,
        sourceCount: sources.length
      },
      channels: process.env.TIDEBASE_CHANNEL_WEBHOOK
        ? [{
            type: 'webhook',
            url: process.env.TIDEBASE_CHANNEL_WEBHOOK,
            events: ['gate.created']
          }]
        : [],
      capability: {
        name: 'report.write',
        scopes: ['report:write'],
        reason: 'agent wants to write the approved report'
      }
    })
    if (decision.decision !== 'approved') {
      throw new Error(`Report gate resolved as ${decision.decision}`)
    }
    await run.state.patch({
      status: 'writing',
      approvedBy: decision.actor
    })
  }

  const report = await run.step(
    'write-report',
    {
      sideEffects: ['report.write'],
      replay: 'manual',
      checkpointInvariant: 'report text was generated and returned by the step',
      verifiedBy: 'example workflow result',
      credentials: [{
        name: 'report-store',
        scopes: ['report:write'],
        reason: 'persist generated report after replay-safe inputs exist'
      }]
    },
    async () => {
      await delay(250)
      if (process.env.FAIL_WRITE === '1') {
        throw new Error('Simulated write failure after plan and fetch checkpoints')
      }
      await run.usage.record({
        kind: 'llm',
        provider: 'example',
        model: 'writer-mock',
        label: 'write-report',
        inputTokens: 420,
        outputTokens: 260,
        costUsd: 0.007
      })
      return [
        `Report: ${input.topic}`,
        '',
        ...sources.map((source, index) => `${index + 1}. ${source}`)
      ].join('\n')
    }
  )

  await run.state.patch({
    status: 'completed',
    progress: 1
  })

  return { report }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
