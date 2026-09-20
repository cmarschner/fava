<!--
  @component
  A single editable counter-account cell, mounted imperatively (via
  svelte's `mount()`) into a journal row's DOM by category_edit.svelte.ts
  - see that module for why the journal itself isn't Svelte-templated
  rows and for the overall interaction design.

  Reuses AccountInput (the same account-name autocomplete the entry form
  uses) as-is for typing/fuzzy-matching/validity, with two adjustments:

  - `onchange` (not `onenter`/`onselect` individually) drives commit: it's
    AutocompleteInput's one callback that reliably fires across every path
    that should commit here - Enter with a suggestion highlighted (goes
    through `select()`), Enter with none (the `onenter` path), and Tab
    (via blur) whether or not a suggestion was highlighted. `onenter`/
    `onselect` alone would miss the plain-Tab-out case, breaking the
    "Tab commits and moves to the next row" requirement.
  - ArrowDown/ArrowUp are intercepted in the capture phase, before they
    reach AccountInput's own listener: standard combobox behavior
    unconditionally claims both for suggestion-list navigation, which
    conflicts with this editor's "Up/Down commits and moves to the
    previous/next row" requirement.
  - ArrowRight/ArrowLeft are intercepted too, but only when the caret is
    already at the end/start of the text - short of that they're left
    alone for normal in-text cursor movement. This is how a row's other
    editable posting (when this account has two - see
    category_edit.svelte.ts's find_editable_row) is reached: arrow past
    either end of one cell's text to move into the other.
-->
<script lang="ts">
  import { onMount } from "svelte";

  import AccountInput from "../../entry-forms/AccountInput.svelte";

  interface Props {
    initial_value: string;
    /** The value has been committed (Enter, Tab, or blur) - move to the
     * next row. */
    oncommit: (value: string) => void;
    /** ArrowDown - commit (same as oncommit) and move down. */
    onarrowdown: (value: string) => void;
    /** ArrowUp - commit (same as oncommit) and move up. */
    onarrowup: (value: string) => void;
    /** ArrowRight at the end of the text - commit and move into the
     * row's other editable posting (or the next row if there is none). */
    onarrowright: (value: string) => void;
    /** ArrowLeft at the start of the text - same, backward. */
    onarrowleft: (value: string) => void;
  }

  let {
    initial_value,
    oncommit,
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
  <AccountInput bind:value onchange={oncommit} />
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
     inside it stays at the browser's default width regardless. */
  span :global(span) {
    display: block;
    width: 100%;
    box-sizing: border-box;
  }

  span :global(input) {
    width: 100%;
    box-sizing: border-box;
  }
</style>
