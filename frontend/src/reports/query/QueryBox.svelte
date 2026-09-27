<!--
  @component
  Renders a query result in a collapsible box.
-->
<script lang="ts">
  import Chart from "../../charts/Chart.svelte";
  import { chart_context } from "../../charts/context.ts";
  import { get_query_chart } from "../../charts/query-charts.ts";
  import type { CodemirrorBql } from "../../codemirror/types.ts";
  import { download_text } from "../../lib/dom.ts";
  import { _ } from "../../i18n.ts";
  import type { Result } from "../../lib/result.ts";
  import type { QueryError } from "./errors.ts";
  import { PIVOT_AGGREGATIONS, pivot_table, pivot_to_csv, table_is_pivotable } from "./pivot.ts";
  import type { PivotAggregation } from "./pivot.ts";
  import PivotTable from "./PivotTable.svelte";
  import QueryLinks from "./QueryLinks.svelte";
  import QueryTable from "./QueryTable.svelte";
  import type { QueryResult } from "./query_table.ts";
  import ReadonlyQueryEditor from "./ReadonlyQueryEditor.svelte";

  interface Props {
    /** The query string. */
    query: string;
    /** The query result, possibly missing or an error. */
    result?: Result<QueryResult, QueryError> | undefined;
    /** Whether this box is open. */
    open?: boolean | undefined;
    /** Handler to run on 'select' (clicking the summary bar). */
    onselect: () => void;
    /** Handler to run on 'delete' (clicking the x button). */
    ondelete: () => void;
    codemirror_bql: CodemirrorBql;
  }

  let {
    query,
    result,
    open = $bindable(),
    onselect,
    ondelete,
    codemirror_bql,
  }: Props = $props();

  let inactive = $derived(!result);

  /** The table result, if the query succeeded and returned a table. */
  let table = $derived(
    result != null && result.is_ok && result.value.t === "table"
      ? result.value
      : undefined,
  );

  /** Pivot control state - all unset (empty string) by default, meaning
   * "render flat, exactly as before this feature existed". */
  let pivot_row_col = $state("");
  let pivot_col_col = $state("");
  let pivot_value_col = $state("");
  let pivot_agg = $state<PivotAggregation>("sum");

  let is_pivotable = $derived(table != null && table_is_pivotable(table));
  let pivot_active = $derived(
    pivot_row_col !== "" && pivot_col_col !== "" && pivot_value_col !== "",
  );
  let pivot_result = $derived(
    table != null && pivot_active
      ? pivot_table(
          table,
          pivot_row_col,
          pivot_col_col,
          pivot_value_col,
          pivot_agg,
        )
      : null,
  );

  function download_pivot_csv() {
    if (pivot_result) {
      download_text("pivot_result.csv", pivot_to_csv(pivot_result));
    }
  }
</script>

<details bind:open>
  <summary class:inactive onclick={inactive ? onselect : null}>
    <ReadonlyQueryEditor
      value={query}
      error={result?.is_err === true}
      error_range={result?.is_err === true ? result.error.range : undefined}
      {codemirror_bql}
    />
    <span class="spacer"></span>
    {#if table}
      <QueryLinks {query} />
    {/if}
    <button
      type="button"
      onclick={(ev) => {
        ev.stopPropagation();
        ondelete();
      }}
    >
      x
    </button>
  </summary>
  <div>
    {#if result}
      {#if result.is_ok}
        {#if result.value.t === "string"}
          <pre><code>{result.value.contents}</code></pre>
        {:else if table}
          {#if is_pivotable}
            <div class="pivot-controls">
              <label>
                {_("Rows")}
                <select bind:value={pivot_row_col}>
                  <option value="">—</option>
                  {#each table.columns as column (column.name)}
                    <option value={column.name}>{column.name}</option>
                  {/each}
                </select>
              </label>
              <label>
                {_("Columns")}
                <select bind:value={pivot_col_col}>
                  <option value="">—</option>
                  {#each table.columns as column (column.name)}
                    <option value={column.name}>{column.name}</option>
                  {/each}
                </select>
              </label>
              <label>
                {_("Values")}
                <select bind:value={pivot_value_col}>
                  <option value="">—</option>
                  {#each table.columns as column (column.name)}
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
                <button type="button" onclick={download_pivot_csv}>
                  {_("Download pivot as CSV")}
                </button>
              {/if}
            </div>
          {/if}
          {#if pivot_result}
            <PivotTable pivot={pivot_result} />
          {:else}
            {@const chart = get_query_chart(result.value, $chart_context)}
            {#if chart}
              <Chart {chart} />
            {/if}
            <QueryTable table={result.value} />
          {/if}
        {/if}
      {:else}
        <!-- eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- the Result discriminated union (via is_ok/is_err) narrows correctly for the real Svelte/TS compiler (svelte-check reports no error here), just not for this eslint parser -->
        {@const query_error = result.error}
        <p class="query-error">{query_error.message}</p>
        <!-- eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -->
      {/if}
    {/if}
  </div>
</details>

<style>
  details > div {
    max-height: 70vh;
    overflow: auto;
  }

  .inactive {
    filter: opacity(0.5);
  }

  pre {
    margin: 0;
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
