<!--
  @component
  A small multi-account picker: an autocomplete text entry to add one
  account at a time, plus removable chips for the ones already picked.
  Shared by the Phase 2a "Exclude accounts" and Phase 2b "Cash-flow
  pool" controls in QueryBox.svelte - both need the same "pick several
  real accounts" interaction, just with a different resulting set.
-->
<script lang="ts">
  import AccountInput from "../../entry-forms/AccountInput.svelte";
  import { _ } from "../../i18n.ts";

  interface Props {
    /** The currently selected accounts (bindable). */
    selected: string[];
  }

  let { selected = $bindable() }: Props = $props();

  let entry = $state("");

  function add(value: string) {
    const trimmed = value.trim();
    if (trimmed && !selected.includes(trimmed)) {
      selected = [...selected, trimmed];
    }
    entry = "";
  }

  function remove(account: string) {
    selected = selected.filter((a) => a !== account);
  }
</script>

<span class="account-multi-select">
  {#each selected as account (account)}
    <span class="chip">
      {account}
      <button
        type="button"
        aria-label={_("Remove")}
        onclick={() => {
          remove(account);
        }}
      >
        ×
      </button>
    </span>
  {/each}
  <AccountInput bind:value={entry} onchange={add} on_blur_change={() => undefined} />
</span>

<style>
  .account-multi-select {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    padding: 0.05rem 0.4rem;
    font-size: 0.85em;
    background-color: var(--background-darker, #eee);
    border-radius: var(--border-radius, 0.25rem);
  }

  .chip button {
    padding: 0 0.15rem;
    line-height: 1;
    background: transparent;
  }
</style>
