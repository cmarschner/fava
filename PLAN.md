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

## Queued next phases (explicitly out of scope for now)

Not building ahead of what's asked - the user said "we will do a major
UI update later once this works." Noted here so the plan stays
discoverable across sessions.

- **Phase 2 - hierarchy-aware pivot rows**: use `stratify_accounts()`
  from `frontend/src/lib/tree.ts` (already powers the Treemap/Sunburst/
  Icicle charts) to turn a flat account-name row dimension into an
  indented category tree with subtotals per level, matching Lexware's
  own row hierarchy instead of one flat row per leaf account.
- **Phase 3 - starter query snippets**: a small set of ready-made BQL
  queries (e.g. monthly expenses by category, year-over-year income)
  that open directly into the Phase 1/2 pivot view, so the user doesn't
  need to hand-write BQL for the reports they used most in Finanzmanager.

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
