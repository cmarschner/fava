# Query pivot reports

## Why

The user is replacing Lexware Finanzmanager with beancount/Fava. Every
report they relied on in Finanzmanager was built as a pivot: rows are a
category/account hierarchy with subtotals, columns are a period breakdown
(month/quarter/year) via a "Spalten-Aufteilung" control, cells are
aggregated amounts. Fava's Query page is the closest existing analog - it
already gives general BQL access and already produces the right
long-format data (one row per group-by combination) - it just renders
that data as a flat table today, with no way to cross-tabulate it into
rows x columns.

This plan adds pivot *rendering* on top of the existing Query report. It
is explicitly not a new report type: the query itself, its BQL, and the
flat-table code path are all untouched and remain the default. Pivoting
is an opt-in reshaping of an already-fetched query result, done in the
frontend.

## Phase 1: flat pivot table (no hierarchy yet)

Goal: pick any two "dimension-ish" columns and one "value-ish" column
from an existing query result and see them cross-tabulated, with correct
sums, without changing the query itself or breaking anything for people
who don't use it.

Hard constraint: default behavior must regress cleanly to today's flat
table. When no column grouping is selected, the query result renders
exactly as `QueryTable.svelte` already does now - pivoting must never be
a behavior change for existing saved queries or anyone not touching the
new control.

- [ ] `frontend/src/reports/query/pivot.ts` - pure function
      `pivot_table(table, row_col, col_col, value_col, agg)` that groups
      `QueryResultTable` rows by `(row_key, col_key)` and aggregates
      `value_col`. Unset row/col/value column means "don't pivot" - the
      caller falls back to flat rendering.
- [ ] `frontend/src/reports/query/PivotTable.svelte` - renders a
      `PivotResult`, reusing the same cell-formatting logic as
      `QueryTable.svelte` (the Amount/Inventory/Position/`$num` branches)
      so pivoted numbers look identical to the rest of Fava. Extracted
      that formatting into a shared `QueryCellValue.svelte` used by both
      tables instead of duplicating the branches.
- [ ] `QueryBox.svelte` - small Rows / Columns / Values dropdown control
      near the existing chart-type toggles / "Download as CSV" link.
      Defaults to unset (= current flat behavior). Only shown when the
      result shape makes pivoting sensible (at least one string-ish
      column, one date-ish-or-low-cardinality column, one numeric
      column) - never forced on every query result.
- [ ] Client-side CSV export for the pivoted view (the pivot only exists
      in the frontend, so the existing server-side
      `download-query/query_result.csv` link can't reflect it) - only
      shown/used while pivoting is active; the server-side links stay
      for the flat case.
- [ ] Live-verified in the browser: a query with no pivot columns
      selected renders identically to today; selecting Rows/Columns/
      Values produces a real pivoted table with correct sums, spot-
      checked against the same query run flat.

## Precise query error display

Real finding (verified directly against the installed beanquery/tatsu
packages, not assumed): `beanquery.ParseError` and `CompilationError`
both carry a `parseinfo` attribute (a `tatsu.infos.ParseInfo`
NamedTuple: `tokenizer, rule, pos, endpos, line, endline, alerts`).
`endline` is unreliable for our purposes (beanquery's own parser
populates it with `[]`, not a real line number - don't use it). The
tokenizer exposes `poscol(pos)` to get the real column for an arbitrary
position. `CompilationError.parseinfo` can be `None` (no AST node
attached) - position info is best-effort, not guaranteed.

Today, `QueryParseError`/`QueryCompilationError` in
`fava/src/fava/core/query_shell.py` wrap the beanquery exception into a
plain string message and discard `parseinfo` entirely; the JSON error
response (`ErrorResponse` in `json_api.py`) is just `{error: str}`; the
frontend (`frontend/src/lib/fetch.ts`'s `error_response_validator`,
`FetchHTTPError`) only ever extracts that string. Position data is lost
at three separate points before it would reach the UI.

- [ ] Backend: `QueryParseError`/`QueryCompilationError` capture
      `pos`/`endpos`/`line`/`col` (via `parseinfo.tokenizer.poscol(pos)`)
      as attributes when available, `None` otherwise.
- [ ] Backend: `ErrorResponse` gains optional `pos`/`endpos`/`line`/`col`
      fields (default `None`, so every other error path is unaffected);
      a new `errorhandler(FavaShellError)` (more specific than the
      existing generic `FavaAPIError` handler, so Flask dispatches to it
      for query-shell errors) includes them in the JSON response.
- [ ] Frontend: `fetch.ts` parses the optional position fields off the
      error response and attaches them to a `FetchHTTPError`/query error
      value instead of collapsing everything to a bare message string.
- [ ] Frontend: `Query.svelte`'s result type carries the structured
      error (message + optional position) instead of a plain string.
- [ ] Frontend: `QueryBox.svelte` shows the error message prominently
      (styled like other Fava error states, not a small plain-text
      line) and, when position data is available, highlights the
      offending span in the query editor via a CodeMirror decoration -
      falls back gracefully to just the message when position data is
      missing (PEG-parser backtracking means parse errors don't always
      land on the most intuitive character - confirmed empirically, not
      assumed to be pixel-perfect).
- [ ] Live-verified in the browser with a real malformed query.

## Phase 2 - cash-flow lens: account exclusion + account-pool reports

Real need, not hypothetical: the user wants two related but distinct
ways to get a cleaner view than "every real posting in the ledger" -
Finanzmanager did this via a report-level account-checkbox list; that
concept doesn't exist yet for the Query/pivot view.

**2a. Simple account exclusion filter** (general purpose, applies to
any report): a real account multi-select ("Exclude accounts:")
alongside the existing Rows/Columns/Values controls. Excluding an
account just drops every posting-row touching it before pivoting -
plain BQL `WHERE account NOT IN (...)`-shaped filtering, exposed as a
UI control instead of hand-written BQL. This alone solves "hide
Income:Gehalt:RSU so it doesn't skew an income diagram" - RSU vesting
just disappears from the aggregate, same as removing any other
account from a Finanzmanager report. Defaults to unset (regression
discipline unchanged from Phase 1).

**2b. Account-pool ("cash-flow lens") reports** - a harder, separate
problem: the user wants to look at just their checking accounts and
see Tilgung (mortgage principal repayment) show up as a real cost line
- even though structurally it's a transfer to a Liabilities account,
not an Expenses account - while a transfer between two of the user's
*own* checking accounts should vanish entirely (not show as income,
expense, or an unlabeled residual), since no real economic event
happened.

Real design question the user asked directly: would this need tags on
every relevant transaction, or is there an easier way? Tags would mean
tagging every RSU/transfer transaction forever as new ones arrive, and
still wouldn't get Tilgung to read as a cost without *also* inventing
a fake tag-to-Expenses remapping. There's a cleaner mechanism that
needs no per-transaction tagging at all:

Define the report around a user-selected **pool of accounts** (e.g.
every real checking/Giro account). For every real transaction that
touches at least one pool account:
- If *every* posting in that transaction is inside the pool (a
  transfer between two of the user's own checking accounts) - it's a
  pure internal reshuffle, net zero by construction. Exclude it
  entirely; it never appears as income, expense, or residual.
- If *some* postings are inside the pool and *some* are outside - the
  outside posting's account becomes that flow's real category,
  automatically, with no special-casing for whether it happens to be
  Expenses:, Liabilities:, Income:, or Assets:Depot:. Tilgung
  (Assets:Bank:Girokonto <-> Liabilities:Kredite:...) is exactly this
  shape - the Liabilities:Kredite:... leg becomes its natural bucket,
  a real cash outflow, with zero reclassification hackery.

This single mechanism gets both of the user's real cases for free:
RSU vesting (Assets:Depot:... <-> Income:Gehalt:RSU) never touches a
checking-account pool at all, so it's structurally absent from that
view without needing an exclusion rule; Tilgung automatically reads as
a real outflow under its own real account name; a genuine transfer
between two of the user's own pool accounts nets to zero and
disappears, as it should. Narrowing the pool to a single account
(rather than "all checking accounts") changes this correctly too - a
transfer to another of the user's *own but non-pool* accounts would
then correctly show as a real flow out of that specific account,
which is the right answer for that narrower question.

Real edge case to handle explicitly, not silently: a transaction
touching three or more accounts, some inside and some outside the
pool (e.g. a paycheck split between net pay to Girokonto and separate
Lohnsteuer/Sozialversicherung withholding legs) - each outside leg
becomes its own bucketed flow, not collapsed into one combined row.

Implementation:
- Needs entry-level data (all postings per transaction), not flat
  per-row aggregates - a row-at-a-time BQL query can't express "every
  posting in this transaction," so this needs the same foundation
  already flagged in Phase 6 below (BQL's `journal` built-in, or a
  dedicated endpoint returning full transactions with every posting).
- New logic (backend or frontend - whichever keeps this closest to
  the existing Phase 1 pivot data flow) groups entries by transaction,
  partitions each transaction's postings into pool/non-pool, excludes
  transactions with no non-pool posting, otherwise emits one flow row
  per non-pool posting.
- New UI control alongside Rows/Columns/Values: a real account
  multi-select ("Cash-flow pool:"), separate from 2a's exclusion
  list - defaults to unset/off, same regression discipline as
  everything else in this plan.
- Once flows are bucketed by real account, Phase 3 below's
  hierarchy-stratification applies directly - a Liabilities:Kredite:...
  flow rolls up into a parent category exactly like any Expenses:...
  one already does.
- Live-verified against a real example: pooling the user's real
  checking accounts should show 2024/2025 Tilgung payments as real
  outflows, and RSU vesting should be completely absent - not zero,
  not miscategorized, structurally never appears.

## Queued next phases (explicitly out of scope for now)

Not building ahead of what's asked - the user said "we will do a major
UI update later once this works," though Phase 2 above is now being
executed per a direct follow-up request. Phases below stay queued
until asked for. Noted here so the plan stays discoverable across
sessions.

- **Phase 3 - hierarchy-aware pivot rows**: use `stratify_accounts()`
  from `frontend/src/lib/tree.ts` (already powers the Treemap/Sunburst/
  Icicle charts) to turn a flat account-name row dimension into an
  indented category tree with subtotals per level, matching Lexware's
  own row hierarchy instead of one flat row per leaf account.
- **Phase 4 - drill-through links and period-over-period deltas**:
  1. **Drill-through links**: not just individual cells - three
     related but distinct link targets, each filtered to only what it
     actually represents:
     - A **cell** (row_key + col_key) links to the Journal filtered by
       both, the same "Kontoblatt" drill-down Finanzmanager's
       Minibericht gives you.
     - A **row header** links to the Journal filtered by just that row
       value, across every column (e.g. the whole account, all
       periods).
     - A **column header** links to the Journal filtered by just that
       column value, across every row (e.g. the whole period, every
       account).
     Don't assume columns are always a time period - the column
     dimension can be any pivoted field (another category, a payee,
     etc.), same as rows. The filter each link carries depends on
     what that dimension actually is (account-like -> `account=`,
     date-like -> `time=`, otherwise whatever the Journal's filter bar
     can express for it, if anything) - only show a link when the
     dimension is genuinely translatable into a real filter, same
     don't-force-it discipline as the rest of this plan. If the
     underlying query has its own WHERE clause beyond the pivot
     dimensions (e.g. `account ~ '^Expenses'`), investigate whether
     that can be folded into these links too (via the advanced filter
     bar's boolean syntax) rather than only carrying the row/col
     values - note the real limitation if that turns out to be
     impractical rather than forcing it.
     This is inherently a live-UI feature - none of it can carry over
     into the CSV export (static data, no links), which is fine and
     expected, not a gap to fix.
  2. **Period-over-period delta columns**: a checkbox (or small
     control) that, when enabled, adds absolute and/or % change vs.
     the immediately preceding column, per row, sortable the same way
     as any other pivot column. Real edge case to handle explicitly,
     not silently: when the previous column's value is zero (or
     missing), % change is undefined - show that as a real "n/a"/dash
     state, never `Infinity`/`NaN`/a raw division error. Absolute and
     % delta are conceptually separate toggles (user said "absolute
     and/or %") - support enabling either or both independently rather
     than one combined mode.
- **Phase 5 - starter query snippets**: a small set of ready-made BQL
  queries (e.g. monthly expenses by category, year-over-year income)
  that open directly into the Phase 1-4 pivot view, so the user doesn't
  need to hand-write BQL for the reports they used most in Finanzmanager.
- **Phase 6 - unify the Journal and Query views**: real architectural
  finding (verified, not re-derived): the Journal/Kontoblatt view and
  the Query view are two genuinely separate systems today - Journal uses
  a hand-built filter-DSL (`TimeFilter`/`AdvancedFilter`/`AccountFilter`
  in `fava/core/filters.py`) over a flat Python list of real directives,
  entirely separate from BQL/beanquery. But BQL's built-in `journal`
  command already returns real entry-level rows (date, flag, payee,
  narration, account, position, balance), not aggregated data - so this
  is a rendering gap, not an engine gap. Two separate, real
  improvements (not one big rewrite):
  1. Recognize when a Query result is entry-shaped (from the `journal`
     built-in, or any query returning that same real-entry shape) and
     render it with the same rich Journal/Kontoblatt component (inline
     editing, document links, type filters, sort) instead of the
     generic flat table - lets any BQL query, including ones with a
     richer account filter than the current bar supports, become a
     fully-featured editable journal view.
  2. Separately: enrich the Journal's own Account filter for real
     multi-account include/exclude (closer to Finanzmanager's checkbox
     list) - doesn't need BQL, independent of #1.
  Explicitly NOT in scope for Phase 6: aggregated/pivoted Query results
  (Phases 1-4's work) don't get this treatment - those aren't
  individual entries, so Kontoblatt-style editing doesn't apply there;
  that stays on the table/pivot rendering path.
  User's instruction: implement once Phases 1-5 are done - queued here,
  not started.

## Verification checklist (this branch, before it's considered done)

- [ ] Flat rendering is byte-identical to pre-change behavior when no
      pivot columns are selected (existing saved queries, tests).
- [ ] A real pivoted table produces correct sums, spot-checked against
      the same query run flat / against `bean-query` directly.
- [ ] A real malformed query shows a visible, styled error, with the
      offending span highlighted in the editor where position data is
      real and available.
- [ ] Existing Fava test suite passes.
- [ ] Committed at real milestones on `feature/query-pivot-reports`, off
      `integration/all-changes`. Not merged, not pushed - that's a user
      decision once this is reviewed.
