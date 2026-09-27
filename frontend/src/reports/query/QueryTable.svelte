<!--
  @component
  A query result table.
-->
<script lang="ts">
  import { is_empty } from "../../lib/objects.ts";
  import { Sorter, UnsortedColumn } from "../../sort/index.ts";
  import SortHeader from "../../sort/SortHeader.svelte";
  import QueryCellValue from "./QueryCellValue.svelte";
  import type { QueryCell, QueryResultTable } from "./query_table.ts";
  import { Inventory, is_numeric_cell } from "./query_table.ts";

  interface Props {
    /** The table to render. */
    table: QueryResultTable;
    /** A column name to filter by if empty (expected to be an Inventory column).  */
    filter_empty?: string;
  }

  let { table, filter_empty }: Props = $props();

  let filter_empty_column_index = $derived(
    table.columns.findIndex((column) => column.name === filter_empty),
  );

  let filtered_rows = $derived(
    filter_empty_column_index > -1
      ? table.rows.filter((row) => {
          const cell = row[filter_empty_column_index];
          return !(cell instanceof Inventory && is_empty(cell.value));
        })
      : table.rows,
  );

  let sorter = $state.raw(
    new Sorter<QueryCell[]>(new UnsortedColumn("<Dummy>"), "asc"),
  );
  let sorted_rows = $derived(sorter.sort(filtered_rows));
</script>

<table>
  <thead>
    <tr>
      {#each table.columns as column (column.name)}
        <SortHeader bind:sorter {column} />
      {/each}
    </tr>
  </thead>
  <tbody>
    {#each sorted_rows as row (row)}
      <tr>
        {#each row as value, index (index)}
          <td class={is_numeric_cell(value) ? "num" : undefined}>
            <QueryCellValue
              {value}
              is_int={table.columns[index]?.dtype === "int"}
            />
          </td>
        {/each}
      </tr>
    {/each}
  </tbody>
</table>
