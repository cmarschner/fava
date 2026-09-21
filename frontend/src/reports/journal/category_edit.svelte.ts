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
  get_changed,
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
  posting_index: 0 | 1;
}

/** `${entry_hash}:${posting_index}` -> the latest not-yet-flushed edit for
 * that posting. A second edit to the same posting before a flush simply
 * overwrites the first - only the final value matters. Keyed by posting
 * index (not just entry_hash) since both postings of one transaction can
 * now be edited independently - two genuinely different pending writes to
 * the same entry, not one overwriting the other. */
const pending = new Map<string, PendingEdit>();

function pending_key(entry_hash: string, posting_index: 0 | 1): string {
  return `${entry_hash}:${String(posting_index)}`;
}

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

export interface EditablePosting {
  /** The posting <span class="description"> holding this posting's
   * account link - what gets replaced by the mounted editor. */
  cell: HTMLElement;
  account: string;
  /** DOM posting order (0 or 1) - a stable identity for this slot across
   * repeated edits, independent of its current account text. Used as part
   * of the pending-map key (see `pending_key`) and to look up "the same
   * role" posting on an adjacent row (see `fill_down`). */
  index: 0 | 1;
}

export interface EditableRow {
  li: HTMLLIElement;
  entry_hash: string;
  payee: string;
  /** Both postings, in DOM order - either is editable now (see the
   * module doc comment on why this account-browsing view needs BOTH,
   * not just the counter side the original bank-account-browsing design
   * assumed). */
  postings: [EditablePosting, EditablePosting];
  /** Index into `postings` of the leg matching `this_account`. The other
   * index is conventionally "the counter account" - kept as the DEFAULT
   * slot opened by row-level navigation (Enter/ArrowUp/ArrowDown), since
   * that's still the common case (browsing a bank account, categorizing
   * the counter side) and shouldn't get slower for it. Clicking directly
   * on a posting, or arrowing past the end/start of the open cell's
   * text, reaches the other one. */
  this_idx: 0 | 1;
}

function counter_idx_of(row: EditableRow): 0 | 1 {
  return row.this_idx === 0 ? 1 : 0;
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
  if (this_idx !== 0 && this_idx !== 1) {
    return null;
  }
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
    payee,
    postings: [
      { cell: cells[0]!, account: accounts[0]!, index: 0 },
      { cell: cells[1]!, account: accounts[1]!, index: 1 },
    ],
    this_idx,
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

/** Flush every pending edit belonging to one entry, sequentially - two
 * edits to the SAME entry_hash (its two postings, each independently
 * edited) can't safely go through put_source_slice concurrently: both
 * would read the same starting sha256sum, and whichever write lands
 * second would be rejected as a stale-concurrency conflict against a
 * sha256sum the first write already moved past. Chaining slice/sha256sum
 * through each edit in turn avoids that. Returns the keys that failed
 * (kept in `pending` by the caller so nothing is silently lost). */
async function flush_entry(
  entry_hash: string,
  edits: [string, PendingEdit][],
): Promise<string[]> {
  let { slice, sha256sum } = await get_source_slice({ entry_hash });
  const failed: string[] = [];
  for (const [key, edit] of edits) {
    const new_slice = replace_posting_account(
      slice,
      edit.old_account,
      edit.new_account,
    );
    if (new_slice == null) {
      notify_err(
        new Error(
          `Could not find posting line for ${edit.old_account} - it may have already changed (e.g. edited elsewhere in the meantime).`,
        ),
        (err) => `Saving category for '${edit.payee}' failed: ${err.message}`,
      );
      failed.push(key);
      continue;
    }
    try {
      sha256sum = await put_source_slice({
        entry_hash,
        source: new_slice,
        sha256sum,
      });
    } catch (error: unknown) {
      notify_err(
        error,
        (err) => `Saving category for '${edit.payee}' failed: ${err.message}`,
      );
      failed.push(key);
      continue;
    }
    slice = new_slice;
    offer_rule_learning(edit.payee, edit.new_account);
  }
  return failed;
}

/** Flush every pending edit now. Edits are grouped by entry_hash and each
 * group's writes are sequential (see flush_entry); different entries have
 * independent optimistic-concurrency checks and so still flush
 * concurrently with each other. Safe to call with nothing pending.
 *
 * A successful put_source_slice already notifies Fava's own watcher (see
 * FileModule.save_entry_slice), but that only marks the file as changed -
 * the server only actually re-parses on the *next* check, which for a
 * pure-API session (no full page navigation in between) is whatever the
 * 5s poll_for_changes timer happens to line up with. On a bind-mounted
 * ledger the inotify-based watcher thread backing that poll can also be
 * unreliable to begin with (a known Docker-Desktop bind-mount limitation,
 * not something fixable from here). Explicitly calling get_changed()
 * right after a successful write forces that reload immediately instead
 * of depending on either of those, so a save is guaranteed to be
 * reflected (in errors, other pages, other tabs) right away. */
export async function flush_all(): Promise<void> {
  if (pending.size === 0) {
    return;
  }
  if (flush_timer != null) {
    clearTimeout(flush_timer);
    flush_timer = undefined;
  }
  const by_entry = new Map<string, [string, PendingEdit][]>();
  for (const [key, edit] of pending) {
    const entry_hash = key.split(":")[0]!;
    const group = by_entry.get(entry_hash);
    if (group) {
      group.push([key, edit]);
    } else {
      by_entry.set(entry_hash, [[key, edit]]);
    }
  }
  const succeeded_keys = new Set(pending.keys());
  pending.clear();
  category_edit_state.pending = 0;
  await Promise.all(
    [...by_entry].map(async ([entry_hash, edits]) => {
      const failed = await flush_entry(entry_hash, edits);
      for (const key of failed) {
        succeeded_keys.delete(key);
      }
    }),
  );
  // Put failed edits back so they aren't silently lost - the debounce/
  // explicit flush/navigate-away paths will retry them.
  for (const [key, edit] of [...by_entry.values()].flat()) {
    if (!succeeded_keys.has(key)) {
      pending.set(key, edit);
    }
  }
  category_edit_state.pending = pending.size;
  if (succeeded_keys.size > 0) {
    get_changed().catch(log_error);
  }
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
 * thing on the synchronous commit path (see module doc comment). `slot`
 * is which of the row's two postings this edit targets - either can be
 * edited (see EditableRow), independently of the other. */
export function commit_edit(
  row: EditableRow,
  slot: 0 | 1,
  new_account: string,
): void {
  const posting = row.postings[slot];
  if (new_account === posting.account) {
    return;
  }
  if (!new_account.trim()) {
    // Defense in depth against an empty/blank account ever reaching the
    // ledger - Escape is the primary way to discard an in-progress edit
    // (see oncancel/close_active_editor), but this guards every other
    // path (a stray blur mid-clear, a future caller) too. Silently no-op
    // rather than commit garbage; the cell already shows whatever the
    // user typed, so nothing visually disappears.
    return;
  }
  const key = pending_key(row.entry_hash, slot);
  const existing = pending.get(key);
  pending.set(key, {
    old_account: existing?.old_account ?? posting.account,
    new_account,
    li: row.li,
    payee: row.payee,
    posting_index: slot,
  });
  category_edit_state.pending = pending.size;
  render_cell_text(posting.cell, new_account);
  posting.account = new_account;
  schedule_flush();
}

/** Renders the same shape of link the server-rendered journal uses for a
 * posting's account (a real `/account/<name>/` URL) - `find_editable_row`
 * (via `account_from_link`) parses that URL back out to identify a row's
 * accounts on every subsequent pass, so a placeholder href here would make
 * a once-edited row unrecognizable to fill-down, re-opening its editor,
 * and so on. */
function render_cell_text(cell: HTMLElement, account: string): void {
  cell.classList.remove("category-editing");
  cell.textContent = "";
  const a = document.createElement("a");
  a.textContent = account;
  a.href = get(url_for_account)(account);
  cell.append(a);
}

const already_offered = new Set<string>();

function offer_rule_learning(payee: string, account: string): void {
  const key = `${payee} ${account}`;
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

let active_editor: {
  row: EditableRow;
  slot: 0 | 1;
  unmount: () => void;
} | null = null;

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
export function close_active_editor(): void {
  const editor = active_editor;
  if (editor == null) {
    return;
  }
  active_editor = null;
  editor.unmount();
  render_cell_text(
    editor.row.postings[editor.slot].cell,
    editor.row.postings[editor.slot].account,
  );
}

/**
 * Open an editor on the selected row. `slot` picks which of the row's two
 * postings to edit - defaults to the counter account (index other than
 * `this_idx`), preserving the original, still-most-common workflow
 * (browsing a bank account, categorizing the counter side) as the default
 * for plain row-level navigation (Enter/ArrowUp/ArrowDown). Pass an
 * explicit slot for click-to-edit or cell-to-cell ArrowRight/ArrowLeft.
 */
function open_editor(
  ol: HTMLOListElement,
  this_account: string,
  slot?: 0 | 1,
): void {
  // Edit mode may have been turned off in the moment between this call
  // being scheduled (a queueMicrotask reopen from a move/fill-down/click)
  // and it actually running - e.g. toggling the "Edit categories" button
  // off while a row-advance was already in flight. Without this guard,
  // that stale reopen would silently undo the toggle-off by mounting a
  // fresh editor right after close_active_editor() ran.
  if (!category_edit_state.active) {
    return;
  }
  close_active_editor();
  const li = selected_row(ol);
  if (li == null) {
    return;
  }
  const row = find_editable_row(li, this_account);
  if (row == null) {
    return;
  }
  const target_slot = slot ?? counter_idx_of(row);
  const posting = row.postings[target_slot];
  const container = document.createElement("span");
  // Plain, un-styled mount target for CategoryEditCell - its own scoped
  // CSS sizes ITS OWN root element to 100% width, but that's only
  // meaningful if THIS wrapping container (created here, outside any
  // component) is block-level and full-width too, not shrink-to-fit.
  container.style.display = "block";
  container.style.width = "100%";
  posting.cell.textContent = "";
  posting.cell.classList.add("category-editing");
  posting.cell.append(container);
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
  // Deferred a tick (mounting and focusing the next cell's input in the
  // same synchronous stack as the previous one's teardown is flaky in
  // Chrome - the fresh input can pick up a spurious blur right after
  // gaining focus, which AutocompleteInput turns into its own
  // onchange/commit and would otherwise cascade into skipping an extra
  // row/cell), and generation-guarded the same way.
  const reopen = (move: () => void, next_slot: 0 | 1 | undefined) => {
    if (move_generation !== my_generation) {
      return;
    }
    move_generation++;
    close_active_editor();
    move();
    queueMicrotask(() => {
      open_editor(ol, this_account, next_slot);
    });
  };
  const move_to_row = (direction: 1 | -1, next_slot?: 0 | 1) => {
    reopen(() => {
      move_selection(ol, direction);
    }, next_slot);
  };
  const move_to_same_row_other_slot = () => {
    reopen(() => {
      /* selection (the row) doesn't change - only the slot does. */
    }, target_slot === 0 ? 1 : 0);
  };
  const is_current = () =>
    active_editor?.row === row && active_editor.slot === target_slot;
  const instance = mount(CategoryEditCell, {
    target: container,
    props: {
      initial_value: posting.account,
      oncommit: (value: string) => {
        if (!is_current()) {
          return;
        }
        commit_edit(row, target_slot, value);
        move_to_row(1);
      },
      // A blur that isn't Tab/Enter/Arrow/select - focus was lost to
      // something else entirely, almost always a mouse click elsewhere on
      // the page (a table header, blank space, the edit-mode toggle
      // button, ...). Previously this went through the SAME path as
      // oncommit above (AutocompleteInput has no way to tell them apart
      // on its own - see on_blur_change), so any click anywhere would
      // save-and-advance-to-the-next-row, which is what a plain click
      // should never do. Save what's here (don't lose typed input) but
      // stay put - no row/cell movement.
      onblur: (value: string) => {
        if (!is_current()) {
          return;
        }
        commit_edit(row, target_slot, value);
        close_active_editor();
      },
      // Escape: discard the edit entirely and restore the original value.
      // close_active_editor() re-renders the cell from `posting.account`,
      // which commit_edit() was never called to change here, so this is
      // already exactly "revert to original" with no extra bookkeeping.
      oncancel: () => {
        if (!is_current()) {
          return;
        }
        close_active_editor();
      },
      onarrowdown: (value: string) => {
        if (!is_current()) {
          return;
        }
        commit_edit(row, target_slot, value);
        move_to_row(1);
      },
      onarrowup: (value: string) => {
        if (!is_current()) {
          return;
        }
        commit_edit(row, target_slot, value);
        move_to_row(-1);
      },
      onarrowright: (value: string) => {
        if (!is_current()) {
          return;
        }
        commit_edit(row, target_slot, value);
        if (target_slot === 0) {
          move_to_same_row_other_slot();
        } else {
          // Already on the row's last cell - flow into the next row's
          // first cell, matching left-to-right/top-to-bottom reading
          // order.
          move_to_row(1, 0);
        }
      },
      onarrowleft: (value: string) => {
        if (!is_current()) {
          return;
        }
        commit_edit(row, target_slot, value);
        if (target_slot === 1) {
          move_to_same_row_other_slot();
        } else {
          // Already on the row's first cell - flow backward into the
          // previous row's LAST cell (symmetric with ArrowRight above).
          move_to_row(-1, 1);
        }
      },
    },
  });
  active_editor = { row, slot: target_slot, unmount: () => unmount(instance) };
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

/** Ctrl/Cmd+D: repeat the row-above's value, into the SAME role (this-
 * account-side or counter-side, whichever is currently being edited - see
 * EditableRow) in the current row - the primary rapid-correction tool for
 * a run of sorted, similar transactions. Works whether or not a cell is
 * currently open on the target row (in the normal flow, one always is -
 * each row-advancing action reopens the next row's editor immediately, so
 * gating this on "no cell open" would make it effectively unreachable).
 *
 * Role-aware (not simply "copy row-above's posting at the same DOM
 * index") because the two postings' order isn't guaranteed consistent
 * between rows, and because which side is meaningful to fill down depends
 * entirely on which account's journal this is: browsing a bank account,
 * it's almost always the counter (category) side; browsing an expense
 * category's own journal to fix miscategorized entries, it's the
 * this-account side instead. Also advances to the next row afterward,
 * continuing the SAME role there, so repeated Ctrl+D fills a whole run of
 * rows in one column without ever needing another key. */
function fill_down(ol: HTMLOListElement, this_account: string): void {
  const rows = visible_rows(ol);
  const current_index = rows.findIndex((li) =>
    li.classList.contains(SELECTED_CLASS),
  );
  if (current_index <= 0) {
    return;
  }
  const current_li = rows[current_index]!;
  // Which slot/role to fill, and whether the current row's own editor is
  // open on current_li, need deciding BEFORE any find_editable_row call
  // on current_li: while that row's editor is open, the edited posting's
  // cell holds the mounted input, not an <a>, so find_editable_row (via
  // account_from_link) can't parse it and returns null for the whole row
  // - not just that one posting. active_editor already has everything
  // needed (this_idx, li) from when it was opened, so use that instead
  // of re-deriving it from DOM that's mid-edit.
  const editor_here = active_editor?.row.li === current_li ? active_editor : null;
  const this_idx_of_current =
    editor_here?.row.this_idx ??
    find_editable_row(current_li, this_account)?.this_idx;
  if (this_idx_of_current == null) {
    return;
  }
  const target_slot =
    editor_here?.slot ?? (this_idx_of_current === 0 ? 1 : 0);
  const editing_this_side = target_slot === this_idx_of_current;
  const above = find_editable_row(rows[current_index - 1]!, this_account);
  if (above == null) {
    return;
  }
  const above_slot = editing_this_side
    ? above.this_idx
    : counter_idx_of(above);
  // If the current row's editor is open, it owns current_li's cell's DOM
  // right now - close it first so commit_edit's render doesn't yank the
  // DOM out from under the still-mounted Svelte component, AND so the
  // find_editable_row call right below can parse that cell's link again.
  if (editor_here != null) {
    close_active_editor();
  }
  const current = find_editable_row(current_li, this_account);
  if (current == null) {
    return;
  }
  commit_edit(current, target_slot, above.postings[above_slot].account);
  move_selection(ol, 1);
  queueMicrotask(() => {
    // Continue the same role on the row now selected, so a run of Ctrl+D
    // presses fills one consistent column rather than snapping back to
    // the row-level default (counter) each time.
    const next_li = selected_row(ol);
    const next = next_li ? find_editable_row(next_li, this_account) : null;
    const next_slot = next
      ? editing_this_side
        ? next.this_idx
        : counter_idx_of(next)
      : undefined;
    open_editor(ol, this_account, next_slot);
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
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
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

  /** Click directly on either posting's account link opens an editor
   * there (selecting its row first if needed), instead of navigating to
   * that account - the click-to-edit counterpart of arrowing/tabbing
   * into a specific cell. Only intercepts within edit mode, and only for
   * a posting's own account link inside a two-posting editable row;
   * everything else (the date link, a non-editable row, edit mode being
   * off) falls through to Fava's normal click handling untouched. */
  function click(event: MouseEvent): void {
    if (!category_edit_state.active) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const posting_li = target.closest<HTMLLIElement>("ul.postings > li");
    if (posting_li == null || !ol.contains(posting_li)) {
      return;
    }
    const link = target.closest("a");
    if (link == null || !posting_li.contains(link)) {
      return;
    }
    const row_li = posting_li.closest<HTMLLIElement>("li.transaction");
    if (row_li == null) {
      return;
    }
    // If this row's own editor is already open (on its OTHER posting -
    // the one just clicked still has a real <a>, or this click wouldn't
    // have found one above), find_editable_row can't be used as the
    // validity check here: the currently-edited cell holds a mounted
    // input, not an <a>, so account_from_link can't parse it and
    // find_editable_row returns null for the WHOLE row, not just that
    // one posting. Its editor having been opened at all already proved
    // the row is editable, so skip straight to open_editor instead (which
    // closes that editor - restoring a real link - before it re-derives
    // anything).
    if (active_editor?.row.li !== row_li) {
      const row = find_editable_row(row_li, this_account);
      if (row == null) {
        return;
      }
    }
    const postings = [
      ...row_li.querySelectorAll<HTMLLIElement>(":scope > ul.postings > li"),
    ];
    const clicked_index = postings.indexOf(posting_li);
    if (clicked_index !== 0 && clicked_index !== 1) {
      return;
    }
    event.preventDefault();
    if (!row_li.classList.contains(SELECTED_CLASS)) {
      selected_row(ol)?.classList.remove(SELECTED_CLASS);
      row_li.classList.add(SELECTED_CLASS);
    }
    open_editor(ol, this_account, clicked_index);
  }
  ol.addEventListener("click", click);

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
    ol.removeEventListener("click", click);
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
