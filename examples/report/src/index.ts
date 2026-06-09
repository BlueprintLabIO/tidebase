import { Tidebase } from '@tidebase/sdk'
import { researchReport } from './workflows.js'

const tide = new Tidebase()

const runId = process.env.TIDEBASE_RUN_ID

const result = await tide.run(
  'research-report',
  {
    runId,
    input: {
      topic: 'checkpointed agent workflows'
    },
    metadata: {
      source: 'example-report'
    },
    channels: process.env.TIDEBASE_CHANNEL_WEBHOOK
      ? [{
          type: 'webhook',
          url: process.env.TIDEBASE_CHANNEL_WEBHOOK,
          events: ['run.failed', 'step.failed', 'state.updated']
        }]
      : []
  },
  researchReport
)

console.log(JSON.stringify(result, null, 2))
