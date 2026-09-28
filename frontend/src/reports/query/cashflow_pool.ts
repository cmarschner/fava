import { is_descendant_or_equal } from "../../lib/account.ts";
import { get_query_column } from "./query_table.ts";
import type { QueryCell, QueryResultTable } from "./query_table.ts";

/**
 * Find a column by exact name, or (for payee/narration) by the shape
 * BQL's `journal` built-in actually returns them in - confirmed live
 * against the real backend: `journal` names these columns literally
 * `MAXWIDTH(payee, 48)` / `MAXWIDTH(narration, 80)`, not `payee` /
 * `narration`. Matching both that shape and a plain `SELECT date,
 * payee, narration, account, position ...` lets a user's own
 * hand-written entry-level query work here too, not just the bare
 * `journal` statement.
 */
function find_column(
  table: QueryResultTable,
  matches: (name: string) => boolean,
): number {
  return table.columns.findIndex((c) => matches(c.name));
}

/**
 * Whether a query result table has the columns needed to build a
 * cash-flow pool report from it: a date, an account, a position
 * (the per-posting amount), and something payee/narration-shaped to
 * key transaction grouping on. Used to decide whether to offer the
 * pool control at all for a given result - same "only show it when
 * the dimension is genuinely usable" discipline as the rest of this
 * plan.
 */
export function table_is_journal_shaped(table: QueryResultTable): boolean {
  const date_i = find_column(table, (n) => n === "date");
  const account_i = find_column(table, (n) => n === "account");
  const position_i = find_column(
    table,
    (n) => n === "position" || n === "amount",
  );
  const narration_i = find_column(
    table,
    (n) => n === "narration" || n.startsWith("MAXWIDTH(narration"),
  );
  return (
    date_i !== -1 &&
    table.columns[date_i]?.dtype === "date" &&
    account_i !== -1 &&
    table.columns[account_i]?.dtype === "str" &&
    position_i !== -1 &&
    narration_i !== -1
  );
}

/**
 * Build the "cash-flow pool" flows table (PLAN.md Phase 2b) from a
 * journal-shaped query result: for every real transaction that touches
 * at least one account in `pool`, if every posting is inside the pool
 * it's a pure internal reshuffle and is dropped entirely; otherwise
 * each posting whose account is *outside* the pool becomes its own
 * output row, keeping its own real account and amount unchanged (no
 * sign-flipping, no reclassification - the outside account's own
 * natural sign is already the right "cost is positive" convention this
 * ledger already uses for real Expenses/Liabilities postings).
 *
 * Transactions are identified by contiguous runs of rows sharing the
 * same (date, payee, narration) - confirmed live that `journal` always
 * emits a transaction's postings as a contiguous block. This is a
 * practical proxy, not a real transaction id (BQL/beanquery don't
 * expose one here) - two genuinely different transactions could in
 * principle collide on all three fields and be merged, a real known
 * limitation worth fixing once Phase 6 gives entry-shaped results a
 * proper backend representation.
 *
 * Returns `null` if `table` isn't journal-shaped, or if `pool` is
 * empty (nothing to compute).
 */
export function pool_flows_table(
  table: QueryResultTable,
  pool: ReadonlySet<string>,
): QueryResultTable | null {
  if (pool.size === 0 || !table_is_journal_shaped(table)) {
    return null;
  }
  const date_i = find_column(table, (n) => n === "date");
  const account_i = find_column(table, (n) => n === "account");
  const position_i = find_column(
    table,
    (n) => n === "position" || n === "amount",
  );
  const payee_i = find_column(
    table,
    (n) => n === "payee" || n.startsWith("MAXWIDTH(payee"),
  );
  const narration_i = find_column(
    table,
    (n) => n === "narration" || n.startsWith("MAXWIDTH(narration"),
  );

  const in_pool = [...pool].map(is_descendant_or_equal);
  const is_in_pool = (account: string) => in_pool.some((p) => p(account));

  const out_rows: QueryCell[][] = [];

  function flush(group: readonly QueryCell[][]) {
    if (group.length === 0) {
      return;
    }
    let has_inside = false;
    let has_outside = false;
    for (const row of group) {
      const account = row[account_i];
      if (typeof account !== "string") {
        continue;
      }
      if (is_in_pool(account)) {
        has_inside = true;
      } else {
        has_outside = true;
      }
    }
    // Not touching the pool at all, or a pure internal reshuffle
    // between pool accounts - neither is a real flow to report.
    if (!has_inside || !has_outside) {
      return;
    }
    for (const row of group) {
      const account = row[account_i];
      if (typeof account === "string" && !is_in_pool(account)) {
        out_rows.push([row[date_i] ?? null, account, row[position_i] ?? null]);
      }
    }
  }

  let current_key: string | null = null;
  let current_group: QueryCell[][] = [];
  for (const row of table.rows) {
    const date_val = row[date_i];
    const key = JSON.stringify([
      date_val instanceof Date ? date_val.toISOString() : date_val,
      payee_i !== -1 ? row[payee_i] : null,
      narration_i !== -1 ? row[narration_i] : null,
    ]);
    if (key !== current_key) {
      flush(current_group);
      current_group = [];
      current_key = key;
    }
    current_group.push(row);
  }
  flush(current_group);

  const amount_dtype = table.columns[position_i]?.dtype ?? "Position";
  return {
    t: "table",
    columns: [
      get_query_column({ name: "date", dtype: "date" }, 0),
      get_query_column({ name: "account", dtype: "str" }, 1),
      get_query_column({ name: "amount", dtype: amount_dtype }, 2),
    ],
    rows: out_rows,
  };
}
