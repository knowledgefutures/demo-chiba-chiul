# chiul

A buffered read/write layer between [Chi](https://github.com/henkaku-center/chi) session logs and
[Underlay](https://github.com/knowledgefutures/underlay) collections.

Chi records AI coding sessions as portable Pi v3 JSONL. chiul projects those logs into versioned,
content-addressed Underlay collections, serves a workspace for exploring them, and accepts new
sessions at app latency — committing them upstream on an interval rather than one version per turn.

Built by [Knowledge Futures](https://www.knowledgefutures.org) with the Chi team at Chiba Tech.

> Chi keeps its own backend, its own contracts, its own canonical format. It **publishes** to
> Underlay as a persistence and citation substrate.

Because sessions land as ordinary collections, other Underlay consumers work on them with no
Chi-side integration: [`ask`](https://github.com/knowledgefutures/underlay-ask) answers questions
over them, [`hot`](https://github.com/knowledgefutures/underlay-hot) hands an app a writable working
copy, `graph` draws them.

## What it does

- **Reads** a set of Underlay collections into a local working copy and serves dashboards, a corpus
  map, a session transcript reader, and faceted full-text search over them.
- **Writes** new session entries through a token-authenticated endpoint, buffers them, and pushes to
  Underlay on a configurable interval.
- **Enforces per-source access** with a grant table, using Chi's own `z` reduction levels as the
  permission ladder — so "you may read my summaries but not my raw logs" is expressible.
- **Publishes** collection layouts (per-source, per-repo) over the same records, which costs one
  manifest rather than a copy.

## Quick start

Requires Node 24+ and pnpm. `wrangler dev` runs D1 and Durable Object SQLite locally through
Miniflare, so no cloud resources are touched.

```sh
pnpm install
cp .env.example .dev.vars      # fill in the three values below
pnpm db:migrate:local          # control-plane migrations into local D1
pnpm dev                       # vite build + wrangler dev on :4700
```

| `.dev.vars` | For |
| --- | --- |
| `UNDERLAY_API_KEY` | reading the collections and publishing back |
| `DEMO_PASSWORD` | the shared gate password |
| `SESSION_SECRET` | signs the gate and persona cookies (16+ chars) |

Open http://localhost:4700, enter the password, then **Load from Underlay** on the overview. A fresh
Durable Object starts empty; loading reads roughly 9,400 records in about nine seconds.

Port note: 4700, because 4300–4600 are taken by sibling projects.

```sh
pnpm check                     # tsc + oxlint + vitest + vite build
node tools/smoke.mjs           # every route, plus the access model per persona
```

The 12 tests in `src/lib/chi/corpus.test.ts` run against a real session corpus and **skip** when
`CHI_CORPUS_DIR` is unset, which is the normal case for a fresh clone — see [Session data](#session-data).
Everything else runs anywhere.

`smoke.mjs` exists because a refactor once silently deleted seven route registrations in a sibling
project and every other gate passed — `tsc` does not typecheck route strings and the Worker still
boots. It also asserts grant behaviour per persona, since "the grant table is right" and "the API
applies it" are different claims and only the second matters. It loads the workspace itself if it
finds it empty, and discards anything it wrote.

## Architecture

```
Underlay collections (private)
        │  paged reads — the same public API any other consumer uses
        ▼
┌── CONTROL PLANE — D1 ──────────────────────────────────────┐
│  workspaces · collections · personas · grants              │
│  ingest_tokens · commit_log · hydration_log                │
└────────────────────────────────────────────────────────────┘
        ▲ persona → grants → what may be sent
┌── DATA PLANE — one SQLite Durable Object per workspace ────┐
│  sessions · entries · entries_fts · metrics · links        │
│  pending  ← the write buffer                               │
└────────────────────────────────────────────────────────────┘
        ▼
   React SPA on Workers Static Assets
```

A Durable Object rather than D1 for the data plane because D1 bindings cannot be assigned
dynamically, because loading needs somewhere to run that outlives a request, and because
`sql.exec()` is synchronous and local, so dashboard aggregates are cheap. No sharding: ~9,400 records
against a 10 GB per-object ceiling.

The object reads **from the collections, not from source files**. That makes the surface an honest
working copy of what was published, exercises the read path like any other consumer, and means the
deployed Worker carries no transcripts.

Everything in the object is a projection that `hydrate()` can rebuild — with one exception. `pending`
holds writes a client has handed over that are committed nowhere else, so it is the only table
excluded from the drop-and-rebuild on a `SCHEMA_VERSION` mismatch.

## The data model

Four record types. The boundary sits where Chi's own validity boundary falls
(`packages/chi-commons/DESIGN.md` § 0): endomorphisms on valid Pi v3 on one side, explicit
projections on the other.

| Type | Side | What it is |
| --- | --- | --- |
| `Entry` | endomorphism | One Pi v3 entry, verbatim, at one reduction level. Valid v3 in, valid v3 out. |
| `Reduction` | endomorphism | One derivation: `(strategy, z, reducerVersion)` plus exact source lineage. |
| `Session` | projection | Derived metadata spine. Not v3. |
| `Metrics` | projection | Deterministic field-algebra output. Not v3. |

**`z` is a field on `Entry`, not a type.** Splitting by z would break content-address dedup across
ingests (identical records landing in different types) and schema-hash alignment across collections
(each source defining a different shape). `z` is denormalised onto the entry for cheap filtering, but
`reductionId` is the real discriminator: Chi's address is `(sessionId, strategy, z, range)` and many
reduction trees can exist per session, so two records at `z=1` under different strategies are not
comparable.

`Reduction`'s fields transcribe Chi's own reduction contract (`backend/docs/ARCHITECTURE.md`): *"every
output records exact input hashes/IDs, source repos/sessions, reducer and prompt versions, model,
fan-in, and authorization scope."*

### What survives a round trip

A Pi v3 session goes into Underlay and comes back with nothing lost. Stated precisely, because the
obvious version of the claim is wrong:

| | Assertion | Holds |
| --- | --- | --- |
| **A** | **Semantic identity** — every record deep-equal, identical counts, identical `id`/`parentId` tree | Yes, exactly. This is the claim. |
| **B** | **Canonical-byte identity** — identical after recursive key sorting | Yes. |
| **C** | **Raw-byte identity** | **No, by design.** |

C cannot hold: `record_objects.data` is a Postgres `jsonb` column, a parsed representation that
normalizes key order and discards whitespace. No client can preserve key order through it. JSON
declares object keys unordered (RFC 8259) and Pi's loader does not care about order, so a file
reassembled from A is still valid, resumable v3 by Chi's own definition. `jsonb` stores numbers as
arbitrary-precision `numeric`, so a cost like `0.030985000000000002` survives exactly.

`src/lib/chi/corpus.test.ts` proves A and B **offline**, by simulating the `jsonb` normalization
locally — so the guarantee is covered in CI with no database. `tools/roundtrip.ts` confirms it against
a live instance.

### Two characters Postgres JSON cannot store

`jsonb` accepts any Unicode scalar value, but session logs are not limited to those:

- **U+0000**, rejected outright.
- **Lone surrogates** (unpaired U+D800–DFFF) — valid in a JS string and representable in JSON text,
  but not Unicode scalar values, so they cannot be encoded as UTF-8.

Both occur in real tool output when a command returns binary data. They arrive as a single opaque HTTP
500 from the negotiate endpoint, naming neither the record nor the reason, which takes a bisect to
find. `src/lib/chi/unstorable.ts` applies a declared, reversible escape, marked `pgEscaped: true` on
the record and reversed on read, so the round trip stays lossless.

### The session header is not always the first line

Some Pi v3 files open with a `title` record carrying a `pad` field of trailing spaces — a fixed-width
slot so the title can be rewritten in place without rewriting the file. `parseSession` locates the
`session` header rather than assuming its position; an importer built to "the first record is the
header" rejects those files outright.

## Access model

`grants` maps a persona to what it may see, using Chi's `z` vocabulary as the ladder:

| `detail` | Means |
| --- | --- |
| `full` | entries at z=0 — the raw session |
| `reduced` | entries at z≥1 only — summaries, never raw records |
| `metrics` | Session and Metrics records only — shape and cost, no content |
| `none` | not visible at all |

Resolution is most-specific-wins, so a source grant can *narrow* a wildcard — which is what makes
"everyone may see summaries, but one source has withheld theirs" expressible. Within one specificity
the more permissive level wins, so adding a grant can never silently remove access.
`src/worker/grants.ts` is pure functions with unit tests; routes call `resolveAccess` once and filter
with it.

Two rules keep it from being decoration:

- **Filtering happens in the Worker.** A persona that may not read a session never receives it,
  rather than receiving it and having the interface hide it.
- **What is withheld is named and counted.** A dashboard that quietly excludes a third of the data
  reads as a complete picture when it is not.

Search is gated at `full` rather than `reduced`: a snippet is raw session text, so letting a
summaries-only persona search raw records would route around their own grant. Publishing and minting
write tokens require full read access to *every* source, because both copy everyone's records.

`Session.cwd` ships as a `private: true` schema field. Note what that does and does not buy:
Underlay's field-level filtering applies to a caller who can read a collection but does not own it. A
*private* collection returns 404 to an outside caller, so nothing is filtered because nothing is
reachable — per-persona visibility on private data is this layer's job, not Underlay's.

### The gate

One shared password in an HMAC-signed cookie, no SSO. It **fails closed**: an environment missing
`DEMO_PASSWORD`, or with a `SESSION_SECRET` under 16 characters, is locked rather than open. Without
that check, a deployment that forgot one `wrangler secret put` would key cookie signatures on the
string `"undefined"` and look like it worked while having no gate at all.

The persona is a signed cookie value rather than a client-supplied header, so a client cannot claim a
persona it was not given — but anyone with the password may *choose* any persona, and the interface
says so rather than implying otherwise.

## The write path

Underlay versions are commits — a manifest plus a version hash — which suits batches, not per-turn
appends. So writes buffer:

```
client ──POST /api/ingest──▶  pending (Durable Object)  ──every N minutes──▶  Underlay
          Bearer <write token>        instant                                 one version
```

| Surface | Auth | Who |
| --- | --- | --- |
| `POST /api/ingest` | `Authorization: Bearer <write token>` | machines |
| `/api/ingest/{status,tokens,policy,flush,discard}` | gate + full read access | operators |

The machine endpoint **refuses the browser session cookie**. If it accepted one, any page a viewer
visited could write on their behalf.

- **Writes are idempotent** by `sessionId:entryId`, so replaying a session after a reconnect adds
  nothing — which matters when duplicates come from replication rather than concurrency.
- **A push and a re-publish are the same operation.** Buffered entries join the main tables, then the
  layout is published; content addressing means only genuinely new records travel.
- **Tokens are stored hashed** with a display prefix, and returned exactly once.
- **`POST /api/ingest/discard`** drops the buffer without publishing, and clears session rows left
  with no entries. Without it, test writes accumulate and the next push commits them into a real
  collection.

Auto-push is off by default. When on, a cron (`*/5 * * * *`) checks whether the workspace's own
configured interval has elapsed — the schedule is a floor, the interval is the policy — and a failed
push leaves the buffer intact for the next run rather than dropping it.

## One colour language, three scales

`src/lib/chi/kinds.ts` classifies every entry by **who is speaking** — human, model, tool, or the
runtime — and the corpus map, the session strips and the transcript all read from the same table. A
2px tick and a message bubble that share a colour are the same kind of thing, which is what makes
zooming between them feel continuous.

Only **three hues** carry identity: blue human `#2a78d6`, violet model `#5b2ea8`, teal tool `#00908a`,
plus a recessive neutral for events. That is a measured constraint rather than a preference — in a
dense strip any two marks can end up adjacent, which is the all-pairs case, and three is the most that
clears colour-blind separation there. `thinking` shares the model hue and separates by weight instead
of taking a fourth colour.

Validated against the `#fbfbfc` surface: worst all-pairs CVD ΔE 12.9, worst normal-vision ΔE 15.3,
and all three above 3:1 contrast. Re-run the palette validator on any change, surface included.

Classifying by speaker is load-bearing: treating any assistant turn containing a `toolCall` as `tool`
put 83% of entries in one bucket and collapsed `thinking` to a single entry, because an assistant turn
nearly always carries reasoning and a call together.

## Deploying

```sh
# 1. A D1 database, with its id in wrangler.jsonc
npx wrangler d1 create chiba-chiul        # paste the id into wrangler.jsonc

# 2. Migrations against the remote database — the first-deploy failure if skipped
npx wrangler d1 migrations apply chiba-chiul --remote

# 3. Secrets (never in wrangler.jsonc — it is committed)
npx wrangler secret put UNDERLAY_API_KEY
npx wrangler secret put DEMO_PASSWORD
npx wrangler secret put SESSION_SECRET

# 4. Deploy: builds the SPA, uploads the Worker, the Durable Object and the assets
pnpm deploy

# 5. Load once — a fresh Durable Object starts empty
#    Open the URL, enter the password, press "Load from Underlay".
```

A custom domain is attached in the Cloudflare dashboard, as with the other Workers in this portfolio;
nothing in this repo needs to change for it. The ingest endpoint shown in the interface is derived
from the request origin, so it is correct on `workers.dev` and on a custom domain with no
configuration.

## Notes for contributors

- **Never leave `database_id` as a placeholder**, even for local work. `wrangler d1 …` resolves the
  database by *name* and keys its local file by the resolved **remote** id, while `wrangler dev` keys
  local storage by the `database_id` in config. With a placeholder the two use different local SQLite
  files, and the dev server reports `no such table` against a database the CLI just migrated
  successfully. Also: `wrangler d1 execute --local` will **create the remote database** as a side
  effect of resolving the name — a "local" command provisioning a cloud resource.
- **`wrangler dev` reads `.dev.vars` at startup only.** Editing a secret while it runs leaves the old
  value in memory; the symptom is a correct password being rejected as incorrect. Restart.
- **`wrangler dev` reloads when built assets change**, and a reload can leave the Durable Object
  empty, so a build in another terminal may require loading the data again.
- **Never `DELETE FROM` an FTS5 external-content table.** `entries_fts` is a view over `entries`, so
  `DELETE` writes delete-markers for rows about to vanish, and the next rebuild lands on an index that
  disagrees with its content table. It surfaces on the *following* run as `SQLITE_CORRUPT_VTAB`, which
  reads as a disk fault and is not one. Drop the table and
  `INSERT INTO entries_fts(entries_fts) VALUES('rebuild')` instead.
- **`CREATE TABLE IF NOT EXISTS` silently skips new columns.** Adding one leaves the existing table
  untouched and the next insert fails on column count. A `SCHEMA_VERSION` mismatch drops and rebuilds
  instead — safe because everything but `pending` is a projection.
- **A `toolCall` content part names its tool in `name`; a `toolResult` message uses `toolName`.**
  Reading only `toolName` leaves every assistant invocation unlabelled. Tool counts come from the
  published `Metrics` records rather than being recomputed, so the dashboard and the collection cannot
  drift.
- **`position: sticky` creates a stacking context.** The sidebar is sticky, so a popover's `z-50` only
  competes inside it; `<main>` paints later in DOM order and its own sticky elements bleed through.
  The `z-30` on the `<aside>` is load-bearing.
- **`src/lib/underlay/hash.ts` and its test are ported from `underlay-hot` unmodified.** It is a Web
  Crypto port of Underlay's own hash, pinned against vectors generated from Underlay's implementation.
  If those tests fail, every commit re-uploads every record. Copy the tests with the code.
- **No TypeScript-only runtime syntax under `src/lib` or `tools`** — no parameter properties, enums,
  namespaces or decorators. The CLI tools run under Node's strip-only TypeScript mode, which removes
  types but cannot emit code. Vitest is more forgiving, so this breaks at runtime rather than in tests.
- **Underlay's paging state is nested under `pagination`**, and `hasMore` is authoritative — a final
  page can still carry a `nextCursor`.
- **Underlay's AJV runs `strict: false`**, which is why the unknown `private` keyword in the schema
  passes through rather than being rejected. Its extra-field check reads only the *top level* of
  `data`, which is why `Entry.entry` can be an unconstrained object and let unknown future record
  types survive without a schema change here.
- **Interface copy is declarative.** Headers and descriptions say what a thing is; the reasoning lives
  in this README, not on screen.
- **React Compiler is off**, as in the sibling projects: `@vitejs/plugin-react` v6 transforms with oxc
  and dropped the `babel` option. It is an optimization, not a correctness requirement.
- **Light mode only.** A dark mode needs its own steps validated against a dark surface; absent beats
  wrong.
- This app diverges from the portfolio's demo conventions, which assume static sites on Cloudflare
  Pages. It needs a control plane, so it follows the `underlay-hot` architecture instead. The tooling
  conventions apply in full.

## Session data

**No session data is in this repository, and none should be.** The corpus used in development is
referenced by path through `CHI_CORPUS_DIR`; `chi-eval-corpus/` and `*.jsonl` are gitignored.

That corpus was shared under terms that forbid redistributing transcript content, so the collections
this app creates are **private without exception** — there is a test asserting it. Privacy in Underlay
is evaluated per collection over globally shared records, so a single public layout would expose the
records in the private ones too.

Source labels are `User 1…N` and `Unattributed`, never names. A source is a *machine*, not a person:
one recording root can be a shared environment, and sessions without a working directory cannot be
attributed at all. Tests that assert anonymisation derive the strings they forbid from the data at
runtime rather than hardcoding them, so this repository carries no usernames or machine paths.
