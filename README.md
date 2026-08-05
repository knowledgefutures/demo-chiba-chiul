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

Phase 1 (the surface app) is in progress; Phase 2 (org provisioning, permissions) follows.

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
pnpm check                        # tsc + oxlint + vitest

export CHI_CORPUS_DIR=../../proj_kf-meta/planning/local/demos/chiba-chi/chi-eval-corpus
pnpm test                         # the offline gate, over the real corpus

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
