<!--
  @component
  Renders a pivoted (rows x columns) query result, reusing the same
  cell-formatting as the flat QueryTable so numbers look identical.
-->
<script lang="ts">
  import { _ } from "../../i18n.ts";
  import QueryCellValue from "./QueryCellValue.svelte";
  import type { PivotResult } from "./pivot.ts";

  interface Props {
    pivot: PivotResult;
  }

  let { pivot }: Props = $props();
</script>

<table>
  <thead>
    <tr>
      <th></th>
      {#each pivot.col_keys as col_key (col_key)}
        <th class="num">{col_key || _("(empty)")}</th>
      {/each}
      <th class="num">{_("Total")}</th>
    </tr>
  </thead>
  <tbody>
    {#each pivot.row_keys as row_key (row_key)}
      <tr>
        <td>{row_key || _("(empty)")}</td>
        {#each pivot.col_keys as col_key (col_key)}
          {@const value = pivot.cells.get(`${row_key} ${col_key}`)}
          <td class="num">
            {#if value != null}
              <QueryCellValue value={value} />
            {/if}
          </td>
        {/each}
        <td class="num total">
          <QueryCellValue value={pivot.row_totals.get(row_key) ?? 0} />
        </td>
      </tr>
    {/each}
    <tr class="total">
      <td>{_("Total")}</td>
      {#each pivot.col_keys as col_key (col_key)}
        <td class="num">
          <QueryCellValue value={pivot.col_totals.get(col_key) ?? 0} />
        </td>
      {/each}
      <td class="num">
        <QueryCellValue value={pivot.grand_total} />
      </td>
    </tr>
  </tbody>
</table>

<style>
  .total {
    font-weight: bold;
  }
</style>
