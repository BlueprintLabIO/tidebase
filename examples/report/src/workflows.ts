import type { TideWorkflow } from '@tidebase/sdk'

export const researchReport: TideWorkflow<{ topic: string }, { report: string }> = async (
  run,
  input
) => {
  const plan = await run.step('plan', { input: { topic: input.topic } }, async () => {
    await delay(250)
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
      return [
        'teams need checkpointed multi-step workflows',
        'retries must not duplicate completed external work',
        'state should stream to product UI'
      ]
    }
  )

  await run.state.set({
    status: 'writing',
    progress: 0.7,
    sections: plan.sections
  })

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
