/**
 * Spreadsheet-style category editing for a single account's journal.
 *
 * Design constraint that shapes everything here: cursor movement must
 * never wait on a save. Committing a cell (Enter/Tab/ArrowDown, fill-down,
 * paste) only ever updates the in-memory `pending` map and the row's own
 * displayed text - synchronously, no network call in that path at all.
 * Persistence happens separately, out of band (see `schedule_flush`/
 * `flush_all`), so rapid re-entry down a sorted run of rows is never
 * gated by how fast the previous row's write finished.
 *
 * The journal itself is a server-rendered DocumentFragment (see
 * JournalTable.svelte / _journal_table.html), not individually reactive
 * Svelte rows, so this operates on the live DOM directly - the same
 * approach keyboard_navigation.ts already established on this branch.
 */
import { mount, unmount } from "svelte";
import { get } from "svelte/store";

import {
  get_source_slice,
  put_add_category_rule,
  put_source_slice,
} from "../../api/index.ts";
import { url_for_account } from "../../helpers.ts";
import { escape_for_regex } from "../../lib/regex.ts";
import { log_error } from "../../log.ts";
import { notify, notify_err } from "../../notifications.ts";
import { router } from "../../router.ts";
import { journal_show } from "../../stores/journal.ts";
import CategoryEditCell from "./CategoryEditCell.svelte";

const SELECTED_CLASS = "selected";
const FLUSH_DEBOUNCE_MS = 2000;

/** Whether edit mode is currently active - the exported toggle. */
export const category_edit_state = $state({ active: false, pending: 0 });

interface PendingEdit {
  /** The account text as it was before this edit (for the exact-line
   * replace in the source slice - captured at commit time, not
   * re-derived later from what may already be an optimistically-updated
   * DOM). */
  old_account: string;
  new_account: string;
  li: HTMLLIElement;
  payee: string;
}

/** entry_hash -> the latest not-yet-flushed edit for that entry. A second
 * edit to the same row before a flush simply overwrites the first - only
 * the final value matters. */
const pending = new Map<string, PendingEdit>();

let flush_timer: ReturnType<typeof setTimeout> | undefined;

function account_from_link(
  a: HTMLAnchorElement | null | undefined,
): string | null {
  const m = /\/account\/([^/]+)\/?(?:[?#]|$)/.exec(
    a?.getAttribute("href") ?? "",
  );
  return m?.[1] != null ? decodeURIComponent(m[1]) : null;
}

function entry_hash_of(li: HTMLLIElement): string | null {
  const href = li
    .querySelector(":scope > p > .datecell a")
    ?.getAttribute("href");
  return href?.startsWith("#context-") ? href.slice(9) : null;
}

export interface EditableRow {
  li: HTMLLIElement;
  entry_hash: string;
  /** The posting <span class="description"> holding the counter account's
   * link - what gets replaced by the mounted editor. */
  counter_cell: HTMLElement;
  counter_account: string;
  payee: string;
}

/**
 * A row is only editable here if it's a plain two-posting transaction
 * where one posting is (an account under) `this_account` - anything else
 * (splits, or a posting on neither this account nor a clear counter
 * account) is left alone: read-only in this view, with the full slice
 * editor (a click on the date, same as always) as the escape hatch.
 */
export function find_editable_row(
  li: HTMLLIElement,
  this_account: string,
): EditableRow | null {
  if (!li.classList.contains("transaction")) {
    return null;
  }
  const postings = li.querySelectorAll<HTMLLIElement>(
    ":scope > ul.postings > li",
  );
  if (postings.length !== 2) {
    return null;
  }
  const cells = [...postings].map((p) =>
    p.querySelector<HTMLElement>(":scope > p > .description"),
  );
  if (cells[0] == null || cells[1] == null) {
    return null;
  }
  const links = cells.map((c) => c?.querySelector("a"));
  if (links[0] == null || links[1] == null) {
    return null;
  }
  const accounts = links.map(account_from_link);
  if (accounts[0] == null || accounts[1] == null) {
    return null;
  }
  const is_this = (a: string) =>
    a === this_account || a.startsWith(`${this_account}:`);
  const this_idx = accounts.findIndex((a) => a != null && is_this(a));
  if (this_idx === -1) {
    return null;
  }
  const counter_idx = this_idx === 0 ? 1 : 0;
  const entry_hash = entry_hash_of(li);
  if (entry_hash == null) {
    return null;
  }
  const payee =
    li.querySelector(":scope > p > .description > .payee")?.textContent ??
    "";
  return {
    li,
    entry_hash,
    counter_cell: cells[counter_idx]!,
    counter_account: accounts[counter_idx]!,
    payee,
  };
}

function visible_rows(ol: HTMLOListElement): HTMLLIElement[] {
  return [...ol.querySelectorAll<HTMLLIElement>(":scope > li")].filter(
    (li) => li.getClientRects().length > 0,
  );
}

function selected_row(ol: HTMLOListElement): HTMLLIElement | null {
  return ol.querySelector<HTMLLIElement>(`:scope > li.${SELECTED_CLASS}`);
}

/** Replace the exact posting-account line in a source slice. Anchored to
 * line start plus trailing whitespace so it can only ever match the
 * account's own posting line, never a substring inside a longer sibling
 * account name or inside unrelated metadata. */
function replace_posting_account(
  slice: string,
  old_account: string,
  new_account: string,
): string | null {
  const re = new RegExp(
    `^(\\s*)${escape_for_regex(old_account)}(?=\\s)`,
    "m",
  );
  if (!re.test(slice)) {
    return null;
  }
  return slice.replace(re, `$1${new_account}`);
}

async function flush_one(entry_hash: string, edit: PendingEdit): Promise<void> {
  const { slice, sha256sum } = await get_source_slice({ entry_hash });
  const new_slice = replace_posting_account(
    slice,
    edit.old_account,
    edit.new_account,
  );
  if (new_slice == null) {
    throw new Error(
      `Could not find posting line for ${edit.old_account} - it may have already changed (e.g. edited elsewhere in the meantime).`,
    );
  }
  await put_source_slice({ entry_hash, source: new_slice, sha256sum });
  offer_rule_learning(edit.payee, edit.new_account);
}

/** Flush every pending edit now, concurrently (each targets a different
 * entry_hash with its own independent optimistic-concurrency check, so
 * there's no ordering dependency between them). Safe to call with nothing
 * pending. */
export async function flush_all(): Promise<void> {
  if (pending.size === 0) {
    return;
  }
  if (flush_timer != null) {
    clearTimeout(flush_timer);
    flush_timer = undefined;
  }
  const entries = [...pending.entries()];
  pending.clear();
  category_edit_state.pending = 0;
  await Promise.all(
    entries.map(async ([entry_hash, edit]) => {
      try {
        await flush_one(entry_hash, edit);
      } catch (error: unknown) {
        notify_err(
          error,
          (err) => `Saving category for '${edit.payee}' failed: ${err.message}`,
        );
        // Put it back so it isn't silently lost - the debounce/explicit
        // flush/navigate-away paths will retry it.
        pending.set(entry_hash, edit);
        category_edit_state.pending = pending.size;
      }
    }),
  );
}

function schedule_flush(): void {
  if (flush_timer != null) {
    clearTimeout(flush_timer);
  }
  flush_timer = setTimeout(() => {
    flush_all().catch(log_error);
  }, FLUSH_DEBOUNCE_MS);
}

/** Update a row's displayed text and queue its persistence - the ONLY
 * thing on the synchronous commit path (see module doc comment). */
export function commit_edit(row: EditableRow, new_account: string): void {
  if (new_account === row.counter_account) {
    return;
  }
  const existing = pending.get(row.entry_hash);
  pending.set(row.entry_hash, {
    old_account: existing?.old_account ?? row.counter_account,
    new_account,
    li: row.li,
    payee: row.payee,
  });
  category_edit_state.pending = pending.size;
  render_cell_text(row.counter_cell, new_account);
  row.counter_account = new_account;
  schedule_flush();
}

/** Renders the same shape of link the server-rendered journal uses for a
 * posting's account (a real `/account/<name>/` URL) - `find_editable_row`
 * (via `account_from_link`) parses that URL back out to identify a row's
 * accounts on every subsequent pass, so a placeholder href here would make
 * a once-edited row unrecognizable to fill-down, re-opening its editor,
 * and so on. */
function render_cell_text(cell: HTMLElement, account: string): void {
  cell.textContent = "";
  const a = document.createElement("a");
  a.textContent = account;
  a.href = get(url_for_account)(account);
  cell.append(a);
}

const already_offered = new Set<string>();

function offer_rule_learning(payee: string, account: string): void {
  const key = `${payee} ${account}`;
  if (!payee || already_offered.has(key)) {
    return;
  }
  already_offered.add(key);
  notify(
    `Click to also categorize future '${payee}' transactions as ${account}.`,
    "info",
    () => {
      put_add_category_rule({ value: payee, account })
        .then((msg) => {
          notify(msg, "info");
        })
        .catch((error: unknown) => {
          notify_err(error, (err) => `Adding rule failed: ${err.message}`);
        });
    },
    15000,
  );
}

let active_editor: { row: EditableRow; unmount: () => void } | null = null;

/** Bumped by the first move_to call that actually acts on a given editor -
 * see the comment on `my_generation` in open_editor for why this exists. */
let move_generation = 0;

/** Unmounting a still-focused input triggers a synchronous native blur,
 * which AutocompleteInput turns into its own `onchange` call - so closing
 * editor A while committing into editor B (the normal Enter/Tab/ArrowDown
 * path, which opens B before A has finished tearing down) can otherwise
 * fire A's `oncommit` a second time, stale, causing an extra phantom
 * `move_to` and blanking whatever row A's stale commit skips onto. Clearing
 * `active_editor` before unmounting (so `open_editor`'s `is_current` check
 * on the stale closure sees it's no longer current) and always restoring
 * the cell's rendered text after unmount (not just on a real commit) closes
 * both holes. */
function close_active_editor(): void {
  const editor = active_editor;
  if (editor == null) {
    return;
  }
  active_editor = null;
  editor.unmount();
  render_cell_text(editor.row.counter_cell, editor.row.counter_account);
}

function open_editor(ol: HTMLOListElement, this_account: string): void {
  close_active_editor();
  const li = selected_row(ol);
  if (li == null) {
    return;
  }
  const row = find_editable_row(li, this_account);
  if (row == null) {
    return;
  }
  const container = document.createElement("span");
  row.counter_cell.textContent = "";
  row.counter_cell.append(container);
  // Ties this editor's move_to to the generation current when IT opened:
  // is_current() alone only guards a STALE editor's callbacks (one that's
  // no longer active_editor), but AutocompleteInput can call oncommit
  // twice for the SAME still-current editor - e.g. Enter's own handling
  // plus a blur it triggers indirectly - and both calls see is_current()
  // true. Bumping the generation on the first real move and refusing any
  // move_to call that doesn't match the generation it captured makes a
  // second, duplicate call to THIS editor's own oncommit/onarrowdown a
  // no-op too, regardless of why it fired twice.
  const my_generation = move_generation;
  const move_to = (direction: 1 | -1) => {
    if (move_generation !== my_generation) {
      return;
    }
    move_generation++;
    close_active_editor();
    move_selection(ol, direction);
    // Deferred a tick (matching the ArrowDown path below): mounting and
    // focusing the next row's input in the same synchronous stack as the
    // previous one's teardown is flaky in Chrome - the fresh input can
    // pick up a spurious blur right after gaining focus, which
    // AutocompleteInput turns into its own onchange/commit and would
    // otherwise cascade into skipping an extra row.
    queueMicrotask(() => {
      open_editor(ol, this_account);
    });
  };
  const is_current = () => active_editor?.row === row;
  const instance = mount(CategoryEditCell, {
    target: container,
    props: {
      initial_value: row.counter_account,
      oncommit: (value: string) => {
        if (!is_current()) {
          return;
        }
        commit_edit(row, value);
        move_to(1);
      },
      onarrowdown: (value: string) => {
        if (!is_current()) {
          return;
        }
        commit_edit(row, value);
        move_to(1);
      },
    },
  });
  active_editor = { row, unmount: () => unmount(instance) };
}

function move_selection(ol: HTMLOListElement, direction: 1 | -1): void {
  const rows = visible_rows(ol);
  if (rows.length === 0) {
    return;
  }
  const current_index = rows.findIndex((li) =>
    li.classList.contains(SELECTED_CLASS),
  );
  const next_index =
    current_index === -1
      ? 0
      : Math.min(Math.max(current_index + direction, 0), rows.length - 1);
  rows[current_index]?.classList.remove(SELECTED_CLASS);
  const next = rows[next_index];
  if (!next) {
    return;
  }
  next.classList.add(SELECTED_CLASS);
  next.scrollIntoView({ block: "nearest" });
}

/** Ctrl/Cmd+D: repeat the counter-account from the row immediately above
 * the current selection into the current row - the primary rapid-
 * correction tool for a run of sorted, similar transactions. Works whether
 * or not a cell is currently open on the target row (in the normal flow,
 * one always is - each row-advancing action reopens the next row's editor
 * immediately, so gating this on "no cell open" would make it effectively
 * unreachable). Also advances to the next row afterward, same as a commit,
 * so repeated Ctrl+D fills a whole run of rows without any other keys. */
function fill_down(ol: HTMLOListElement, this_account: string): void {
  const rows = visible_rows(ol);
  const current_index = rows.findIndex((li) =>
    li.classList.contains(SELECTED_CLASS),
  );
  if (current_index <= 0) {
    return;
  }
  const above = find_editable_row(rows[current_index - 1]!, this_account);
  const current_li = rows[current_index]!;
  if (above == null) {
    return;
  }
  // If the current row's editor is open, it owns current_li's cell's DOM
  // right now - close it first so commit_edit's render doesn't yank the
  // DOM out from under the still-mounted Svelte component.
  if (active_editor?.row.li === current_li) {
    close_active_editor();
  }
  const current = find_editable_row(current_li, this_account);
  if (current == null) {
    return;
  }
  commit_edit(current, above.counter_account);
  move_selection(ol, 1);
  queueMicrotask(() => {
    open_editor(ol, this_account);
  });
}

/** Guards against more than one live `keydown` listener at a time. The
 * owning `$effect` in JournalTable.svelte can rerun (e.g. while the journal
 * fragment itself is still settling right after a route load) without its
 * previous cleanup having run first, which would otherwise leave two
 * listeners attached - each independently reacting to the same keypress,
 * so a single Enter/ArrowDown silently advances two rows instead of one. */
let current_teardown: (() => void) | null = null;

export function init_category_edit_mode(
  ol: HTMLOListElement,
  this_account: string,
): () => void {
  current_teardown?.();
  function keydown(event: KeyboardEvent): void {
    if (!category_edit_state.active) {
      return;
    }
    // Fill-down and explicit-flush are meaningful (and need to work)
    // whether or not a cell is currently open - AutocompleteInput doesn't
    // intercept either combo itself, so both reach here regardless.
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === "d" || event.key === "D")) {
      event.preventDefault();
      fill_down(ol, this_account);
      return;
    }
    if (event.shiftKey && event.key === "Enter") {
      event.preventDefault();
      flush_all().catch(log_error);
      return;
    }
    // Below this point: CategoryEditCell owns Enter/Tab/Escape itself
    // (via its own callbacks) while a cell editor is open - only handle
    // the keys that make sense with NO cell open (opening a cell).
    if (active_editor != null) {
      return;
    }
    if (event.key === "ArrowDown") {
      // Let the base keyboard_navigation.ts move the selection first,
      // then (re)open the editor on the newly selected row.
      queueMicrotask(() => {
        open_editor(ol, this_account);
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      open_editor(ol, this_account);
    }
  }
  document.addEventListener("keydown", keydown);

  const remove_interrupt = router.add_interrupt_handler(() => {
    flush_all().catch(log_error);
    return null;
  });

  function on_beforeunload(): void {
    // Best-effort: fire the requests, don't wait (the page may already be
    // gone before they land - this is a safety net, not a guarantee).
    flush_all().catch(log_error);
  }
  window.addEventListener("beforeunload", on_beforeunload);

  const teardown = () => {
    document.removeEventListener("keydown", keydown);
    window.removeEventListener("beforeunload", on_beforeunload);
    remove_interrupt();
    close_active_editor();
    flush_all().catch(log_error);
    if (current_teardown === teardown) {
      current_teardown = null;
    }
  };
  current_teardown = teardown;
  return teardown;
}

/** Toggle edit mode - also forces postings visible (the counter-account
 * to edit is only shown there), reusing the existing Postings toggle
 * mechanism (see JournalFilters.svelte / stores/journal.ts) rather than
 * adding a second one. */
export function toggle_category_edit_mode(): void {
  category_edit_state.active = !category_edit_state.active;
  if (category_edit_state.active) {
    journal_show.update((show) =>
      show.includes("postings") ? show : [...show, "postings"].sort(),
    );
  } else {
    close_active_editor();
    flush_all().catch(log_error);
  }
}
