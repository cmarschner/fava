<!--
  @component
  Renders a single query result cell value, formatted the same way
  regardless of whether it appears in the flat QueryTable or a pivoted
  PivotTable - the branches here are the single source of truth for how
  a query cell of a given runtime type gets displayed.
-->
<script lang="ts">
  import { Amount, Position } from "../../entries/index.ts";
  import { day } from "../../format.ts";
  import { url_for_account } from "../../helpers.ts";
  import AccountIndicator from "../../sidebar/AccountIndicator.svelte";
  import { ctx, num } from "../../stores/format.ts";
  import { accounts_set, currency_name } from "../../stores/index.ts";
  import type { QueryCell } from "./query_table.ts";
  import { Inventory } from "./query_table.ts";

  interface Props {
    /** The cell value to render. */
    value: QueryCell;
    /** Whether the value is known to be an "int" column (no thousands formatting). */
    is_int?: boolean;
  }

  let { value, is_int = false }: Props = $props();
</script>

{#if value == null}
  &nbsp;
{:else if typeof value === "boolean"}
  {value.toString().toUpperCase()}
{:else if typeof value === "number"}
  {is_int ? value.toString() : $num(value)}
{:else if typeof value === "string"}
  {#if $accounts_set.has(value)}
    <a href={$url_for_account(value)}>{value}</a>
    <AccountIndicator account={value} small />
  {:else if value.length === 32 && /[a-z0-9]/.test(value)}
    <a href={`#context-${value}`}>{value}</a>
  {:else}
    {value}
  {/if}
{:else if Array.isArray(value)}
  {value.join(",")}
{:else if value instanceof Date}
  {day(value)}
{:else if value instanceof Amount}
  <span title={$currency_name(value.currency)}>
    {value.str($ctx)}
  </span>
{:else if value instanceof Position}
  <span title={$currency_name(value.units.currency)}>
    {value.units.str($ctx)}
  </span>
  {#if value.cost}
    &lbrace;<span title={$currency_name(value.cost.currency)}>
      {value.cost.str($ctx)}
    </span>&rbrace;{/if}
{:else if value instanceof Inventory}
  {#each Object.entries(value.value) as [currency, number] (currency)}
    <span title={$currency_name(currency)}
      >{$ctx.amount(number, currency)}</span
    >
    <br />
  {/each}
{/if}
