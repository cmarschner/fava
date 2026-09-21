import { is_editable_element } from "../../keyboard-shortcuts.ts";

/**
 * Keyboard navigation of the journal listing, modelled on the
 * "never leave the keyboard" style of data-entry workflows: ArrowUp/
 * ArrowDown move a visible selection between journal rows, Enter opens the
 * selected entry's existing context/edit overlay (the same one a click on
 * its date would open - see click_handler.ts and modals/Context.svelte),
 * and Shift-Enter/Escape are handled by the editor and the modal dialog
 * itself (see editor/SliceEditor.svelte's codemirror keymap, and
 * modals/ModalBase.svelte's native <dialog> Escape/cancel handling) rather
 * than here.
 */

const SELECTED_CLASS = "selected";

/** The currently selected row's index among the *visible* rows, or -1. */
function visible_rows(ol: HTMLOListElement): HTMLLIElement[] {
  return [...ol.querySelectorAll<HTMLLIElement>(":scope > li")].filter(
    // Filtered-out entries stay in the DOM with `display: none` (toggled by
    // the show-* classes on the <ol>, see css/journal-table.css) rather than
    // being removed, so skip over rows that aren't actually visible.
    (li) => li.getClientRects().length > 0,
  );
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

/** Open the context/edit overlay for the currently selected row, if any. */
function open_selected(ol: HTMLOListElement): void {
  const selected = ol.querySelector<HTMLLIElement>(`:scope > li.${SELECTED_CLASS}`);
  const link = selected?.querySelector<HTMLAnchorElement>(".datecell a");
  link?.click();
}

/** Elements a click on which already does something of its own - open a
 * link (the date, a document, an account), toggle indicators, filter by
 * tag/payee/metadata, or (in category-edit mode) open an account editor.
 * A click landing on one of these should do only that, not also select
 * the row underneath it - see click_handler.ts and category_edit.svelte.ts
 * for what each of these already does on click. */
const INTERACTIVE_SELECTOR =
  "a, button, input, .tag, .link, .payee, dt, dd, .indicators";

/** The row (a direct child of `ol`) containing `target`, however deeply
 * nested `target` is (e.g. inside a transaction's own nested postings
 * <li> elements) - or null if `target` isn't inside any row of `ol`. */
function containing_row(
  ol: HTMLOListElement,
  target: Element,
): HTMLLIElement | null {
  let el: Element | null = target;
  while (el && el !== ol) {
    if (el.parentElement === ol) {
      return el instanceof HTMLLIElement ? el : null;
    }
    el = el.parentElement;
  }
  return null;
}

/** Select the row under a click, mirroring what ArrowUp/ArrowDown already
 * do - but only for a click that isn't on one of the row's own
 * interactive elements (see INTERACTIVE_SELECTOR), which already have
 * their own click behavior that shouldn't be reinterpreted as row
 * selection. */
function click(ol: HTMLOListElement, event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || target.closest(INTERACTIVE_SELECTOR)) {
    return;
  }
  const li = containing_row(ol, target);
  if (li == null) {
    return;
  }
  ol
    .querySelector<HTMLLIElement>(`:scope > li.${SELECTED_CLASS}`)
    ?.classList.remove(SELECTED_CLASS);
  li.classList.add(SELECTED_CLASS);
}

/**
 * Attach the ArrowUp/ArrowDown/Enter journal navigation, and click-to-select
 * (see `click` above), to `ol` for as long as the caller keeps the returned
 * cleanup un-called (intended to be run from a component's `$effect`,
 * active only while the journal report is mounted).
 *
 * Like Fava's other keyboard shortcuts, this ignores the event while focus
 * is in an editable element (e.g. the journal filter input, or the source
 * editor in an open entry overlay) - see is_editable_element.
 */
export function init_journal_keyboard_navigation(
  ol: HTMLOListElement,
): () => void {
  function keydown(event: KeyboardEvent): void {
    if (is_editable_element(event.target)) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move_selection(ol, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move_selection(ol, -1);
        break;
      case "Enter":
        event.preventDefault();
        open_selected(ol);
        break;
      default:
        break;
    }
  }
  function on_click(event: MouseEvent): void {
    click(ol, event);
  }
  document.addEventListener("keydown", keydown);
  ol.addEventListener("click", on_click);
  return () => {
    document.removeEventListener("keydown", keydown);
    ol.removeEventListener("click", on_click);
  };
}
