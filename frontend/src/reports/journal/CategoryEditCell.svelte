<!--
  @component
  A single editable counter-account cell, mounted imperatively (via
  svelte's `mount()`) into a journal row's DOM by category_edit.svelte.ts
  - see that module for why the journal itself isn't Svelte-templated
  rows and for the overall interaction design.

  Reuses AccountInput (the same account-name autocomplete the entry form
  uses) as-is for typing/fuzzy-matching/validity, with these adjustments:

  - `onchange` drives commit-and-advance (Enter, or a suggestion picked
    with the mouse/keyboard) - AutocompleteInput's callback for every
    deliberate "the user chose this value" path.
  - `on_blur_change` (a second, narrower AutocompleteInput hook - see that
    component) drives commit-WITHOUT-advancing: it only fires for a blur
    that isn't one of Tab/Enter/Arrow/select (all of those are fully
    intercepted before they ever reach a native blur here - see below), so
    the only thing left to trigger it is focus being lost to something
    external, almost always a mouse click elsewhere on the page. That must
    NOT be treated the same as "move to the next row" (it isn't a
    navigation action at all), just "save what's here and close" - see
    `onblur` below and the bug this fixes in category_edit.svelte.ts.
  - ArrowDown/ArrowUp/Tab/Shift+Tab are intercepted in the capture phase,
    before they reach AccountInput's own listener: standard combobox
    behavior claims Up/Down for suggestion-list navigation and leaves Tab
    to native focus-shifting, both of which conflict with this editor's
    "Up/Down/Tab commit and move to the previous/next row or posting"
    requirement. Escape is intercepted the same way, unconditionally
    (regardless of whether a suggestion dropdown happens to be open) - see
    `oncancel` below.
  - ArrowRight/ArrowLeft are intercepted too, but only when the caret is
    already at the end/start of the text - short of that they're left
    alone for normal in-text cursor movement. Tab/Shift+Tab do the same
    move unconditionally (not gated on caret position - that's the whole
    point of Tab). This is how a row's other editable posting (when this
    account has two - see category_edit.svelte.ts's find_editable_row) is
    reached: arrow past either end of one cell's text, or just Tab, to
    move into the other.
-->
<script lang="ts">
  import { onMount } from "svelte";

  import AccountInput from "../../entry-forms/AccountInput.svelte";

  interface Props {
    initial_value: string;
    /** The value has been deliberately chosen (Enter, or a suggestion
     * picked) - commit and move to the next row. */
    oncommit: (value: string) => void;
    /** Focus was lost to something else entirely (almost always a mouse
     * click elsewhere) rather than any of the deliberate navigation
     * actions below - commit what's here in place, but do NOT move the
     * selection or open another cell. See the module doc comment. */
    onblur: (value: string) => void;
    /** Escape - discard whatever's been typed and restore the original
     * value; the editor closes without committing anything. */
    oncancel: () => void;
    /** ArrowDown - commit (same as oncommit) and move down. */
    onarrowdown: (value: string) => void;
    /** ArrowUp - commit (same as oncommit) and move up. */
    onarrowup: (value: string) => void;
    /** ArrowRight at the end of the text, or Tab - commit and move into
     * the row's other editable posting (or the next row if there is
     * none). */
    onarrowright: (value: string) => void;
    /** ArrowLeft at the start of the text, or Shift+Tab - same,
     * backward. */
    onarrowleft: (value: string) => void;
  }

  let {
    initial_value,
    oncommit,
    onblur,
    oncancel,
    onarrowdown,
    onarrowup,
    onarrowright,
    onarrowleft,
  }: Props = $props();

  let value = $state(initial_value);
  let wrapper: HTMLSpanElement | undefined = $state();

  onMount(() => {
    const input = wrapper?.querySelector("input");
    input?.focus();
    input?.select();
  });

  function capture_keydown(event: KeyboardEvent) {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      onarrowdown(value);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      onarrowup(value);
    } else if (event.key === "Escape") {
      // Unconditional - deliberately not delegated to AutocompleteInput's
      // own Escape handling (clear the dropdown, or clear the value if
      // the dropdown was already closed), which never restores the
      // ORIGINAL value and, worse, can leave an emptied value sitting
      // there to be committed by whatever blur follows. Escape should
      // mean "undo", full stop.
      event.preventDefault();
      event.stopPropagation();
      oncancel();
    } else if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onarrowleft(value);
    } else if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onarrowright(value);
    } else if (
      event.key === "ArrowRight" &&
      input != null &&
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length
    ) {
      event.preventDefault();
      event.stopPropagation();
      onarrowright(value);
    } else if (
      event.key === "ArrowLeft" &&
      input != null &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0
    ) {
      event.preventDefault();
      event.stopPropagation();
      onarrowleft(value);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span bind:this={wrapper} onkeydowncapture={capture_keydown}>
  <AccountInput bind:value onchange={oncommit} on_blur_change={onblur} />
</span>

<style>
  /* Fills the journal row's .description cell (flex: 1, so normally
     plenty of room) instead of shrinking to the browser's default
     ~20-character input width - account names routinely run much
     longer than that (e.g. Expenses:Versicherungen:Krankenversicherung). */
  span {
    display: block;
    width: 100%;
  }

  /* AutocompleteInput's own wrapper span is display:inline-block
     (shrink-to-fit by default) - override it too, otherwise the 100%
     above only reaches as far as that still-shrunk span and the input
     inside it stays at the browser's default width regardless.

     Direct-child combinator only (not a bare descendant selector): a
     descendant selector here also matched the highlight <span>s nested
     INSIDE the suggestion dropdown's own <li>s (see AutocompleteInput's
     fuzzywrap usage) - forcing each matched-text fragment to block/100%
     width broke the dropdown's layout, making every entry wrap instead
     of laying out as a normal line of text. AutocompleteInput's own
     wrapper span is the only span actually meant to be targeted here,
     and it's a direct child of the span below. */
  span > :global(span) {
    display: block;
    width: 100%;
    box-sizing: border-box;
  }

  span :global(input) {
    width: 100%;
    box-sizing: border-box;
  }
</style>
