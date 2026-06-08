# Tidebase Demo Video And Brand Direction

## Demo Video Spec

### Goal

Show the product promise in under 90 seconds:

> Tidebase lets existing agent workflows fail halfway, resume from checkpoints, and stream run state to a dashboard without moving code into a new runtime.

### Audience

Developers building multi-step agent workflows in TypeScript, Next.js, SvelteKit, backend workers, or internal tools.

They should leave understanding:

- Tidebase does not run or proxy their code.
- Their app keeps calling LLMs, tools, APIs, and databases directly.
- Tidebase stores checkpoints, state, events, and recovery attempts.
- A failed run can resume without repeating completed steps.

### Format

- Length: 60-90 seconds.
- Aspect: 16:9 for YouTube/X/LinkedIn, with enough zoom for Reddit embeds.
- Style: direct product demo, no talking-head required.
- Recording: terminal on left, dashboard/browser on right, editor optional.
- Audio: optional voiceover. Captions should be enough.

### Script

#### 0-5s: Hook

Screen: dashboard empty, terminal ready.

Caption:

```text
Agent run fails at step 3.
Steps 1 and 2 should not run again.
```

Voiceover:

```text
This is Tidebase: checkpoints and live run state for existing agent workflows.
```

#### 5-18s: Show The Code

Screen: editor showing the workflow.

Highlight:

```typescript
const plan = await run.step('plan', ...)
const sources = await run.step('fetch-sources', ...)
await run.state.set({ status: 'writing', progress: 0.7 })
const report = await run.step('write-report', ...)
```

Caption:

```text
Keep your code. Wrap meaningful steps.
```

Voiceover:

```text
Your code still runs in your app. Tidebase only stores the run around it.
```

#### 18-35s: Force A Failure

Screen: terminal.

Command:

```bash
FAIL_WRITE=1 pnpm example
```

Dashboard: run appears, `plan` and `fetch-sources` complete, `write-report` fails.

Caption:

```text
The run fails after two completed checkpoints.
```

Voiceover:

```text
The first two steps are now checkpointed in Postgres. The dashboard shows exactly where the run stopped.
```

#### 35-55s: Resume Manually

Screen: terminal.

Command:

```bash
TIDEBASE_RUN_ID=run_xxx pnpm example
```

Dashboard: `plan` attempt remains `1`, `fetch-sources` attempt remains `1`, `write-report` moves to attempt `2`, run completes.

Caption:

```text
Resume with the same run id.
Completed steps are skipped.
```

Voiceover:

```text
On replay, Tidebase returns completed step results from checkpoints and continues at the first incomplete step.
```

#### 55-75s: Webhook Recovery

Screen: terminal with webhook server running.

Command:

```bash
pnpm example:webhook
```

Dashboard: show recovery attempt with HTTP 200 and run completed.

Caption:

```text
Optional recovery webhooks call back into your app.
```

Voiceover:

```text
For automatic recovery, Tidebase can call a signed webhook. The SDK handles the webhook and resumes the matching workflow.
```

#### 75-90s: Close

Screen: dashboard run timeline and README.

Caption:

```text
Checkpointed steps.
Live state.
Run timeline.
Recovery hooks.
Self-hosted on Postgres.
```

Voiceover:

```text
Tidebase is not a workflow engine or hosted runtime. It is a run backend for existing agent code.
```

### Recording Checklist

- Start from a clean database for the first recording.
- Use large terminal font, at least 16-18px.
- Zoom dashboard to 110-125%.
- Keep browser width wide enough that steps, state, and timeline are readable.
- Use deterministic command outputs; avoid scrolling through stack traces too long.
- Hide unrelated tabs and desktop notifications.
- End on the GitHub README or dashboard, not a blank terminal.

### Suggested Post Copy

```text
I built Tidebase, a self-hosted run backend for agent workflows.

You keep your existing code. Wrap meaningful steps with run.step().
Tidebase stores checkpoints in Postgres, streams live state, shows a run timeline, and can call a recovery webhook back into your app when a run fails.

The demo shows a run failing halfway, then resuming without repeating completed steps.

This is not a hosted workflow engine or LLM gateway. It is meant to replace the custom status tables, retry flags, and progress plumbing people keep rebuilding around agent runs.
```

### Feedback Questions

Ask specific questions:

- Would webhook recovery be enough for your workflow, or do you need owned workers?
- What stack would you need first: plain TypeScript, Next.js, SvelteKit, Python, LangGraph?
- What would stop you from trying this locally?
- Is the dashboard showing the right information for a failed run?
- What failure mode in your app would this still not handle?

Avoid asking:

- Would you use this?
- Is this a good idea?
- How much would you pay?

## Brand And Design Mood Board

### Brand Positioning

Tidebase should feel like infrastructure for serious agent products, not an AI toy.

Core associations:

- dependable
- inspectable
- quiet
- precise
- self-hosted
- Postgres-native
- developer-first
- run-centric

Avoid:

- magical AI language
- glowing gradient blobs
- chatbot aesthetics
- heavy cyberpunk visuals
- enterprise gray sludge
- playful mascot energy

### Visual Metaphor

Primary metaphor:

```text
tide marks / waterline / layers of state over time
```

This supports:

- checkpoints as marks left behind
- runs as traces through time
- recovery as returning to the last safe point
- Postgres as the bedrock

Do not over-literalize it with ocean photography everywhere. Use it subtly in lines, rhythm, naming, and motion.

### Color Palette

Use a restrained, technical palette with enough warmth to avoid sterile SaaS sameness.

Primary:

- Deep green-black: `#17221D`
- Tide green: `#1F6B4A`
- Soft mint: `#DDEBE2`

Surface:

- Warm off-white: `#FFFDF8`
- Sand-gray: `#F4F1E9`
- Border clay: `#DED7C9`

Accent:

- Signal blue: `#2D76B9`
- Warning amber: `#B7791F`
- Failure red: `#B64234`
- Success green: `#2F8D45`

Rules:

- Do not let the product become a one-note green UI.
- Use green for brand and success, blue for active/running, amber for waiting/retry, red for failed.
- Keep dashboard backgrounds light by default.
- Dark mode can come later, but should feel like a terminal/control room, not neon.

### Typography

Recommended direction:

- UI font: Inter, Geist, or similar neutral sans.
- Code font: JetBrains Mono or IBM Plex Mono.
- Use small, dense headings in product surfaces.
- Avoid oversized marketing type inside the dashboard.

Type rules:

- Dashboard H1: 30-36px.
- Panel headings: 13-15px, semibold.
- Metadata: 12px, muted.
- Code/JSON: 12-13px, high contrast.
- Letter spacing: `0`; no negative tracking.

### Layout Principles

Tidebase is an operational tool. It should optimize for scanning.

Product dashboard:

- left sidebar: runs
- main panel: selected run
- top summary: workflow, status, run id
- center: step timeline and state
- bottom/right: events, recovery attempts, errors

Use cards only for real containers:

- run rows
- step rows
- panels
- recovery attempts

Avoid nested decorative cards. Avoid marketing-style hero compositions in the app.

### Component Mood

Buttons:

- icon buttons for refresh/copy/retry/cancel where obvious
- text buttons for destructive or explicit commands
- 8px radius max
- restrained hover states

Badges:

- small
- status-colored
- readable text

Timelines:

- chronological, compact
- event type bold
- payload secondary
- no over-animated effects

State view:

- JSON-first
- copyable later
- dark code surface is acceptable inside light UI

### Motion

Use minimal motion:

- subtle row highlight on new event
- spinner only for active loading
- no decorative background animation

The product should feel calm while runs are unstable.

### Logo Direction

Logo should work as text-first:

```text
Tidebase
```

Possible mark concepts:

- three horizontal tide lines
- a small checkpoint dot crossing a wave line
- stacked run layers
- a simple baseline/waterline glyph

Avoid:

- literal wave icons that look like travel/surf brands
- database cylinder logo
- AI sparkle
- complex nautical marks

### Voice

Tone:

- direct
- plain
- engineering-grounded
- honest about tradeoffs

Good phrases:

- "Resume from the last completed step."
- "Keep your code. Checkpoint the run."
- "Tidebase remembers what happened."
- "Recovery without moving execution into a new runtime."

Avoid:

- "autonomous"
- "magical"
- "bulletproof"
- "exactly once"
- "never fail"

### Product Screens To Prioritize

For the first public demo, the dashboard should visibly show:

- run status
- step names
- step attempts
- completed checkpoints
- current state JSON
- event timeline
- recovery attempt status

Do not spend early cycles on:

- login
- billing
- tenant filters
- complex charts
- cost dashboards
- dark mode

### Homepage Direction Later

If building a landing page, first viewport should show the product:

- real dashboard screenshot or demo video
- headline: "Checkpointed runs for existing agent code."
- subcopy: "Tidebase stores step checkpoints, live state, and recovery attempts in Postgres so failed agent workflows can resume without repeating completed work."

Primary CTA:

- "View GitHub"
- "Run locally"

Secondary CTA:

- "Watch demo"
