# chiul

Chi session logs → Underlay collections, and a team surface for exploring them.

Built with the [Chi](https://github.com/henkaku-center/chi) team at Chiba Tech, who record AI coding
sessions as portable Pi v3 JSONL. chiul projects those logs into versioned, content-addressed
Underlay collections and puts a workspace on top of them.

> Chi keeps its own backend, its own contracts, its own canonical format. It **publishes** to
> Underlay as a persistence and citation substrate — and inherits an ecosystem it did not build.

Because the sessions land as ordinary collections, [`ask`](https://github.com/knowledgefutures/underlay-ask)
can answer questions over them, [`hot`](https://github.com/knowledgefutures/underlay-hot) can hand an
app a writable working copy, and `graph` can draw them — with no Chi-side integration each.

Plan and rationale: `proj_kf-meta/planning/local/demos/chiba-chi/init.md`.

## Status

**Phase 0 closed.** The corpus is in five private collections under the `chiba` org on
dev.underlay.org, and the round-trip gate passes end to end:

```
  raw (byte-identical)      0     ← jsonb normalizes key order; expected
  canonical (key order)    65
  semantic (values only)    0
  differs (LOST DATA)       0

65/65 sessions round-tripped with nothing lost
```

**Phases 1 and 2 closed.** The surface app runs: a Worker + React SPA on `:4700`, a D1 control
plane, and one SQLite Durable Object that hydrates 9,429 records out of the collections in ~9
seconds. 39 unit tests and 37 smoke checks pass.

The write path round-trips too. Publishing a layout from the **Team** page reconstructs all 9,429
records inside the Durable Object and pushes them, and Underlay answers:

```
POST …/versions/negotiate/…/commit → 409
  "No changes detected. Version v1.0.0 already has identical content."
```

That is a stronger result than `0 uploaded` — which only proves the record *bodies* were already
stored. A 409 here means Underlay hashed the whole version and could not distinguish this
workspace's reconstruction from the originals, field for field. Two columns exist purely to make
that true (`pg_escaped`, `trailing_newline`); drop either and it quietly starts re-uploading.

## The surface

Five pages behind a sidebar: **Overview** (cost, models, shape), **Corpus** (every record at
once), **Sessions**, **Search**, **Underlay** (the org, its collections, publishing). The persona
switcher sits at the bottom of the sidebar as an account chip — a fixed-position popover, because
inline it grew the sidebar's scroll height and shoved the chip around as it opened.

The page is called **Underlay**, not "Team": it is the side of the app that talks to a specific
Underlay org, and "Team" named an abstraction rather than what the page does. Collection names, the
org chip and the sidebar org block all link out to `dev.underlay.org` — which only resolves for
someone signed in there with access, since every collection is private.


```
Underlay collections (chiba/*, private)
        │  paged reads — the same API any other consumer would use
        ▼
┌── CONTROL PLANE — D1 ────────────────────────────────────┐
│  workspaces · collections · personas · grants            │
└──────────────────────────────────────────────────────────┘
        ▲ persona → grants → what may be sent
┌── DATA PLANE — one SQLite Durable Object ────────────────┐
│  sessions · entries · entries_fts · metrics · links      │
└──────────────────────────────────────────────────────────┘
        ▼
   React SPA — dashboards, session explorer, z selector, search
```

The Durable Object reads **from the collections, not from the corpus**. That makes the surface an
honest working copy of what was published, exercises the read path like any other consumer, and
means the deployed Worker needs no transcripts inside it.

### The look: an instrument, not a website

Three decisions carry it, and they live in `src/client/global.css`.

**Radii are 2–3px, never more.** Soft corners are the single strongest "web app" signal. The
`--radius-*` tokens are all remapped to 2–4px, so even a stray `rounded-xl` cannot round anything;
the only true circle left in the app is the loading spinner. Bar ends keep the 1–2px the mark spec
asks for and nothing else does.

**Neutrals are cool and closely spaced.** The previous set was warm paper (`#f9f9f7`), which reads
editorial. These sit on a slight blue axis with small steps between them, which is what lets borders
be genuine hairlines rather than visible frames.

**Numbers are mono and tabular.** Stat values, table cells, record counts, session figures. A row of
stat tiles becomes a column of digits, which is most of the difference between a dashboard and a
page.

### One colour language, three scales

`src/lib/chi/kinds.ts` classifies every entry by **who is speaking** — human, model, tool, or the
runtime talking about itself — and every view reads from the same table. A 2px tick in the corpus
map, a band in a session strip and a bubble in the transcript that share a colour are the same kind
of thing, which is what makes zooming feel like one continuous view rather than four screens.

Only **three hues** carry identity (blue human, violet model, aqua tool) plus a recessive neutral
for events. That is a constraint, not a preference: in a dense strip any two marks can end up
adjacent, which is the palette validator's `--pairs all` case, and three is the most that clears CVD
separation there. `thinking` shares the model hue and separates by weight instead of taking a fourth
colour. Validated on the light surface: worst all-pairs CVD ΔE 13.0, worst normal-vision ΔE 16.3.
Aqua measures 2.74:1 against the surface — below the 3:1 bar — so it never appears without a visible
label beside it.

Classification was wrong first time in a way worth recording: treating any assistant turn containing
a `toolCall` as `tool` put 7,678 of 9,299 entries in one bucket, rendered the corpus as a wall of
green, and collapsed `thinking` to a single entry, because an assistant turn nearly always carries
reasoning and a call together. Classifying by speaker gives tool 51%, model reasoning 28%, events
11%, model prose 7%, human **3%** — and that last number is itself the finding.

### Access is a grant table, and it is enforced server-side

`grants` maps a persona to what it may see, using **Chi's own z vocabulary as the permission
ladder** — because consent and reduction level turn out to be the same axis. "You may read my
summaries but not my raw logs" is a z ceiling:

| `detail` | Means |
| --- | --- |
| `full` | entries at z=0 — the raw session |
| `reduced` | entries at z≥1 only — summaries, never raw records |
| `metrics` | Session and Metrics records only — shape and cost, no content |
| `none` | not visible at all |

Resolution is most-specific-wins, so a source grant can *narrow* a wildcard — which is what makes
"everyone may see summaries, but User 2 has withheld their sessions" expressible. Within one
specificity the more permissive level wins, so adding a grant can never silently remove access.

The four seeded personas produce genuinely different views of the same data:

| Persona | Sessions visible | Openable | Private `cwd` | Search |
| --- | --- | --- | --- | --- |
| User 1 | 65 of 65 | 10 (own) | own only | own sources only |
| User 2 | 65 of 65 | 20 (own) | own only | own sources only |
| Team steward | **45 of 65** | 45 metadata, 0 raw | never | nothing |
| Outsider | 65 of 65, no titles | 0 | never | nothing |
| Chi core | 65 of 65 | 65 | everywhere | everything |

`Chi core` is the default, and the reason it exists is a mistake worth recording. The demo used to
open as `Outsider` — least privilege, correct for a product — which made every list empty and every
search return nothing. The access model working exactly as designed, and indistinguishable from a
broken app. A demo should open on the view that shows the data; the restricted personas are now
something you deliberately switch *to* in order to watch access bite.

Two rules keep this from being theatre. Filtering happens **in the Worker** — a persona that may not
read a session never receives it, rather than receiving it and having the UI hide it. And what is
withheld is **named and counted** rather than silently dropped, because a dashboard that quietly
excludes a third of the team reads as a complete picture when it is not.

Search is gated at `full` rather than `reduced`: a snippet is raw session text, so letting a
summaries-only persona search raw entries would route straight around their own grant. Provisioning
is gated on full access to *every* source, because publishing copies everyone's records into a new
collection and a restricted persona must not be able to launder data it cannot read.

### The gate is a curtain, and says so

One shared `DEMO_PASSWORD` in an HMAC-signed cookie, no KF Auth. It **fails closed** — an
environment with no password set is locked, not open, on the same principle as Ask's `ADMIN_ONLY`.
The persona is a signed cookie value rather than a client-supplied header, so the client cannot
claim a persona it was not given; but anyone with the link may *choose* any persona, and both the
landing page and `GET /api/me` say so outright.

## The data model

Four record types. The type boundary is deliberately placed where Chi's own validity boundary
already falls (`packages/chi-commons/DESIGN.md` § 0):

| Type | Side | What it is |
| --- | --- | --- |
| `Entry` | endomorphism | One Pi v3 entry, verbatim, at one reduction level. Valid v3 in, valid v3 out. |
| `Reduction` | endomorphism | One derivation: `(strategy, z, reducerVersion)` plus exact source lineage. |
| `Session` | projection | Derived metadata spine. Not v3. |
| `Metrics` | projection | Deterministic field-algebra output. Not v3. |

**`z` is a field on `Entry`, not a type.** Splitting by z would break two things that matter:
content-address dedup across ingests (identical records would land in different types) and
schema-hash alignment across collections (each person's collection would define a different shape).
`z` is denormalised onto the entry for cheap filtering, but `reductionId` is the real
discriminator — Chi's address is `(sessionId, strategy, z, range)` and many reduction trees can
exist per session, so two records at `z=1` under different strategies are not comparable.

`Reduction`'s fields are a transcription of Chi's own reduction north star
(`backend/docs/ARCHITECTURE.md`): *"every output records exact input hashes/IDs, source
repos/sessions, reducer and prompt versions, model, fan-in, and authorization scope."*

## The round-trip gate

The claim chiul rests on is that a Pi v3 session survives the trip into Underlay and back with
nothing lost. That is tested over the real corpus — 65 sessions, 9,299 entries — rather than a
fixture, and it is stated as three assertions rather than one slogan:

| | Assertion | Status |
| --- | --- | --- |
| **A** | **Semantic identity** — every record deep-equal, identical counts, identical `id`/`parentId` tree | Must hold exactly. This is the actual claim. |
| **B** | **Canonical-byte identity** — identical after recursive key sorting. Catches float drift, unicode mangling, null coercion, truncation. | Must hold. |
| **C** | **Raw-byte identity** | **Expected to fail, by design.** See below. |

C fails because `record_objects.data` is a Postgres `jsonb` column. `jsonb` is a parsed
representation: it normalizes key order and discards whitespace. No client can preserve key order
through it. Two things make that a small loss: JSON declares object keys unordered (RFC 8259) and
Pi's loader does not care about order, so a file reassembled from A is still valid, resumable v3 by
Chi's own definition ("valid means accepted by Pi's loader"). And `jsonb` stores numbers as
arbitrary-precision `numeric`, not float8, so a cost like `0.030985000000000002` survives exactly.

`src/lib/chi/corpus.test.ts` proves A and B **offline**, by simulating the `jsonb` normalization
locally (`sortKeys`), so the gate runs in CI with no database. `tools/roundtrip.ts` then confirms it
end to end against a real instance.

If C is ever actually wanted, it is one field: store the source line as a string beside the parsed
entry. It costs a one-time ~45 MB and makes the schema redundant, so it is a switch to offer rather
than a default to assume.

## Four things we found in the corpus

All four are upstream findings, worth passing back. The first two are Chi's; the last two are
Chi's *and* Underlay's.

1. **The session header is not always line 1.** 11 of the 65 files open with a `title` record
   carrying a `pad` field of trailing spaces — a fixed-width slot so the title can be rewritten in
   place without rewriting the file. The corpus README says "the first record is a `session`
   header"; an importer built to that spec rejects a sixth of the corpus. `parseSession` locates the
   header instead of assuming its position.

2. **`index.json` loses attribution to that same assumption.** Those same 11 rows carry
   `sessionId: null` and `cwd: null`, because the index builder reads the header from line 1.
   `startedAt`, `messages` and `approxTokens` are correct in those rows — they scan every line — so
   the defect is precisely "header assumed at `[0]`", a one-line fix. The consequence is that the
   corpus README attributes 40 missing `cwd`s to deliberate anonymisation, when 11 of them were
   never removed: the paths are still in the session headers. chiul reads `cwd` from 36 of 65
   sessions where the index reports 25.

3. **Two records carry characters Postgres JSON cannot store.** Out of 9,299, in two different
   sessions, both from binary data landing in tool output: one `web_fetch` toolResult with **7 NUL
   bytes** (U+0000), and one with a **lone surrogate** (unpaired U+D800–DFFF — valid in a JS string
   and representable in JSON text, but not a Unicode scalar value, so it cannot be encoded as UTF-8).
   `jsonb` refuses both. Handled by a declared, reversible escape (`src/lib/chi/unstorable.ts`),
   marked `pgEscaped: true` on the record and reversed on read, so the round trip stays lossless.

   Worth Chi knowing independently of Underlay: their logs contain bytes that **no** Postgres-backed
   store can hold, which is a constraint for any consumer.

4. **Underlay reports that as an opaque 500.** `POST .../negotiate/:id/records` returned
   `500 Internal Server Error` naming neither the record nor the reason, on a batch of ~1,000. It
   cost a bisect to find two records. That should be a 4xx identifying the offending record — an
   upstream improvement worth filing.

All four are pinned as tests, so they cannot silently regress.

## Privacy and terms

The corpus is shared under terms that forbid redistributing transcript content, and it is the only
surviving server-side copy of the pre-migration sessions. So:

- **The corpus is never committed to this repo.** It is referenced by path (`CHI_CORPUS_DIR`) and
  treated as read-only. Nothing writes derived artifacts into it.
- **Every collection chiul creates is private, with no exception.** Privacy in Underlay is evaluated
  per collection over globally shared records, so a single public layout would expose every record
  in every other layout. There is a test for this.
- **Sources are labelled `User 1…N` and `Unattributed`, never by name.** A source is a *machine*,
  not a person: one of the three `cwd` roots is a shared dev.exe environment either participant could
  have been using, and 29 sessions have no `cwd` at all. Getting the real mapping is a question for
  the Chi team, not an inference.
- `Session.cwd` ships as a `private: true` schema field. Note what that does and does not buy:
  field-level filtering applies to a caller who **can read** a collection but does not own it. A
  *private* collection returns `404` to an outside caller, so nothing is filtered because nothing is
  reachable. The declaration is still correct and binds the moment a collection is shared more
  widely — but per-persona visibility on private data is the surface layer's job, not Underlay's.

## Running it

```sh
pnpm install
cp .env.example .dev.vars         # then fill in the three values below
pnpm db:migrate:local             # apply control-plane migrations to local D1
pnpm dev                          # vite build + wrangler dev on :4700
```

`.dev.vars` needs three things:

| Variable | For |
| --- | --- |
| `UNDERLAY_API_KEY` | read access to the private `chiba` collections |
| `DEMO_PASSWORD` | the shared gate password. Unset means nobody gets in |
| `SESSION_SECRET` | signs the gate and persona cookies |

Then open http://localhost:4700, enter the password, and press **Hydrate from Underlay** on the
overview (or `POST /api/workspace/hydrate`). It reads ~9,429 records in about 9 seconds.

Port note: this runs on **4700**. 4300 is Hot, 4400 is Ask, and 4500/4600 were already taken.

```sh
pnpm check                        # tsc + oxlint + vitest + vite build
node tools/smoke.mjs              # every route, plus the access model per persona
```

`smoke.mjs` exists because a refactor once silently deleted seven route registrations in Hot and
every other gate passed — tsc does not typecheck route strings and the Worker still boots. It also
asserts the grants behaviour per persona, since "the grant table is right" and "the API applies it"
are different claims and only the second matters.

### The Phase 0 tools

```sh
export CHI_CORPUS_DIR=../../proj_kf-meta/planning/local/demos/chiba-chi/chi-eval-corpus
pnpm test                         # the offline round-trip gate, over the real corpus

node tools/ingest.ts --dry-run                    # what would be created
node tools/ingest.ts --dry-run --grouping repo
```

To push, you need an Underlay org and a write-scoped API key. Collection creation checks that the
key's user is a **member** of the owning org, and orgs come from KF Auth rather than an API
endpoint — so the org is created in the UI, not provisioned by this tool.

```sh
export UNDERLAY_URL=https://dev.underlay.org
export UNDERLAY_API_KEY=ul_…                      # dev.underlay.org → Settings → API keys
node tools/ingest.ts --owner <org-slug>
node tools/roundtrip.ts --owner <org-slug>
```

### Both groupings, one copy of the bytes

Run ingest twice and watch the second one:

```sh
node tools/ingest.ts --owner <org> --grouping person   # 4 collections, ~9,429 records uploaded
node tools/ingest.ts --owner <org> --grouping repo     # 1 collection,  0 records uploaded
```

The second layout uploads nothing. Records are global and content-addressed, a version is a
manifest of hashes, and hash negotiation reports the far side already has everything — so a second
grouping costs one manifest. A collection is the unit of *access control, versioning and identity*,
not a storage bucket. That is what makes "per person **and** per repo" free rather than a tradeoff.

## The write side: a fast layer in front of Underlay

Underlay versions are **commits** — a manifest plus a version hash — which suits batches and
not per-turn appends. So chiul buffers: a session writes here at app latency, the writes land
in the Durable Object immediately, and Underlay receives **one version per flush interval**
instead of one version per turn.

```
Chi session ──POST /api/ingest──▶  pending (Durable Object)  ──every N minutes──▶  Underlay
              Bearer <write token>        instant                                  one version
```

| Surface | Auth | Who |
| --- | --- | --- |
| `POST /api/ingest` | `Authorization: Bearer <write token>` | machines |
| `GET/POST /api/ingest/{status,tokens,policy,flush}` | demo gate + full read access | operators |

The machine endpoint **refuses the demo cookie**. If it accepted one, any page a viewer visited
could write session logs on their behalf. And minting a write token needs the same full read
access that publishing does, because a token can append to any collection this workspace
publishes — a restricted persona must not be able to hand out a key that writes to a source it
cannot read. Both halves are asserted in `tools/smoke.mjs`.

Three properties worth knowing:

- **Writes are idempotent** by `sessionId:entryId`. A client that replays a session after a
  reconnect adds nothing, which matters because Chi's duplicates come from replication rather
  than concurrency — so it is safe to point two machines at the same endpoint.
- **A flush and a re-publish are the same operation.** Buffered entries join the main tables,
  then the layout is published; content addressing means only genuinely new records travel. A
  measured flush of one 4-entry session into the 9,429-record collection uploaded **1 record**
  and produced `v1.1.0`.
- **Tokens are stored hashed**, with only a display prefix kept, and returned exactly once.
- **The buffer survives a schema rebuild.** `pending` is the one table excluded from the
  drop-and-rebuild on `SCHEMA_VERSION` mismatch: everything else is a projection that
  `hydrate()` can rebuild, but buffered writes are data a client already handed us.

UI copy across the app is deliberately declarative — "Write your logs", "Push to Underlay" — rather
than explaining the design. The reasoning lives in this README; the screen says what it does.

An operator-only `POST /api/ingest/discard` drops the buffer without publishing, which exists because
the buffer is the one place holding uncommitted data: without it, test writes accumulate and the next
push commits them into a real collection. It also clears session rows left with no entries, since
`accept()` creates a placeholder row as soon as a writer names a repo.

`autoFlush` is off by default. When on, a cron (`*/5 * * * *`) checks whether the workspace's
own configured interval has elapsed — the schedule is a floor, the interval is the policy — and
a failed flush leaves the buffer intact for the next run rather than dropping it.

## Deploying

Nothing here is Cloudflare-specific beyond Workers + D1 + Durable Objects. The full sequence:

```sh
# 1. The D1 database already exists and its id is in wrangler.jsonc:
#      chiba-chiul  ee1f02c6-b04f-4752-92ab-7e5881e67585
#    For a new environment: npx wrangler d1 create <name>, then paste the id in.

# 2. Apply migrations to the remote database
npx wrangler d1 migrations apply chiba-chiul --remote

# 3. Set the three secrets (never in wrangler.jsonc — it is committed)
npx wrangler secret put UNDERLAY_API_KEY    # read+write on the chiba org
npx wrangler secret put DEMO_PASSWORD       # the shared gate password
npx wrangler secret put SESSION_SECRET      # any long random string

# 4. Deploy (builds the SPA, then uploads the Worker, DO and assets)
pnpm deploy

# 5. Hydrate once — a fresh Durable Object starts empty
#    Open the deployed URL, enter the password, press "Hydrate from Underlay".
```

Notes:

- **Never leave `database_id` as a placeholder**, even for local work. `wrangler d1 …` resolves
  the database by *name* and keys its local file by the resolved **remote** id, while
  `wrangler dev` keys local storage by the `database_id` in config. With a placeholder the two
  land on different local SQLite files, and the dev server reports `no such table: workspaces`
  against a database the CLI has just migrated successfully. Worse: `wrangler d1 execute --local`
  will **create the remote database** as a side effect of resolving the name, so a "local" command
  can provision a cloud resource.
- **The DO migration is already declared** (`new_sqlite_classes: ["Workspace"]`), so the first
  deploy creates the class. Later renames of that class need a new migration tag.
- **The cron trigger deploys with the Worker.** It does nothing until `autoFlush` is switched on
  in the UI.
- **`APP_URL` should be set to the deployed origin** in `wrangler.jsonc` `vars`, because the
  ingest panel shows it as the endpoint to write to.
- A `workers.dev` subdomain is fine for a gated demo; a custom domain is a route, not a rewrite.
- `compatibility_date` is pinned; bump it and the installed `workerd` together.
- **`wrangler dev` reads `.dev.vars` at startup only.** Editing a secret while it runs leaves the
  old value in memory, and the symptom is a correct password being rejected. Restart after editing.
- **`wrangler dev` reloads when the built assets change**, and a reload can leave the Durable
  Object empty — so `pnpm dev` in one terminal plus `vite build` in another will occasionally
  require re-hydrating. `tools/smoke.mjs` hydrates itself if it finds the workspace empty.

### Can the repo be public?

**Yes on secrets — verified, not assumed.** No `.dev.vars`, no `.env`, no `*.jsonl`, and no
corpus file has ever been committed; the history contains no token-, password- or key-shaped
string. The corpus is referenced by `CHI_CORPUS_DIR` and `chi-eval-corpus/` plus `*.jsonl` are
gitignored.

Two categories were in the source and have been removed, because a public repo is a different
bar from a private one:

- **Real usernames and machine paths** appeared in the anonymisation test's own regex and as a
  literal expected `cwd`. Both now derive from the corpus at runtime, which is *stronger* as a
  test — it covers whatever roots the data actually contains — and leaves no identifiers here.
- **Two session ids** from the private corpus were test fixtures. The tests now locate those
  records by the property under test (contains a NUL; contains a lone surrogate) instead.

One category is left, and it is the Chi team's call rather than ours: this README and the tests
describe **their** corpus in some detail — 9,299 records, $368.85 of spend, the model mix, and
a defect in their exporter. None of it is transcript content, and all of it is useful
engineering documentation. But it is a description of a private dataset belonging to someone
else, so ask before making the repo public.

## Notes for whoever works on this next

- **This demo diverges from `conventions/reference/demos.md`,** which assumes demos are static sites
  on Cloudflare Pages. Phases 1–2 need a control plane, so the architecture follows
  `underlay-hot` instead: Cloudflare Workers + static assets + D1 + one SQLite Durable Object. The
  tooling conventions from `stack.md` still apply in full.
- **`src/lib/underlay/hash.ts` and its test are copied from `underlay-hot` unmodified.** It is a Web
  Crypto port of Underlay's own hash, pinned against vectors generated from Underlay's
  implementation. If those tests fail, every commit re-uploads every record — treat them as
  load-bearing, and copy the tests along with the code.
- **No TypeScript-only runtime syntax under `src/lib` or `tools`** — no parameter properties, enums,
  namespaces, or decorators. The tools run under Node's strip-only TypeScript mode, which removes
  types but cannot emit code. Vitest is more forgiving, so this breaks at runtime rather than in the
  test suite.
- **Underlay's paging state is nested under `pagination`**, and `hasMore` is authoritative — a final
  page can still carry a `nextCursor`.
- **Underlay's AJV runs `strict: false`**, which is why the unknown `private` keyword in the schema
  passes through rather than being rejected. And its extra-field check reads only the *top level* of
  `data`, which is why `Entry.entry` can be an unconstrained object and let unknown future record
  types survive without a schema change here.
- **Never `DELETE FROM` an FTS5 external-content table.** `entries_fts` is a view over `entries`, not
  a copy, so `DELETE` writes delete-markers for rows that are about to vanish and the next rebuild
  lands on an index disagreeing with its content table. It surfaces on the *following* hydrate as
  `SQLITE_CORRUPT_VTAB`, which reads as a disk fault and is not one. Drop the table and
  `INSERT INTO entries_fts(entries_fts) VALUES('rebuild')` instead.
- **A `toolCall` content part names its tool in `name`; a `toolResult` message uses `toolName`.**
  Reading only `toolName` leaves every assistant invocation unlabelled, which made the tool-mix chart
  silently count tool *results* (4,709) instead of *calls* (4,721) — the same order of magnitude and
  the wrong thing measured. Tool counts now come from the published `Metrics` records rather than
  being recomputed here, so the dashboard and the collection cannot drift.
- **A percentage height needs a parent with a height.** The timeline bars sized by `%` inside
  content-height columns and the whole chart rendered blank, with no error. `h-full` on the column is
  load-bearing.
- **React Compiler is off**, as in Hot and Ask: `@vitejs/plugin-react` v6 transforms with oxc and
  dropped the `babel` option, so the compiler goes through `reactCompilerPreset` now. It is an
  optimization, not a correctness requirement.
- **`position: sticky` creates a stacking context.** The sidebar is sticky, so the persona
  popover's `z-50` only competed *inside* the sidebar; `<main>` painted later in DOM order and the
  corpus page's own sticky session labels bled straight through the popover. The fix is a `z-30` on
  the `<aside>` itself, which is the kind of thing that looks like a stray utility class and is
  load-bearing.
- **`wrangler types` picks up secret names from `.dev.vars`.** Without an entry there, `c.env.X` is a
  type error even though it works at runtime. And appending to a `.dev.vars` with no trailing newline
  glues your variable onto the previous one.
