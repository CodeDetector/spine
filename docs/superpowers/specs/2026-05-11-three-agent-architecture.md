# PRD: Three-Agent Architecture (Business Context, Communications, Synthesis)

**Date:** 2026-05-11
**Status:** Draft — supersedes [2026-05-11-refinement-agents.md](./2026-05-11-refinement-agents.md)
**Author:** dhruvsharma983@gmail.com
**Scope:** Restructure the agent layer into three specialized agents operating over two isolated knowledge graphs, with scoped per-employee visibility and a synthesis layer that reasons across both graphs.

---

## 1. Why this supersedes the previous PRD

The earlier refinement-agents PRD modeled one shared knowledge graph with three channel agents writing into it. That works as a v1, but mixes two fundamentally different kinds of information into one graph:

1. **Business context** — slow-moving, structured, tenant-wide truth ("we sell X, our suppliers are Y, our clients are Z, our team is W").
2. **Communications context** — fast-moving, unstructured, employee-scoped ("Raj from ACME asked about delivery on Tuesday").

These have different cadences, different write paths, different access scopes, and different consumers. Forcing them through one channel-keyed agent layer compromises all of them. This PRD splits them into two graphs and adds a third agent that reasons across both.

---

## 2. Mental model

```
                  ┌─────────────────────────────────────┐
                  │   BUSINESS KNOWLEDGE GRAPH (BKG)    │
                  │   Tenant-wide. Slowly mutating.     │
                  │   Built by BusinessContextAgent.    │
                  └─────────────────────────────────────┘
                                   ▲
                                   │ read-only
                                   │
                  ┌────────────────┴────────────────────┐
                  │   COMMUNICATIONS GRAPH (CG)         │
                  │   Per-employee scope.               │
                  │   Threads are the unit of sharing.  │
                  │   Built by CommunicationsAgent.     │
                  └─────────────────────────────────────┘
                                   ▲
                                   │ reads BOTH
                                   │
                  ┌────────────────┴────────────────────┐
                  │   SYNTHESIS AGENT                   │
                  │   Periodic + on-demand.             │
                  │   Writes: follow_ups only.          │
                  │   Does NOT mutate either graph.     │
                  └─────────────────────────────────────┘
```

### Agent responsibilities

| Agent | Triggers | Reads | Writes |
|---|---|---|---|
| **BusinessContextAgent** | `business_profile` upsert; insert into `suppliers`, `clients`, `employees`, `employee_invitations` | the row that triggered + current BKG | BKG nodes/edges |
| **CommunicationsAgent** | each new row in `messages` (after channel-side intake) | the message + BKG (for relevance gate) + CG slice for the message's owner | CG nodes/edges |
| **SynthesisAgent** | every 10 min (cron), and on demand from `GET /api/synthesis/refresh` (when a user opens the dashboard) | BKG + CG (scoped to caller) | `follow_ups` only |

---

## 3. Graph partitioning

We do NOT keep two separate `nodes_business` / `nodes_comms` tables. We keep one `nodes` table and one `edges` table with **scope columns**:

```sql
ALTER TABLE nodes ADD COLUMN scope_type        text NOT NULL DEFAULT 'business'
                  CHECK (scope_type IN ('business','comms'));
ALTER TABLE nodes ADD COLUMN scope_employee_id bigint REFERENCES employees(id) ON DELETE CASCADE;

ALTER TABLE edges ADD COLUMN scope_type        text NOT NULL DEFAULT 'business'
                  CHECK (scope_type IN ('business','comms'));
ALTER TABLE edges ADD COLUMN scope_employee_id bigint REFERENCES employees(id) ON DELETE CASCADE;
```

Rules:

- `scope_type='business'` rows always have `scope_employee_id IS NULL`.
- `scope_type='comms'` rows always have `scope_employee_id NOT NULL`.

Why this shape:
- Cheaper to query than two separate tables when the synthesis agent needs to traverse business→comms edges.
- Cascade on employee delete cleans up their comms graph automatically.
- A single index on `(scope_type, scope_employee_id)` answers every read.

### Migration — wipe, don't backfill

Per [our decision](#user-confirmed), existing `nodes` and `edges` rows are dropped during migration. The legacy `knowledge_maps` JSON table is also dropped. Agents start writing into a clean schema.

```sql
TRUNCATE TABLE nodes, edges CASCADE;
DROP TABLE IF EXISTS knowledge_maps;
```

---

## 4. Thread sharing model (the COMMS scope rule)

The unit of sharing in the Communications Graph is the **thread**, not the entity. Two employees see the same comms-graph slice only if they both *participate* in the same thread.

### What defines participation

| Channel | Thread identifier | Participant rule |
|---|---|---|
| Email | `emails.threadId` | An employee is a participant if their email address appears as `from`, `to`, or `cc` on any message in the thread. Forward to a new recipient = new participant **from that message forward** (not retroactive). |
| WhatsApp group | `chatJid` ending `@g.us` | Any employee whose phone number is in the group is a participant. |
| WhatsApp 1:1 | `chatJid` ending `@s.whatsapp.net` | Strictly one employee (the session owner). Even if two employees chat with the same number, those are two separate threads — no sharing. |

### How sharing is represented in storage

A `thread_participants` table:

```sql
CREATE TABLE thread_participants (
  id           bigint generated by default as identity primary key,
  channel      text not null check (channel in ('email','whatsapp')),
  thread_id    text not null,
  employee_id  bigint not null references employees(id) on delete cascade,
  joined_at    timestamptz not null default now(),
  unique (channel, thread_id, employee_id)
);
CREATE INDEX thread_participants_lookup_idx
  ON thread_participants (employee_id, channel, thread_id);
```

The CommunicationsAgent, when processing a new message:
1. Determines the thread ID for the message.
2. Determines all employee participants from the message headers / group membership.
3. Upserts `thread_participants` rows for each participant.
4. Writes its proposed CG nodes/edges with **one row per participant** (i.e., the same logical entity gets one node per employee scope it belongs to).

This duplicates nodes across employee scopes by design — it keeps reads pure (just filter by `scope_employee_id`), avoids ACL evaluation per query, and the storage cost is negligible compared to message volume.

### Why thread-level sharing not entity-level

If Employee A has a private 1:1 chat with `+91-XXXX` (whom we resolve to Client ACME), and Employee B has a separate 1:1 chat with the same number, those conversations stay private to each. They are different threads — same client, but A's relationship and B's relationship are not the same context, and exposing one to the other can leak private negotiations, personal rapport, or sales conflicts.

If you want the looser "everyone sees everything about a given client" mode later, it's an additive opt-in (a tenant setting or per-client flag), not a schema change.

---

## 5. Authorization model

Every read of CG nodes/edges goes through a single scope filter:

```
visible_employee_ids = [requester_id] ∪ all_employees_under(requester_id)
```

`all_employees_under` is a recursive CTE over `employees.managedBy`:

```sql
WITH RECURSIVE reports AS (
  SELECT id FROM employees WHERE id = $1
  UNION
  SELECT e.id FROM employees e JOIN reports r ON e."managedBy" = r.id
)
SELECT id FROM reports;
```

For BKG reads, the scope check is trivial: any authenticated employee can read business-scope rows.

For follow-ups (mutations like dismiss/done):

- Employee can resolve their own follow-ups (`employee_id` matches them).
- Manager can resolve follow-ups assigned to anyone in their downline (same CTE).
- Admin can resolve any.

These rules are enforced in `wa-field-tracker/server.js` in three places: `/api/graph/*`, `/api/followups`, and the new `/api/synthesis/*`. **Postgres RLS is not used in v1** — we keep auth in the API layer because it's simpler to reason about, simpler to debug, and we already have all the necessary context (the JWT user → employee mapping) at the API boundary.

---

## 6. Relevance gate (CommunicationsAgent pre-step)

Before the CommunicationsAgent extracts entities from a message, it runs a relevance check against the business context. Today this exists for email only (`scoreEmailRelevance`, hard-coded threshold 80) and only as a yes/no score; we generalize it.

```
relevance(message, business_context) → { score: 0-100, reason: text }
```

If score < threshold (configurable, default 50):
- Message is **not** processed into the CG.
- An audit row is written to `agent_runs` with the score and reason, so we can debug suppressions.
- Job ends with `status='done'`.

The relevance check is a **separate, cheaper Gemini call** (smaller prompt, no graph-subset context). Two-call model is intentional: cheap junk filter, expensive extractor only on what passes.

---

## 7. SynthesisAgent

The hardest of the three. Its job is to look at fresh changes in either graph and produce follow-ups for humans to action.

### Trigger model

**Periodic (cron, every 10 min, in `omni-backend`):**
- Scan all employees with new comms-graph activity since their last synthesis run.
- For each employee, run synthesis scoped to that employee's allowed slice.
- Manager scope: when synthesis runs for a manager, it covers them + their downline as one pass.

**On-demand (`GET /api/synthesis/refresh`):**
- UI calls this when the user opens the follow-ups panel.
- If a synthesis ran for them in the last 60 seconds, returns the cached result.
- Otherwise runs a fresh synthesis, then returns.

### What it writes

`follow_ups` only. Never modifies BKG or CG. This is the **most important constraint** — it keeps the synthesis layer ablatable. If its output is bad, we can drop it without losing graph state.

### Prompt shape

```
You are a proactive business assistant for {employee.Name}, a {employee.Role}.

=== BUSINESS CONTEXT ===
{BKG slice — pre-formatted prompt block, identical to today's businessContext.js}

=== COMMUNICATIONS GRAPH (this employee's accessible scope) ===
Nodes: {comms nodes for employee + downline if manager}
Edges: {comms edges, same scope}
Recent thread activity (last 24h):
{thread → most recent message snippet, capped at 40 threads}

=== EXISTING OPEN FOLLOW-UPS ===
{open follow_ups assigned to this employee/their downline}

=== YOUR JOB ===
Identify proactive actions this person should take. Output JSON:
{
  "followUps": [{ priority, title, description, suggested_action, targetEmployeeName }],
  "notes": "..."
}

Rules:
- Don't duplicate existing open follow-ups (listed above).
- Be specific: cite the client, supplier, or thread by name.
- Manager-scope items must specify which report should action it.
- Skip if there's genuinely nothing actionable.
```

### Cost ceiling

Synthesis is the most expensive agent (largest prompt, runs across many users). Guard rails:

- Periodic synthesis skipped for an employee with zero CG mutations since last run.
- Hard rate limit: max one synthesis per employee per 5 minutes regardless of trigger.
- Token budget logged per run in `agent_runs`. If a tenant exceeds N tokens/day, the periodic job stops running for that tenant and logs an alert (left for v1.1 — for now we just log usage).

---

## 8. Concrete changes from current state

### Schema (Supabase migration `2026-05-11-three-agents-schema.sql`)

```sql
-- 8.1 Wipe legacy graph state per migration plan
TRUNCATE TABLE nodes, edges CASCADE;
DROP TABLE IF EXISTS knowledge_maps;

-- 8.2 Add scope columns
ALTER TABLE nodes ADD COLUMN scope_type text NOT NULL DEFAULT 'business'
                  CHECK (scope_type IN ('business','comms'));
ALTER TABLE nodes ADD COLUMN scope_employee_id bigint REFERENCES employees(id) ON DELETE CASCADE;
ALTER TABLE edges ADD COLUMN scope_type text NOT NULL DEFAULT 'business'
                  CHECK (scope_type IN ('business','comms'));
ALTER TABLE edges ADD COLUMN scope_employee_id bigint REFERENCES employees(id) ON DELETE CASCADE;

CREATE INDEX nodes_scope_idx ON nodes (scope_type, scope_employee_id);
CREATE INDEX edges_scope_idx ON edges (scope_type, scope_employee_id);

-- 8.3 Thread participants
CREATE TABLE thread_participants (
  id           bigint generated by default as identity primary key,
  channel      text not null check (channel in ('email','whatsapp')),
  thread_id    text not null,
  employee_id  bigint not null references employees(id) on delete cascade,
  joined_at    timestamptz not null default now(),
  unique (channel, thread_id, employee_id)
);
CREATE INDEX thread_participants_lookup_idx
  ON thread_participants (employee_id, channel, thread_id);

-- 8.4 Synthesis run tracking (rate limiting + caching)
CREATE TABLE synthesis_runs (
  id              bigint generated by default as identity primary key,
  employee_id     bigint references employees(id) on delete cascade,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  follow_ups_emitted int default 0,
  prompt_tokens   int,
  completion_tokens int,
  notes           text
);
CREATE INDEX synthesis_runs_recent_idx
  ON synthesis_runs (employee_id, started_at desc);
```

### Code changes by module

**`wa-field-tracker/core/agents/`** (where most new code lives)

| File | What changes |
|---|---|
| `worker.js` | Register three new agents: `business → BusinessContextAgent`, `email → CommunicationsAgent`, `whatsapp → CommunicationsAgent`. Remove EmailAgent registration. Add synthesis tick (separate cron, distinct from agent_jobs polling). |
| `businessContextAgent.js` (new) | Processes BKG mutations. Reads business-scope graph subset. Writes business-scope nodes/edges. |
| `communicationsAgent.js` (new) | Replaces EmailAgent. Channel-agnostic — payload tells it whether it's email or WA. Runs relevance gate first; if pass, extracts entities and writes per-participant comms-scope rows. |
| `synthesisAgent.js` (new) | Reads BKG + CG (scoped). Writes follow-ups only. |
| `synthesisRunner.js` (new) | The 10-min cron + the on-demand path. Distinct from `worker.js` because it doesn't pull from `agent_jobs`. |
| `relevanceGate.js` (new) | Shared by Comms agent. Two-line wrapper around a cheap Gemini call. |
| `threadResolver.js` (new) | Given a message payload, returns `{ threadId, participantEmployeeIds[] }`. Handles email header parsing and WA group membership lookup. |
| `diffApplier.js` | Updated: accepts `scope_type` and `scope_employee_id` on every node/edge it writes. Same surface, more discipline. |
| `emailAgent.js` | Deleted. |
| `businessContext.js` | Stays (the BKG context loader). |

**`wa-field-tracker/core/intelligenceService.js`**

- Delete `processMessageForGraph`. Anything that called it now enqueues a job instead.
- Delete `runDailyGraphUpdate` (was always-off; legacy).
- Keep `chatWithGraph` (the user-facing graph chat) and `chatWithAgent` — these are read-side, not refinement-side.

**`mapMyWhatsapp/knowledgeMapService.js` + `mapMyEmail/knowledgeMapService.js`**

- Delete both files. Remove the `.start()` calls from `connectToEmail` / `initAllSessions` paths.
- `markKnowledgeMapDirty` calls in `channelProcessor.js` removed.

**`wa-field-tracker/core/channelProcessor.js`**

- `processEmail`: remove inline `processMessageForGraph` call (the legacy parallel-run path). Keep the enqueue.

**`wa-field-tracker/server.js`**

- `/api/graph/full` and `/api/graph/channels`: rewrite to scope by `scope_type` and the requester's allowed `scope_employee_id` set (using the recursive CTE).
- `/api/followups`: rewrite to read from `follow_ups`, scoped the same way. Currently it infers follow-ups from the graph; that becomes obsolete.
- New: `GET /api/synthesis/refresh` — triggers synthesis for the caller, returns follow-ups.
- New: `POST /api/followups/:id/dismiss`, `POST /api/followups/:id/done` — scope-checked mutations.

**Frontend (`wa-field-tracker-ui`)**

- `KnowledgeMapPage.jsx`: no API contract change in v1 (still calls `/api/graph/channels`). The scope filter happens server-side, transparent to the UI.
- New side panel listing open `follow_ups` with dismiss/done actions. Lives off the existing follow-ups concept which today is empty.

---

## 9. End-to-end flow examples

### Example A: incoming WA message in a group with two employees

1. `omni-whatsapp` Baileys session for Employee A receives a message in group G (which A and B are both in).
2. `messageHandler.js` writes `messages` + `Whatsapp` rows, enqueues `agent_jobs` row with `channel='whatsapp'`, payload includes `chatJid=G@g.us`.
3. Worker picks up job, dispatches to **CommunicationsAgent**.
4. Agent calls `threadResolver.resolve(payload)` → returns `{ threadId: 'G@g.us', participants: [A.id, B.id] }`.
5. Agent calls `relevanceGate.score(payload, BKG)` → e.g. 70. Above threshold.
6. Agent calls Gemini for entity extraction. Returns proposed nodes/edges.
7. Diff applier writes the proposed nodes/edges **twice** — once with `scope_employee_id=A.id`, once with `=B.id`. Both with `scope_type='comms'`.
8. `thread_participants` upserts ensure A and B are recorded as participants of `(whatsapp, G@g.us)`.
9. Audit row.

### Example B: same WA group later — synthesis runs

1. Cron fires 10 min later.
2. For Employee A: load A's CG slice (`scope='comms' AND scope_employee_id=A.id`), load BKG, load A's open follow-ups, send to **SynthesisAgent**.
3. Returns 2 follow-ups for A. Inserts into `follow_ups` table.
4. Same pass for Employee B (separately, even though their CG slice overlaps for group G).
5. If Employee A is also B's manager, the manager pass for A includes B's CG too — but A's *own* pass remains unchanged. Both rows exist; the UI dedupes on `(employee_id, title)` if needed.

### Example C: a supplier is added

1. `mapMyBusiness/router.js` inserts the supplier, fires `enqueue({channel:'business', sourceTable:'suppliers', sourceId, payload})`.
2. Worker picks it up, dispatches to **BusinessContextAgent**.
3. Agent reads current BKG slice (other suppliers, the company profile), generates additions: a `Supplier` node with the new supplier's properties; edges connecting it to the products it supplies (which become `Product` nodes if not already present).
4. Diff applier writes with `scope_type='business', scope_employee_id=NULL`.
5. No comms-scope writes from this agent ever.

---

## 10. What gets dropped and why

| Thing | Reason for drop |
|---|---|
| `KnowledgeMapService` (in `mapMyWhatsapp`, `mapMyEmail`) | Built a per-employee JSON blob nobody reads. UI map page already queries `/api/graph/channels`. |
| `knowledge_maps` table | Same — only KnowledgeMapService wrote to it. |
| `processMessageForGraph` (legacy direct path) | Parallel-run was a Phase B safety net; agents now own all graph writes. |
| `EmailAgent` | Channel-specific. Replaced by the channel-agnostic `CommunicationsAgent`. |
| `markKnowledgeMapDirty` callsites | The dirty-flag mechanism is dead with `knowledge_maps`. |
| Inline `processWhatsApp` graph extraction (was already removed) | Replaced by enqueue from `messageHandler.js`. |

---

## 11. Failure modes & observability

| Failure | Behavior |
|---|---|
| Relevance gate timeout | Default to score=0 (suppress). Logged. |
| BusinessContextAgent fails | Job retries (existing logic). Business graph stays slightly stale, but no impact on comms. |
| CommunicationsAgent fails | Job retries. Message stays in `messages` table; participants are still recorded if step (4) succeeded before extraction failed. |
| SynthesisAgent fails | No follow-ups generated for that tick. Next tick retries. UI shows whatever follow-ups already exist. |
| Thread resolver returns zero participants | Highly unlikely, but if it happens we log and skip — better than mis-assigning. |
| Permission scope query (recursive CTE) returns wrong set | This is the most dangerous failure mode. Mitigation: unit-test the CTE against a fixture employee tree before shipping. |

Dashboard endpoint `/api/agents/health` returns:
- pending / failed agent_jobs counts per channel
- recent synthesis runs with token costs
- avg relevance scores (low avg = prompt drift or junky inbox)

---

## 12. Rollout plan

1. **A — Schema migration.** Run the SQL in §8. Wipes graph state, adds scope columns + tables. App keeps running on the old code paths (graph state was already mid-rebuild; nothing user-visible breaks).
2. **B — Worker changes, agents off.** Register all three agents as NoopAgents. Enqueue paths unchanged. Verify jobs flow through without errors. *Half day.*
3. **C — Real BusinessContextAgent.** Build, deploy. Manually trigger a supplier insert; verify business-scope nodes/edges appear. *Half day.*
4. **D — Real CommunicationsAgent + relevance gate + thread resolver.** Build, deploy. Verify per-participant writes via dual-employee group test. *2 days.*
5. **E — Permission scope on reads.** Rewrite `/api/graph/*` and `/api/followups` to honor scope. Add CTE for manager downline. *1 day.*
6. **F — SynthesisAgent + cron + on-demand endpoint.** *1.5 days.*
7. **G — UI follow-ups panel.** *1 day.*
8. **H — Delete legacy code.** `KnowledgeMapService`, `processMessageForGraph`, `EmailAgent`, `knowledge_maps`. *Half day.*

Each phase is independently shippable. Phase E is the riskiest — it changes existing endpoints. We deploy it behind a feature flag if needed, but the simpler path is "deploy A through D first so the data is correct, then cut over reads in E."

---

## 13. Definition of done

- [ ] Migration ran in Supabase, schema matches §8.
- [ ] Three agents (`businessContextAgent`, `communicationsAgent`, `synthesisAgent`) exist under `core/agents/`, unit-tested with mocked Gemini.
- [ ] `relevanceGate` and `threadResolver` exist and are tested with email-header fixtures (forward, CC chain) and WA group/1:1 fixtures.
- [ ] Diff applier accepts and persists `scope_type`/`scope_employee_id` on every write.
- [ ] `/api/graph/*` reads return only rows in the caller's allowed scope.
- [ ] `/api/followups` reads + dismiss/done writes are scope-checked, including manager downline.
- [ ] `/api/synthesis/refresh` returns within the 60s cache window or runs a fresh pass.
- [ ] Periodic synthesis cron runs every 10 min, skips inactive employees.
- [ ] UI follow-ups panel surfaces open follow-ups grouped by priority with dismiss/done actions.
- [ ] Legacy code (`KnowledgeMapService`, `processMessageForGraph`, `EmailAgent`, `knowledge_maps` table) is deleted.
- [ ] End-to-end smoke test: two employees in same WA group → message → both see the same comms-graph slice; their manager sees both. Follow-ups appear within 10 min of relevant activity.

---

## 14. Open questions (none blocking — flagging for future)

- **Tenant isolation.** Schema is still single-tenant. Going multi-tenant adds a `tenant_id` column to nearly everything. Scope check becomes `tenant_id = X AND scope_type = Y AND scope_employee_id IN (...)`.
- **Cross-graph edges.** A comms-graph mention of a known business-graph supplier — do we link with an edge? It would have to live in one of the two scopes (probably comms, since the link is contextual to the conversation). Spec leaves this implicit for now; agents may emit such edges naturally and they'll get scope='comms' by default.
- **Synthesis cache invalidation.** 60s cache is crude. A smarter version invalidates on new comms-graph mutations for that employee. Out of scope for v1.
- **Follow-up deduplication.** Synthesis can repropose the same follow-up across runs. v1 = client-side dedupe on `(employee_id, lowercased(title))` with a 24h window. v2 = LLM-assisted dedupe.
