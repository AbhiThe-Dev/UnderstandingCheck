# Understanding Check — AI Software Understanding Copilot

A meeting copilot for software teams that catches **misunderstandings before they become code**. It indexes a repository, follows a speaker-labeled discussion, and privately suggests a clarification only when participants may expect *different behavior* — backed by quotes from the conversation and line-level references into the code. It is designed to stay silent when there is nothing consequential to say, and never to invent a disagreement.

> **Status: all phases built.** Phase 1 (context-aware demo), 2 (live transcript pipeline), 3 (GitHub App), 4 (meeting capture), and 5 (requirement records, without GitHub issue export). Phase 4's microphone path is verified live; a real Zoom/Meet/Teams call is still to be tested.

## Quick start

Requirements: Node ≥ 22 and pnpm (via corepack). No database server, Docker, or API keys are needed.

```bash
corepack enable
pnpm install
pnpm demo          # the Phase 1 milestone end to end in the terminal
pnpm dev           # API on 127.0.0.1:4000 + web app on http://localhost:3000
```

In the web app click **Try the demo**, then **Play**. The seeded scenario:

1. Product owner asks to undo approvals; the developer proposes “set the status back to pending”; the PO says “sounds good.”
2. The copilot finds that `approveApplication` also **grants access** (`src/applications/approve.ts:22`) and suspects *false alignment* — without claiming anyone disagrees.
3. It drafts one scenario, asked **privately** of each person: *“An application was approved yesterday… Today an administrator undoes the approval. Can the applicant still use that access?”*
4. Only when the independent answers differ does it surface *“Different expectations confirmed”* with a neutral question for the group.
5. When the team settles it (load **Demo follow-up** in the replay box), it records requirement v2, confirmed by both, and the summary exports as GitHub-issue markdown.

## Other commands

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit + integration tests (engine, fixtures, LLM path with scripted model, indexer, Postgres, API) |
| `pnpm test:e2e` | Playwright browser test of the demo flow on its own ports (API 4100, web 3100) and an in-memory database, so your data is untouched. Uses installed Chrome (`PW_CHANNEL=chromium` for the bundled one) |
| `pnpm eval` | Precision/recall/false-positive/evidence-validity over all labeled fixtures |
| `pnpm eval:live` | Same evaluation with the OpenAI analyzer (needs `OPENAI_API_KEY`) |
| `pnpm trace <fixture-id>` | Turn-by-turn view of what the engine saw and decided |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | Quality gates |

### Live pipeline

Live transcript ingestion (Mode B) — anything that produces transcript text can stream into a session. Send an `externalId` so retries from the source are ignored instead of double-counted:

```bash
curl -X POST http://127.0.0.1:4000/api/sessions/<id>/segments -H 'content-type: application/json' -d '{"speaker":"Priya","role":"product_owner","text":"Sounds good.","timestamp":12000,"externalId":"zoom-42"}'
```

Server-side replay (Mode A) simulates a meeting without paying for transcription. It paces turns by their timestamps (or by how long they take to say), at 0.25×–50× speed, and feeds the same serialized pipeline as live input. Every open viewer sees it over Server-Sent Events.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/sessions/:id/replay` `{text, speed, paused?}` | Start a replay. Replaying a transcript that already finished in this session is refused unless `force: true` |
| `POST /api/sessions/:id/replay/control` `{action?: pause\|resume\|step\|stop, speed?}` | Control it mid-meeting |
| `GET /api/sessions/:id/metrics` | Meeting metrics (below) |

Per-meeting metrics, from spec §12, are shown live on the session page and per session on the Cost page:

- **Quality:** suggestions shown and per hour, share that revealed a real difference, share resolved in the meeting, share rated useful, duplicate-candidate rate.
- **Friction:** dismissal rate and median time from suggestion to resolution.
- **Pipeline:** ingest latency (p50/p95/max), analyses run vs. skipped, retrieval cache hits.
- **Economics:** cost per meeting hour, per suggestion, per useful suggestion, and per confirmed misunderstanding.

### GitHub repositories

Create a GitHub App (read-only **Contents**, **Metadata**, **Issues**, **Pull requests**; webhooks off), install it on the repositories you want analyzed, and put `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` in `.env` (see `.env.example`). Then use **Repositories → Connect GitHub**.

- **Read-only, least privilege.** Every request uses an installation token narrowed to **one repository** and **read-only** permissions. Tokens are minted on demand, kept in memory until shortly before they expire, and never stored. Nothing in the integration can write to GitHub.
- **First index:** a shallow fetch of one commit into a private temporary directory (`0700`), deleted afterwards. The token is passed to git through environment-provided config, never in the URL, `.git/config` or the process arguments.
- **Incremental sync:** every `GITHUB_SYNC_INTERVAL_MINUTES` (default 5), or on **Sync now**. The current file tree's git blob SHAs are compared with the cached ones, and only changed files are downloaded. The repository is re-parsed from the cache, which is fast compared with fetching.
- **Pinned sessions:** sessions keep reading the commit they started on. Its symbols are kept until the session ends, so citations stay valid after new pushes.
- **Linked issues:** a session can link an issue (`#12`, `owner/repo#12` or the issue URL). Its title and first paragraph become the feature description, and the text is treated as untrusted in model prompts.
- **Code links:** code references link to GitHub at the exact commit (`…/blob/<sha>/path#L22`) in suggestions, summaries, exports and requirement records.
- **Revocation:** if the app is uninstalled or the repository is removed from it, the next sync marks the repository *access revoked* and deletes its cached files and index. **Disconnect** does the same on demand.

Endpoints: `GET /api/github/status`, `GET /api/github/repositories`, `POST /api/repos/github {fullName}`, `POST /api/repos/:id/sync`.

### Meeting capture (Phase 4)

Two capture sources feed the same pipeline as replays and the streaming endpoint. Both start only from an explicit action with consent confirmed, show a visible recording indicator, and never speak into the meeting.

| Source | Where | Transcription | Speakers |
| --- | --- | --- | --- |
| **Zoom / Google Meet / Microsoft Teams calls** | Desktop app (`apps/desktop`, Electron) with the Recall.ai Desktop SDK. No bot joins the call | Recall.ai's built-in streaming transcription | Named by the meeting platform |
| **In-person (microphone)** | Web app → **Microphone** tab | OpenAI `gpt-live-transcribe` via the Realtime API, relayed by the API server | Live transcription can't separate voices, so the operator taps the current speaker. Turns are attributed at commit time |

**Desktop app:**

```bash
pnpm dev                                  # API + web app
pnpm --filter @uc/desktop dev             # build + launch the Electron companion
```

- On first launch, macOS asks to allow **Accessibility**, **Screen Recording** and **Microphone** for Electron. Meeting detection needs all three.
- Join a call. The meeting appears in the control window: choose or create a session, confirm consent, and click **Start capture**.
- The menu bar shows **● REC**, and the copilot's private suggestions open in a narrow always-on-top panel, hidden from screen shares where macOS allows.
- **Keys stay on the server.** The Recall API key never reaches the desktop app: the API creates the upload and hands out a short-lived token.
- **Reliable delivery.** Transcript events are queued and retried while the API is unreachable. They are idempotent, so resends are ignored, and the backlog is capped.
- **Handled cleanly:** network loss (Recall stops after 2 minutes offline), an unsupported OS (the SDK needs macOS on Apple Silicon or Windows), and a missing or unreachable API.

**Microphone:**
- The browser converts the mic to 24 kHz PCM16 and detects pauses, because `gpt-live-transcribe` only accepts manually committed turns. The API refuses other origins and connections without consent.
- Audio isn't stored, only the transcript text.
- Cost is recorded per minute. `$0.017/min` is the reported launch price, overridable with `UC_TRANSCRIPTION_PRICES_JSON`.
- The workspace budget is checked before starting, and billing or auth errors stop the stream.

Endpoints: `GET /api/capture/config`, `POST /api/sessions/:id/capture/recall`, `POST /api/sessions/:id/capture/recall/events`, `POST /api/sessions/:id/capture/stop`, `WS /api/sessions/:id/audio`.

### Requirement records

When a session ends, its **confirmed** decisions become workspace-level records (`REQ-1`, `REQ-2`, …). Proposals that were never confirmed are not recorded.

- **Versioned and immutable:** each version keeps the agreed text, acceptance criteria, code references, who confirmed it, and the quotes and private scenario answers behind it.
- **Checked by later meetings:** new sessions on the same repository load the active records as earlier decisions.
  - If a discussion contradicts a record and the team settles on the new behavior, the record gets a new version (**superseded**).
  - If the team settles on the recorded behavior, the record is **reaffirmed** without a new version.
  - A record never silences a concern the meeting hasn't addressed; it is cited in the suggestion so the team can check the proposal against it.
- **Retire or reactivate:** records can be retired; retired records are not used to check new sessions.
- **Local export:** export as Markdown or JSON (`GET /api/requirements/export?format=md|json`). No external service is involved.
- **Deleting a session** removes its quotes from any records it produced but keeps the agreed text.

Endpoints: `GET /api/requirements`, `GET /api/requirements/:id`, `POST /api/requirements/:id/status`, `GET /api/requirements/export`. Session creation accepts `includeRecords: false` to skip the check.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANALYZER` | `heuristic` | `llm` uses OpenAI when `OPENAI_API_KEY` is set (falls back to heuristic otherwise) |
| `OPENAI_API_KEY` | — | **Not provided.** Required only for the model-backed analyzer |
| `UC_MODEL_CHEAP` / `UC_MODEL_REASONING` | `gpt-5-mini` / `gpt-5` | Model names per tier — verify they are current for your account |
| `UC_MODEL_PRICES_JSON` | built-in table | Override per-model prices used for cost estimates, e.g. `{"gpt-5-mini":{"inputPerMTok":0.25,"outputPerMTok":2}}` |
| `UC_DATA_DIR` | `.data/pglite` | Embedded Postgres data directory; `:memory:` for a throwaway database |
| `API_PORT`, `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL` | 4000, `http://localhost:3000`, `http://127.0.0.1:4000` | Wiring between web and API |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` | — | GitHub App credentials (`GITHUB_APP_PRIVATE_KEY` inline also works). Loaded from `.env` |
| `GITHUB_SYNC_INTERVAL_MINUTES` | `5` | How often connected repositories are checked for new commits; `0` disables |
| `RECALL_API_KEY`, `RECALL_REGION` | — | Recall.ai Desktop SDK for meeting capture (`us-west-2` = pay-as-you-go) |
| `UC_TRANSCRIPTION_PRICES_JSON` | built-in | Per-minute transcription price override, e.g. `{"gpt-live-transcribe":0.017}` |
| `UC_API_URL`, `UC_WEB_URL` | `http://127.0.0.1:4000`, `http://localhost:3000` | Where the desktop app finds the API and web app |

## Architecture

```
apps/web            Next.js 16 + Tailwind (shadcn-style components) — dashboard, repositories, live copilot,
                    clarification detail, meeting summary, cost dashboard
apps/api            Hono on Node — REST + SSE + WebSocket; owns the database, session engines and capture
apps/desktop        Electron companion — Recall.ai Desktop SDK meeting capture, private side panel
packages/core       The clarification engine (pure TypeScript, no I/O): types, modules 1–6, prompts, scoring
packages/indexer    Tree-sitter (WASM) TS/JS parsing → symbols, calls, side effects; in-memory search
packages/db         Drizzle schema + migrations on PGlite (embedded Postgres), Postgres full-text search
packages/providers  OpenAI provider, scripted test provider, transcript-source interface + replay source
packages/fixtures   Demo repos (approvals, billing) and labeled conversations
packages/eval       Fixture runner, metrics, CLI demo, trace tool
```

The engine runs as a separate service from the UI so transcription, meeting capture and reasoning can change independently.

### The clarification engine (`packages/core`)

| Module | Where | What it does |
| --- | --- | --- |
| 1 Conversation understanding | `understanding.ts`, `text.ts` | Classifies each turn (requirement, proposal, agreement, disagreement, correction, question), tracks per-participant claims with provenance (explicit / inferred), tracks the operation in focus. A cheap gate skips turns with nothing to analyze. |
| 2 Context retrieval | `retrieval.ts` | Lexical match on names → paths → bodies, one hop along calls, associated tests, token budget; cached by commit SHA. Returns *insufficient* instead of guessing. |
| 3 Candidate generation | `analyzers/heuristic.ts`, `analyzers/llm.ts` | Direct disagreement (incl. conflicts with earlier decisions), hidden assumptions (reused code with unmentioned side effects), codebase conflicts, missing specifications, false alignment. |
| — Evidence gate | `validate.ts` | Every code citation must resolve to retrieved code at the session’s commit, within the symbol’s lines; every quote must exist verbatim. Otherwise the candidate is dropped. |
| 4 Scenario generator | analyzers | Neutral, realistic yes/no scenarios whose answers map to different interpretations; before/after and decision-table formats. |
| 5 Prioritizer | `prioritizer.ts`, `config.ts` | Configurable weighted score (consequence, code evidence, conversation evidence, divergence, relevance), settle windows, live-suggestion rate limit, one live concern per operation. |
| 6 Resolution tracker | `tracker.ts`, `engine.ts` | State machine from *potential* to *resolved*; positions per participant; inferred positions never confirm anything; two people needed for a decision; changed minds produce new requirement versions. |

Two analyzers implement the same interface. **`HeuristicAnalyzer`** is rule-based (no model calls) and powers demo mode; **`LlmAnalyzer`** uses separate structured-output prompts for extraction, candidates, clarification and answer interpretation. Both go through the same evidence gate, prioritizer and tracker.

### Security & privacy in the MVP

- Workspace-scoped data access (`WorkspaceStore`) — every query is bound to a workspace; covered by tests.
- Consent is required to create a session; the live screen shows a visible transcription indicator. Only transcript text is stored (no audio). Sessions (and their transcripts) can be deleted; transcript retention can be configured.
- Repository text and transcripts are wrapped as untrusted data in prompts; credentials are redacted from code before any model call; request bodies are never logged.
- No secrets are stored yet (GitHub App credentials are Phase 3).

## Evaluation (heuristic analyzer)

`pnpm eval` over 19 labeled conversations (14 development cases on the approvals repo, 5 held-out on a different billing repo):

- precision 100%, recall 100%, false-positive rate 0%, silent cases 5/5, evidence validity 100%, held-out 5/5.

Read these numbers with care: the fixtures were written by the same author as the rules. The held-out cases use a different domain and vocabulary, but they are **not blind**. The heuristic analyzer generalizes through generic signals (side-effect categories, reversal/reuse/agreement markers, polarity) rather than fixture strings, but it will miss phrasings outside those patterns. The model-backed analyzer is the intended path for real conversations and has **not been evaluated against a live model** (no API key was available).

## Phase plan

- **Phase 1 – context-aware demo** — done (this repository).
- **Phase 2 – live transcript simulation** — done: server-side replay jobs with pause/step/speed, idempotent ingestion, per-meeting quality/friction/latency/cost metrics, usefulness feedback, and a 400-turn soak test. Not measured: whether a suggestion actually interrupted a real conversation (needs real meetings).
- **Phase 3 – GitHub App** — done: installation-token auth (single-repo, read-only), repository selection, shallow clone plus incremental blob-diff sync, pinned commits for active sessions, code links, linked-issue context, revocation handling. Not done: multi-user sign-in, a hosted Postgres/Supabase adapter, webhooks (polling instead).
- **Phase 4 – meeting capture** — built: Electron companion with the Recall.ai Desktop SDK (built-in transcription), microphone capture through OpenAI `gpt-live-transcribe`, consent and recording indicators, private side panel, reliable event delivery, per-minute cost tracking. Verified live: a spoken three-person conversation transcribed by gpt-live-transcribe in spoken order with correct speakers, raising the false-alignment suggestion; Recall SDK startup on macOS; Recall API access; billing-error handling. Not yet verified live: capturing a real Zoom/Meet/Teams call (needs the macOS permissions and a call).
- **Phase 5 – requirement records** — done without GitHub: versioned cross-session records, supersede/reaffirm, retire, history with diffs, local Markdown/JSON export, redaction on session deletion. Remaining (needs Phase 3): creating GitHub issues, linking records to pull requests, PR deviation analysis.
