import { sum } from "d3-array";

import { Amount } from "../../entries/index.ts";
import { is_descendant_or_equal } from "../../lib/account.ts";
import { Position } from "../../entries/position.ts";
import { Inventory, type QueryCell, type QueryResultTable } from "./query_table.ts";

/** The aggregations a pivoted value column can be reduced with. */
export const PIVOT_AGGREGATIONS = ["sum", "count", "avg"] as const;
export type PivotAggregation = (typeof PIVOT_AGGREGATIONS)[number];

/**
 * The composite key for one pivoted (row, column) cell - used both to
 * build `PivotResult.cells` and to look values back up from it (see
 * PivotTable.svelte and pivot_to_csv below), so both sides always agree
 * on the exact key for a given pair. Uses JSON encoding rather than a
 * bare delimited string so there's no ambiguity from a row/column key
 * that happens to contain whatever separator character would otherwise
 * be chosen.
 */
export function pivot_cell_key(row_key: string, col_key: string): string {
  return JSON.stringify([row_key, col_key]);
}

/**
 * A stable string key for a cell value, used to group rows into pivot
 * rows/columns. Dates are rendered as their ISO date string so that
 * grouping by a raw date column (rather than a BQL-computed YEAR(date)/
 * MONTH(date) column) still produces one column per distinct day rather
 * than per Date object identity.
 */
function cell_key(value: QueryCell): string {
  if (value == null) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (Array.isArray(value)) {
    return value.join(",");
  }
  if (value instanceof Amount) {
    return value.number.toString();
  }
  if (value instanceof Position) {
    return value.units.number.toString();
  }
  if (value instanceof Inventory) {
    return sum(Object.values(value.value)).toString();
  }
  return String(value);
}

/**
 * The numeric contribution of a cell value to a pivoted aggregation.
 * Returns null for values that can't sensibly be summed (e.g. booleans,
 * free-text strings) - those rows are skipped for aggregation purposes
 * rather than silently treated as 0, so a wrong column choice is visible
 * as missing data rather than a plausible-looking wrong total.
 */
function cell_number(value: QueryCell): number | null {
  if (typeof value === "number") {
    return value;
  }
  if (value instanceof Amount) {
    return value.number;
  }
  if (value instanceof Position) {
    return value.units.number;
  }
  if (value instanceof Inventory) {
    return sum(Object.values(value.value));
  }
  return null;
}

/** One aggregated pivot cell - keeps count alongside the sum so 'avg' is cheap. */
interface Cell {
  cell_sum: number;
  count: number;
}

function empty_cell(): Cell {
  return { cell_sum: 0, count: 0 };
}

function reduce_cell(cell: Cell, agg: PivotAggregation): number {
  switch (agg) {
    case "sum":
      return cell.cell_sum;
    case "count":
      return cell.count;
    case "avg":
      return cell.count === 0 ? 0 : cell.cell_sum / cell.count;
    default: {
      const exhaustive_check: never = agg;
      return exhaustive_check;
    }
  }
}

/** The result of pivoting a query result table into rows x columns. */
export interface PivotResult {
  /** Sorted, distinct row-dimension keys (sorted for stable rendering). */
  readonly row_keys: readonly string[];
  /** Sorted, distinct column-dimension keys. */
  readonly col_keys: readonly string[];
  /** Aggregated value, keyed by `pivot_cell_key(row_key, col_key)`. Missing entries mean no data for that cell. */
  readonly cells: ReadonlyMap<string, number>;
  /** Row totals, across all columns. */
  readonly row_totals: ReadonlyMap<string, number>;
  /** Column totals, across all rows. */
  readonly col_totals: ReadonlyMap<string, number>;
  readonly grand_total: number;
  /** Name of the value column, for a header/label. */
  readonly value_col: string;
}

/**
 * Pivot a flat query result table into a rows x columns cross-tabulation.
 *
 * `row_col`/`col_col`/`value_col` are column names from `table.columns`.
 * Rows of `table` are grouped by `(row_col value, col_col value)` and the
 * `value_col` values in each group are aggregated with `agg`. Returns
 * `null` if any of the 3 column names don't exist on `table` - the
 * caller is expected to only call this once a valid selection has been
 * made (an unset selection means "don't pivot" and should never reach
 * this function at all).
 */
export function pivot_table(
  table: QueryResultTable,
  row_col: string,
  col_col: string,
  value_col: string,
  agg: PivotAggregation,
): PivotResult | null {
  const row_index = table.columns.findIndex((c) => c.name === row_col);
  const col_index = table.columns.findIndex((c) => c.name === col_col);
  const value_index = table.columns.findIndex((c) => c.name === value_col);
  if (row_index === -1 || col_index === -1 || value_index === -1) {
    return null;
  }

  const cells = new Map<string, Cell>();
  const row_keys = new Set<string>();
  const col_keys = new Set<string>();

  for (const row of table.rows) {
    const row_key = cell_key(row[row_index] ?? null);
    const col_key = cell_key(row[col_index] ?? null);
    const value = cell_number(row[value_index] ?? null);
    row_keys.add(row_key);
    col_keys.add(col_key);
    if (value == null) {
      continue;
    }
    const key = pivot_cell_key(row_key, col_key);
    const existing = cells.get(key) ?? empty_cell();
    existing.cell_sum += value;
    existing.count += 1;
    cells.set(key, existing);
  }

  const sorted_row_keys = [...row_keys].sort();
  const sorted_col_keys = [...col_keys].sort();

  const reduced_cells = new Map<string, number>();
  const row_totals = new Map<string, Cell>();
  const col_totals = new Map<string, Cell>();
  const grand_total = empty_cell();

  for (const row_key of sorted_row_keys) {
    for (const col_key of sorted_col_keys) {
      const key = pivot_cell_key(row_key, col_key);
      const cell = cells.get(key);
      if (!cell) {
        continue;
      }
      reduced_cells.set(key, reduce_cell(cell, agg));

      const row_total = row_totals.get(row_key) ?? empty_cell();
      row_total.cell_sum += cell.cell_sum;
      row_total.count += cell.count;
      row_totals.set(row_key, row_total);

      const col_total = col_totals.get(col_key) ?? empty_cell();
      col_total.cell_sum += cell.cell_sum;
      col_total.count += cell.count;
      col_totals.set(col_key, col_total);

      grand_total.cell_sum += cell.cell_sum;
      grand_total.count += cell.count;
    }
  }

  return {
    row_keys: sorted_row_keys,
    col_keys: sorted_col_keys,
    cells: reduced_cells,
    row_totals: new Map(
      [...row_totals].map(([k, v]) => [k, reduce_cell(v, agg)]),
    ),
    col_totals: new Map(
      [...col_totals].map(([k, v]) => [k, reduce_cell(v, agg)]),
    ),
    grand_total: reduce_cell(grand_total, agg),
    value_col,
  };
}

/** Quote a CSV field per RFC 4180 (only if it needs it). */
function csv_field(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialise a pivoted result to CSV, for the client-side export - the
 * pivot only exists in the frontend, so the server-side
 * `download-query/query_result.csv` route can't reflect it.
 */
export function pivot_to_csv(pivot: PivotResult): string {
  const header = ["", ...pivot.col_keys, "Total"].map(csv_field).join(",");
  const lines = pivot.row_keys.map((row_key) => {
    const cells = pivot.col_keys.map((col_key) =>
      String(pivot.cells.get(pivot_cell_key(row_key, col_key)) ?? ""),
    );
    return [row_key, ...cells, String(pivot.row_totals.get(row_key) ?? "")]
      .map(csv_field)
      .join(",");
  });
  const total_line = [
    "Total",
    ...pivot.col_keys.map((col_key) =>
      String(pivot.col_totals.get(col_key) ?? ""),
    ),
    String(pivot.grand_total),
  ]
    .map(csv_field)
    .join(",");
  return [header, ...lines, total_line].join("\r\n");
}

/**
 * The name of the "account" column in a query result table, if it has
 * one - used both to offer the account-exclusion control (Phase 2a) and
 * to detect journal-shaped results for the cash-flow pool (Phase 2b).
 * Matches on column name (not just dtype "str"/"object") since a query
 * can have several string columns (e.g. `narration`) - only a column
 * actually named "account" is safe to treat as real account data.
 */
export function account_column_name(table: QueryResultTable): string | null {
  const has_account = table.columns.some((c) => c.name === "account");
  return has_account ? "account" : null;
}

/**
 * Filter out every row whose account column value is equal to, or a
 * descendant of, one of the excluded accounts (Phase 2a). Excluding a
 * parent account (e.g. "Income:Gehalt") excludes its whole subtree
 * (e.g. "Income:Gehalt:RSU" too) - matches how the rest of Fava treats
 * an account name as a real hierarchy prefix, not just one literal
 * string. Returns `table` unchanged (same object) if there's no account
 * column or nothing is excluded, so this is a safe no-op when the
 * control is unused.
 */
export function filter_table_excluding_accounts(
  table: QueryResultTable,
  excluded: ReadonlySet<string>,
): QueryResultTable {
  if (excluded.size === 0) {
    return table;
  }
  const account_col = account_column_name(table);
  if (account_col == null) {
    return table;
  }
  const account_index = table.columns.findIndex(
    (c) => c.name === account_col,
  );
  const predicates = [...excluded].map(is_descendant_or_equal);
  const rows = table.rows.filter((row) => {
    const value = row[account_index];
    return !(
      typeof value === "string" && predicates.some((p) => p(value))
    );
  });
  return rows.length === table.rows.length
    ? table
    : { ...table, rows };
}

/**
 * Whether a query result table's shape makes pivoting sensible at all -
 * used to decide whether to show the pivot control. Requires at least
 * one string-ish column (a row dimension), one date-ish-or-low-
 * cardinality column (a column dimension - a string/date/int column
 * distinct from the row one), and one numeric-ish column (a value).
 * Doesn't inspect actual cardinality of the data, only column dtypes -
 * cheap and avoids the control silently vanishing on a wide GROUP BY
 * result just because one particular run happened to have low variety.
 */
export function table_is_pivotable(table: QueryResultTable): boolean {
  const dimension_dtypes = new Set(["str", "object", "date", "int", "bool"]);
  const value_dtypes = new Set(["int", "Decimal", "Amount", "Inventory", "Position"]);
  const dimension_cols = table.columns.filter((c) =>
    dimension_dtypes.has(c.dtype),
  );
  const value_cols = table.columns.filter((c) => value_dtypes.has(c.dtype));
  return dimension_cols.length >= 2 && value_cols.length >= 1;
}
