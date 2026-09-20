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
  - ArrowDown is intercepted in the capture phase, before it reaches
    AccountInput's own listener: standard combobox behavior claims
    ArrowDown for suggestion-list navigation, which conflicts with this
    editor's "Down commits and moves to the next row" requirement.
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
  }

  let { initial_value, oncommit, onarrowdown }: Props = $props();

  let value = $state(initial_value);
  let wrapper: HTMLSpanElement | undefined = $state();

  onMount(() => {
    wrapper?.querySelector("input")?.focus();
  });

  function capture_keydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      onarrowdown(value);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span bind:this={wrapper} onkeydowncapture={capture_keydown}>
  <AccountInput bind:value onchange={oncommit} />
</span>

<style>
  span {
    display: inline-block;
  }
</style>
