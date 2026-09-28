<!--
  @component
  PLAN.md Phase 2b - "cash-flow lens" report: pick a pool of accounts
  (e.g. every real checking account) and see every real transaction
  that touches the pool, bucketed by whichever account on the *other*
  side of the transaction isn't in the pool - a pure transfer between
  two pool accounts vanishes entirely, and something like Tilgung
  (a transfer to a Liabilities account) shows up as a real cost line
  under its own real account, with no tagging or reclassification
  needed. See PLAN.md's Phase 2b section for the full design and
  reasoning.

  This is a standalone mini-report, not a modifier on an arbitrary
  saved query (unlike Phase 2a's exclusion filter, which lives inside
  QueryBox) - it fetches its own `journal`-shaped entry data, since the
  pool computation needs every posting of every transaction, which a
  typical aggregate query result doesn't carry.
-->
<script lang="ts">
  import { get_query } from "../../api/index.ts";
  import { _ } from "../../i18n.ts";
  import { FetchHTTPError } from "../../lib/fetch.ts";
  import { err, ok, type Result } from "../../lib/result.ts";
  import { filter_params } from "../../stores/filters.ts";
  import AccountMultiSelect from "./AccountMultiSelect.svelte";
  import { pool_flows_table, table_is_journal_shaped } from "./cashflow_pool.ts";
  import type { QueryError } from "./errors.ts";
  import { PIVOT_AGGREGATIONS, pivot_table } from "./pivot.ts";
  import type { PivotAggregation } from "./pivot.ts";
  import PivotTable from "./PivotTable.svelte";
  import QueryTable from "./QueryTable.svelte";
  import type { QueryResult, QueryResultTable } from "./query_table.ts";

  /** Turn a rejected get_query() promise into a structured QueryError -
   * same shape as Query.svelte's own `to_query_error`, duplicated here
   * (rather than exported/shared) since this component's error display
   * doesn't need the position/range info Query.svelte's version keeps
   * for the query editor's error-highlighting - only the message. */
  function to_query_error(error: unknown): QueryError {
    return {
      message:
        error instanceof FetchHTTPError || error instanceof Error
          ? error.message
          : "INTERNAL ERROR",
    };
  }

  let pool_accounts: string[] = $state([]);
  let journal_result = $state<Result<QueryResult, QueryError> | undefined>(
    undefined,
  );
  let loading = $state(false);

  /** Pivot control state - unset by default, same regression/don't-
   * force-it discipline as every other pivot control in this plan. */
  let pivot_row_col = $state("");
  let pivot_col_col = $state("");
  let pivot_value_col = $state("");
  let pivot_agg = $state<PivotAggregation>("sum");

  $effect(() => {
    // Re-fetch whenever the pool selection or the global filters
    // (time/account/advanced filter) change - `$filter_params` is read
    // here so Svelte tracks it as a dependency, same as Query.svelte's
    // own `rerun_all_open`.
    const params = $filter_params;
    if (pool_accounts.length === 0) {
      journal_result = undefined;
      return;
    }
    loading = true;
    get_query({ query_string: "journal", ...params })
      .then(
        (res) => ok(res),
        (error: unknown) => err(to_query_error(error)),
      )
      .then((res) => {
        journal_result = res;
        loading = false;
      })
      .catch(() => {
        loading = false;
      });
  });

  let journal_table: QueryResultTable | undefined = $derived(
    journal_result != null &&
      journal_result.is_ok &&
      journal_result.value.t === "table"
      ? journal_result.value
      : undefined,
  );

  let flows_table = $derived(
    journal_table != null
      ? pool_flows_table(journal_table, new Set(pool_accounts))
      : null,
  );

  let pivot_active = $derived(
    pivot_row_col !== "" && pivot_col_col !== "" && pivot_value_col !== "",
  );
  let pivot_result = $derived(
    flows_table != null && pivot_active
      ? pivot_table(
          flows_table,
          pivot_row_col,
          pivot_col_col,
          pivot_value_col,
          pivot_agg,
        )
      : null,
  );
</script>

<details>
  <summary>{_("Cash-flow pool")}</summary>
  <div class="pool-report">
    <label>
      {_("Pool accounts")}
      <AccountMultiSelect bind:selected={pool_accounts} />
    </label>
    {#if pool_accounts.length === 0}
      <p class="hint">
        {_(
          "Pick one or more accounts (e.g. every real checking account) to see real flows in and out of them - a transfer between two of the picked accounts is excluded as a pure internal reshuffle, and a transfer to any other account (Expenses, Liabilities like a mortgage principal payment, Income, another Assets account, ...) shows up as its own real flow row.",
        )}
      </p>
    {:else if loading}
      <p class="hint">{_("Loading...")}</p>
    {:else if journal_result?.is_err}
      <p class="query-error">{journal_result.error.message}</p>
    {:else if journal_table != null && !table_is_journal_shaped(journal_table)}
      <p class="query-error">
        {_(
          "The journal query didn't return the expected entry-level shape.",
        )}
      </p>
    {:else if flows_table != null}
      {#if flows_table.rows.length === 0}
        <p class="hint">
          {_(
            "No real flow touches the pool in the current filter range - either nothing happened, or every touching transaction was a pure transfer between pool accounts.",
          )}
        </p>
      {:else}
        <div class="pivot-controls">
          <label>
            {_("Rows")}
            <select bind:value={pivot_row_col}>
              <option value="">—</option>
              {#each flows_table.columns as column (column.name)}
                <option value={column.name}>{column.name}</option>
              {/each}
            </select>
          </label>
          <label>
            {_("Columns")}
            <select bind:value={pivot_col_col}>
              <option value="">—</option>
              {#each flows_table.columns as column (column.name)}
                <option value={column.name}>{column.name}</option>
              {/each}
            </select>
          </label>
          <label>
            {_("Values")}
            <select bind:value={pivot_value_col}>
              <option value="">—</option>
              {#each flows_table.columns as column (column.name)}
                <option value={column.name}>{column.name}</option>
              {/each}
            </select>
          </label>
          {#if pivot_active}
            <label>
              {_("Aggregation")}
              <select bind:value={pivot_agg}>
                {#each PIVOT_AGGREGATIONS as agg (agg)}
                  <option value={agg}>{agg}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
        {#if pivot_result}
          <PivotTable pivot={pivot_result} />
        {:else}
          <QueryTable table={flows_table} />
        {/if}
      {/if}
    {/if}
  </div>
</details>

<style>
  .pool-report {
    padding: 0.5rem 0;
  }

  .pool-report > label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .hint {
    color: var(--text-muted, #767676);
    font-size: 0.9em;
  }

  .pivot-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .pivot-controls label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.9em;
  }

  .query-error {
    color: var(--error);
    font-weight: bold;
    padding: 0.5rem;
    border: 1px solid var(--error);
    border-radius: var(--border-radius, 0.25rem);
  }
</style>
