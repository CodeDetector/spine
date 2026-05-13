# PRD: Knowledge Graph Refinement Agents

**Date:** 2026-05-11
**Status:** Draft
**Author:** dhruvsharma983@gmail.com
**Scope:** Insert a per-channel AI refinement layer between raw message ingestion and the knowledge graph, with business-context awareness and proactive follow-up generation.

---

## 1. Background

### Today's flow

```
Feeder (WA / Gmail / IMAP)
   └─► intake()           — writes raw row to `messages`
   └─► channelProcessor   — writes channel-specific row (`emails`, `Whatsapp`)
        └─► intelligenceService.processMessageForGraph(text, meta)
             └─► single Gemini call → upserts nodes/edges directly
```

Every incoming message — regardless of channel, content, or whether it has new information — goes through one generic graph-extraction pass. There is no awareness of:

- Existing business context (who the suppliers/clients are, what products the company sells)
- Prior conversation state (what was promised, what's pending, what was already extracted from the same thread)
- Channel-specific signals (emails carry subjects/threads; WhatsApp has group context; business onboarding writes are structured)
- What action the human should take next

There's a `getPendingFollowups` endpoint and a `markKnowledgeMapDirty` flag, but no automated agent populates them — they're surfaced only on demand via the chat-with-graph feature.

### What the PRD addresses

Introduce **channel-specific refinement agents** that:

1. Sit between channel processors and the knowledge graph.
2. Always carry the full **business context** (profile, suppliers, clients, employees) in their prompt.
3. Make graph mutations *intentional* — proposing diffs rather than blind upserts.
4. Emit **proactive follow-ups** as a first-class output, written to a dedicated table.
5. Wake on every new message in their channel.

---

## 2. Goals & Non-goals

### Goals

- **G1.** Every write that mutates the knowledge graph flows through a channel agent — no bypass paths.
- **G2.** Each agent has access to the full business context every time it runs, so it can reason about whether a new mention is a known client, a new supplier, an existing employee, etc.
- **G3.** Agents produce two distinct outputs per run: (a) a graph diff (additions/updates/deletions) and (b) zero or more follow-up suggestions.
- **G4.** Follow-ups are persisted, queryable, dismissable, and surfaced in the dashboard.
- **G5.** Agents run asynchronously and don't block the inbound message pipeline — a slow Gemini call shouldn't slow down message ingestion.

### Non-goals (for v1)

- Replacing the chat-with-graph feature. That stays as an interactive read-side query.
- Cross-channel correlation agents (e.g., "the WA message and the email are about the same deal"). Channel agents stay isolated; a future global agent can run on top.
- Auto-executing follow-ups (e.g., auto-sending a reply email). Follow-ups are *suggestions* a human approves.
- Migration of historical messages. New agents start operating on fresh inbound data; backfill is a separate concern.

---

## 3. Agent inventory

Three channel agents, one per source of truth:

| Agent | Trigger | Input signal | Typical follow-ups |
|---|---|---|---|
| **EmailAgent** | New row in `emails` (via channelProcessor) | Subject, body, sender, receiver, thread history | "Reply to vendor about pricing", "Confirm delivery window with client X" |
| **WhatsAppAgent** | New row in `Whatsapp` (via channelProcessor) | Message text, sender, chat JID (group vs. 1:1), tracked-chat metadata | "Customer Y asked about availability — assign Sales lead", "Group X has 12 unread escalations" |
| **BusinessAgent** | New row in `business_profile`, `suppliers`, `clients`, `employees`, `employee_invitations` | The created/updated entity row + the diff | "Onboarded supplier Z — schedule intro call", "New client added with no assigned manager" |

All three implement the same interface and share the same business-context injector.

---

## 4. Architecture

```
                                 ┌─────────────────────────────────┐
                                 │     refinement-agent-queue      │
                                 │  (Supabase table + worker poll) │
                                 └──────────────┬──────────────────┘
                                                │
   ┌──────────────────────┐  enqueue            │   dequeue
   │ channelProcessor     │ ──────────────────► │
   │  (email / WA)        │                     │
   └──────────────────────┘                     │
                                                ▼
   ┌──────────────────────┐  enqueue   ┌──────────────────────┐
   │ mapMyBusiness POSTs  │ ─────────► │  refinement-worker   │
   │ (suppliers/clients/  │            │  (cron + queue)      │
   │  employees/invites)  │            │                      │
   └──────────────────────┘            │   ┌──────────────┐   │
                                       │   │ EmailAgent   │   │
                                       │   ├──────────────┤   │
                                       │   │ WhatsAppAgent│   │
                                       │   ├──────────────┤   │
                                       │   │ BusinessAgent│   │
                                       │   └──────────────┘   │
                                       └──────┬───────────────┘
                                              │
                              ┌───────────────┼───────────────────┐
                              ▼               ▼                   ▼
                         nodes / edges    follow_ups       agent_runs (audit)
```

**Two architectural calls:**

1. **Queue-based, not inline.** Channel processors enqueue an `agent_job` row and return immediately. A separate worker (initially in-process in `omni-backend`, later extractable to its own container) pulls jobs and runs the relevant agent. This protects ingest throughput from Gemini latency and lets us retry / batch.
2. **Agent code lives in `omni-backend` (`core/agents/`)**. Each channel agent is a class with a single `refine(job)` method. The shared business-context injector lives next to them. Future extraction to its own service is straightforward because the interface is small.

---

## 5. Data model

### New tables

```sql
-- 5.1 Job queue
CREATE TABLE public.agent_jobs (
  id              bigint generated by default as identity primary key,
  channel         text not null check (channel in ('email','whatsapp','business')),
  source_table    text not null,           -- e.g. 'emails', 'Whatsapp', 'suppliers'
  source_id       bigint,                  -- PK of the source row
  payload         jsonb not null,          -- snapshot of the row + minimal context
  status          text not null default 'pending'  -- pending | running | done | failed
                  check (status in ('pending','running','done','failed')),
  attempts        int  not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz
);
CREATE INDEX agent_jobs_pending_idx ON public.agent_jobs (channel, created_at)
  WHERE status = 'pending';

-- 5.2 Follow-ups (proactive suggestions)
CREATE TABLE public.follow_ups (
  id              bigint generated by default as identity primary key,
  channel         text not null,
  source_job_id   bigint references public.agent_jobs(id) on delete set null,
  employee_id     bigint references public.employees(id),  -- who should action this
  priority        text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  title           text not null,
  description     text,
  suggested_action text,                   -- e.g. 'reply_to_email', 'assign_manager'
  related_node_ids bigint[],               -- KG nodes this concerns
  status          text not null default 'open' check (status in ('open','dismissed','done')),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
CREATE INDEX follow_ups_open_idx ON public.follow_ups (employee_id, status, created_at desc);

-- 5.3 Agent run audit (one row per agent execution, for observability)
CREATE TABLE public.agent_runs (
  id              bigint generated by default as identity primary key,
  job_id          bigint references public.agent_jobs(id) on delete cascade,
  agent_name      text not null,           -- 'EmailAgent', etc.
  model           text,                    -- e.g. 'gemini-2.0-flash'
  prompt_tokens   int,
  completion_tokens int,
  graph_diff      jsonb,                   -- { added_nodes:[...], added_edges:[...], updated_nodes:[...] }
  follow_ups_emitted int default 0,
  duration_ms     int,
  created_at      timestamptz not null default now()
);
```

### Changes to existing tables

None. The existing graph (`nodes`, `edges`) and `getPendingFollowups` endpoint stay; the latter is reimplemented to read from `follow_ups` instead of being inferred ad-hoc.

---

## 6. Agent interface

Each agent implements:

```ts
interface RefinementAgent {
  name: string;                          // 'EmailAgent' etc.
  channel: 'email' | 'whatsapp' | 'business';

  refine(job: AgentJob, ctx: BusinessContext): Promise<RefinementResult>;
}

interface BusinessContext {
  profile:   BusinessProfile;
  suppliers: Supplier[];
  clients:   Client[];
  employees: Employee[];
  // pre-formatted text block for prompt injection
  promptBlock: string;
}

interface RefinementResult {
  graphDiff: {
    addedNodes:    NodeProposal[];
    updatedNodes:  NodeUpdate[];
    addedEdges:    EdgeProposal[];
  };
  followUps: FollowUpProposal[];
  notes?: string;                        // free-text reasoning, audited only
}
```

### Shared context loader

```js
// core/agents/businessContext.js
async function loadBusinessContext() {
  const [profile, suppliers, clients, employees] = await Promise.all([
    businessClient.readProfile(),
    businessClient.listSuppliers(),
    businessClient.listClients(),
    businessClient.listEmployees(),
  ]);
  return {
    profile, suppliers, clients, employees,
    promptBlock: formatForPrompt({ profile, suppliers, clients, employees }),
  };
}
```

The context is loaded **once per worker tick** and shared across all jobs processed in that tick (typically <60 seconds), so we don't pay the Supabase round-trip cost per job. It refreshes on the next tick.

---

## 7. Prompt structure (shared across agents)

```
You are a knowledge-graph refinement agent for a business intelligence platform.

=== BUSINESS CONTEXT ===
{businessContext.promptBlock}

=== EXISTING GRAPH (relevant subset) ===
{graphSubset}              ← nodes/edges that share a name/email/phone with the new message

=== NEW {channel} MESSAGE ===
{job.payload as plain text}

=== YOUR JOB ===
1. Decide what the graph should look like AFTER this message. Output a diff:
   - addedNodes: new entities not yet in the graph
   - updatedNodes: existing nodes whose properties should change
   - addedEdges: new relationships
2. Generate 0-N follow-up suggestions for a human to action.
   Each follow-up must have: priority, title, description, suggested_action,
   target employee (if known).
3. Be conservative — only propose changes you are highly confident about.

Return JSON only, matching the schema in section 6 of the PRD.
```

The `graphSubset` is computed by an indexed lookup: extract candidate entities from the message (names, emails, phones, product names) and fetch existing nodes that match. This keeps the prompt size bounded even as the graph grows.

---

## 8. Worker

A single Node.js worker loop in `omni-backend`:

```
every 5 seconds:
  ctx = loadBusinessContext()          # cached for 60s
  jobs = SELECT * FROM agent_jobs
         WHERE status = 'pending'
         ORDER BY created_at
         LIMIT 5
         FOR UPDATE SKIP LOCKED
  for job in jobs:
    mark job 'running'
    agent = agentRegistry[job.channel]
    try:
      result = await agent.refine(job, ctx)
      apply(result.graphDiff) → nodes/edges
      insert(result.followUps) → follow_ups
      insert(audit row)         → agent_runs
      mark job 'done'
    catch:
      attempts++
      if attempts >= 3: mark 'failed'
      else: mark 'pending' (retry on next tick)
```

Why these knobs:

- **5-second tick, 5 jobs/batch**: low latency for typical bursts, while bounded enough to not flood Gemini at 60 RPM.
- **FOR UPDATE SKIP LOCKED**: lets us scale to multiple workers later without changing the schema.
- **3-attempt retry**: handles transient Gemini 5xx; permanent failures (parse errors) surface in `agent_jobs.last_error` for debugging.

---

## 9. Enqueue points (touchpoints in existing code)

| Location | What changes |
|---|---|
| `core/channelProcessor.js:processEmail` | After `_writeToEmailsTable`, **remove** the inline `processMessageForGraph` call; instead, enqueue `{channel:'email', source_table:'emails', source_id, payload:{...email fields}}`. |
| `core/channelProcessor.js:processWhatsApp` | Same change for the WA path. |
| `mapMyBusiness/router.js` POST handlers for suppliers, clients, employees, invitations, business profile | After insert, enqueue `{channel:'business', source_table, source_id, payload}`. |

The existing `processMessageForGraph` function stays for now (used by manual enrichment endpoints `/api/graph/enrich` and `/api/graph/enrich-whatsapp`), but it's no longer the default path for new messages.

---

## 10. Backwards compatibility

- **`markKnowledgeMapDirty`** keeps working — the worker calls it after applying a diff.
- **`/api/followups`** is rewritten to read from `follow_ups` table; the response shape stays compatible with the existing UI consumer.
- **`/api/graph/full`** and chat-with-graph: unchanged. They still read the same `nodes`/`edges` tables.
- **`/api/graph/enrich(-whatsapp)`** for historical-data enrichment: keeps the legacy direct-write path. Decision deferred whether to migrate this to the queue too.

---

## 11. Failure modes & observability

| Failure | Behavior |
|---|---|
| Gemini timeout / 5xx | Retry up to 3x, then mark `failed`. Surfaced in agent_jobs query. |
| Gemini returns invalid JSON | Mark `failed` immediately (no point retrying same prompt). Audit row records raw output. |
| Agent proposes a node that violates a schema constraint | Apply rest of diff, log rejected mutation, no retry. |
| Worker crash | On boot, reset any `running` jobs older than 60s back to `pending`. |
| Business-context load fails | Worker skips the tick and logs; channel ingestion is unaffected (jobs accumulate in `pending`). |

A dashboard view (`/api/agents/health`) returns: pending count, failed count, p95 latency, last-N runs with token counts. Useful for catching prompt drift.

---

## 12. Rollout plan

1. **Phase A — Schema + queue, no agents.** Create the tables, add enqueue calls in channel processors and `mapMyBusiness` mutations, but the worker is a no-op that just marks jobs `done`. Verify zero impact on existing pipeline.
2. **Phase B — EmailAgent.** Implement EmailAgent + worker. Run in parallel with the legacy `processMessageForGraph` call (don't remove the inline call yet). Compare outputs offline.
3. **Phase C — WhatsAppAgent + BusinessAgent.** Same parallel-run pattern.
4. **Phase D — Cut over.** Remove the inline `processMessageForGraph` calls from `channelProcessor`. Now agents are the sole writers for new messages.
5. **Phase E — Surface follow-ups.** UI panel showing `follow_ups` per employee; dismiss/mark-done actions.

Estimated: A = 0.5 day, B = 1.5 days, C = 2 days, D = 0.5 day, E = 1 day. Each phase is independently shippable.

---

## 13. Open questions

- **Do we batch multiple consecutive messages from the same thread into one agent run?** Saves tokens and improves coherence, but adds complexity. Default: no, one job per message in v1.
- **Should the BusinessAgent run on profile *updates* too, or only inserts?** Probably yes (an industry change could affect classification), but it's a much lower volume than message channels.
- **Multi-tenant later**: the business context loader is currently scoped to "the" business (single tenant). When we go multi-tenant, every job needs a `tenant_id` and the context loader becomes a per-tenant cached resource.
- **Cost ceiling**: at ~100 messages/day across all channels, with avg ~1500-token prompts and ~500-token completions on `gemini-2.0-flash`, we're at <$1/day. Acceptable. At 10× scale or with a heavier model we may need to add a relevance gate before the agent (similar to the existing email relevance scorer) to drop noise before it hits the LLM.

---

## 14. Definition of done

- [ ] Schema migrations (5.1, 5.2, 5.3) applied to Supabase.
- [ ] `core/agents/` module with worker, three agents, and shared context loader, all unit-tested with mocked Gemini.
- [ ] All channel processors and `mapMyBusiness` mutations enqueue (not inline-process).
- [ ] `follow_ups` is the source of truth for `/api/followups`.
- [ ] Dashboard surfaces open follow-ups grouped by employee.
- [ ] Observability endpoint `/api/agents/health` returns the metrics in §11.
- [ ] Smoke test: send 1 email + 1 WA message + 1 supplier insert; verify 3 `agent_jobs` rows transition to `done`, 3 `agent_runs` audit rows exist, graph reflects the new entities, and at least one `follow_ups` row is generated.
