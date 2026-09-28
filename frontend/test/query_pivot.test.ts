import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";

import { pool_flows_table, table_is_journal_shaped } from "../src/reports/query/cashflow_pool.ts";
import {
  filter_table_excluding_accounts,
  table_is_pivotable,
} from "../src/reports/query/pivot.ts";
import { get_query_column } from "../src/reports/query/query_table.ts";
import type { QueryResultTable } from "../src/reports/query/query_table.ts";

/** Build a minimal real `QueryResultTable` for a "SELECT account, sum(position)"-shaped result. */
function account_amount_table(
  rows: readonly [string, number][],
): QueryResultTable {
  return {
    t: "table",
    columns: [
      get_query_column({ name: "account", dtype: "str" }, 0),
      get_query_column({ name: "amount", dtype: "int" }, 1),
    ],
    rows: rows.map(([account, amount]) => [account, amount]),
  };
}

/** Build a minimal real journal-shaped `QueryResultTable`, one row per posting. */
function journal_table(
  rows: readonly [string, string, string, string, number][],
): QueryResultTable {
  return {
    t: "table",
    columns: [
      get_query_column({ name: "date", dtype: "date" }, 0),
      get_query_column({ name: "payee", dtype: "str" }, 1),
      get_query_column({ name: "narration", dtype: "str" }, 2),
      get_query_column({ name: "account", dtype: "str" }, 3),
      get_query_column({ name: "amount", dtype: "int" }, 4),
    ],
    rows: rows.map(([date, payee, narration, account, amount]) => [
      new Date(date),
      payee,
      narration,
      account,
      amount,
    ]),
  };
}

test("pivot: filter_table_excluding_accounts is a no-op when nothing is excluded", () => {
  const table = account_amount_table([["Income:Gehalt", -100]]);
  equal(filter_table_excluding_accounts(table, new Set()), table);
});

test("pivot: filter_table_excluding_accounts drops an excluded account and its subtree", () => {
  const table = account_amount_table([
    ["Income:Gehalt", -100],
    ["Income:Gehalt:RSU", -50],
    ["Income:Gehalt:Ehefrau", -20],
  ]);
  const filtered = filter_table_excluding_accounts(
    table,
    new Set(["Income:Gehalt:RSU"]),
  );
  deepEqual(
    filtered.rows.map((r) => r[0]),
    ["Income:Gehalt", "Income:Gehalt:Ehefrau"],
  );
  // Excluding the parent excludes the whole subtree too.
  const filtered_parent = filter_table_excluding_accounts(
    table,
    new Set(["Income:Gehalt"]),
  );
  equal(filtered_parent.rows.length, 0);
});

test("pivot: table_is_pivotable requires 2 dimension + 1 value column", () => {
  equal(table_is_pivotable(account_amount_table([["Income:Gehalt", -100]])), true);
});

test("cashflow_pool: table_is_journal_shaped", () => {
  equal(
    table_is_journal_shaped(
      journal_table([["2024-01-01", "P", "N", "Assets:Bank:Checking", 1]]),
    ),
    true,
  );
  equal(
    table_is_journal_shaped(account_amount_table([["Income:Gehalt", -100]])),
    false,
  );
});

test("cashflow_pool: pure internal reshuffle between pool accounts is excluded", () => {
  const table = journal_table([
    ["2024-01-01", "X", "Transfer", "Assets:Bank:Checking", -100],
    ["2024-01-01", "X", "Transfer", "Assets:Bank:Savings", 100],
  ]);
  const flows = pool_flows_table(
    table,
    new Set(["Assets:Bank:Checking", "Assets:Bank:Savings"]),
  );
  equal(flows?.rows.length, 0);
});

test("cashflow_pool: a transaction not touching the pool at all is irrelevant, not a flow", () => {
  const table = journal_table([
    ["2024-01-01", "X", "Dividend", "Assets:Depot:Lot", 10],
    ["2024-01-01", "X", "Dividend", "Income:Kapitalertraege", -10],
  ]);
  const flows = pool_flows_table(table, new Set(["Assets:Bank:Checking"]));
  equal(flows?.rows.length, 0);
});

test("cashflow_pool: Tilgung-shaped transaction - a mixed pool/non-pool transaction splits into one row per outside leg", () => {
  const table = journal_table([
    ["2024-05-31", "Bank", "Mortgage payment", "Assets:Bank:Checking", -1536.67],
    [
      "2024-05-31",
      "Bank",
      "Mortgage payment",
      "Expenses:Vermietung:Zinsen",
      1136.67,
    ],
    [
      "2024-05-31",
      "Bank",
      "Mortgage payment",
      "Liabilities:Kredite:Mortgage",
      400,
    ],
  ]);
  const flows = pool_flows_table(table, new Set(["Assets:Bank:Checking"]));
  deepEqual(
    flows?.rows.map((r) => [r[1], r[2]]),
    [
      ["Expenses:Vermietung:Zinsen", 1136.67],
      ["Liabilities:Kredite:Mortgage", 400],
    ],
  );
});

test("cashflow_pool: an account not in the pool, unrelated to any pool transaction, never shows up (e.g. RSU vesting)", () => {
  const table = journal_table([
    ["2024-02-20", "X", "Vest", "Assets:Depot:Lot", 100],
    ["2024-02-20", "X", "Vest", "Income:Gehalt:RSU", -100],
    ["2024-05-31", "Bank", "Mortgage payment", "Assets:Bank:Checking", -400],
    [
      "2024-05-31",
      "Bank",
      "Mortgage payment",
      "Liabilities:Kredite:Mortgage",
      400,
    ],
  ]);
  const flows = pool_flows_table(table, new Set(["Assets:Bank:Checking"]));
  equal(
    flows?.rows.some((r) => r[1] === "Income:Gehalt:RSU"),
    false,
  );
  equal(
    flows.rows.some((r) => r[1] === "Liabilities:Kredite:Mortgage"),
    true,
  );
});

test("cashflow_pool: an empty pool or a non-journal-shaped table returns null", () => {
  const table = journal_table([
    ["2024-01-01", "X", "N", "Assets:Bank:Checking", 1],
  ]);
  equal(pool_flows_table(table, new Set()), null);
  equal(
    pool_flows_table(
      account_amount_table([["Income:Gehalt", -100]]),
      new Set(["Assets:Bank:Checking"]),
    ),
    null,
  );
});
