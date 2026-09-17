<script lang="ts">
  import AutocompleteInput from "../components/AutocompleteInput.svelte";
  import { url_for_account } from "../helpers.ts";
  import { _ } from "../i18n.ts";
  import { router } from "../router.ts";
  import { accounts } from "../stores/index.ts";

  let value = $state("");
  let autocomplete = $state.raw<{ blur: () => void }>();

  // $accounts is ranked by recency/frequency of use (see
  // core/attributes.py's ExponentialDecayRanker) - a good default for
  // autocompleting an account while entering a transaction (entry-forms/
  // AccountInput.svelte uses it as-is for that), but confusing for
  // jumping straight to a specific account by name, where alphabetical is
  // what a user scanning the list expects.
  let sorted_accounts = $derived([...$accounts].sort());

  function select() {
    if (value) {
      router.navigate($url_for_account(value));
      autocomplete?.blur();
      value = "";
    }
  }
</script>

<li>
  <AutocompleteInput
    bind:value
    bind:this={autocomplete}
    placeholder={_("Go to account")}
    suggestions={sorted_accounts}
    key="g a"
    onselect={select}
    onenter={select}
  />
</li>

<style>
  li {
    --input-border: none;
    --input-padding: 0.25em 0.5em 0.25em 1em;
    --autocomplete-list-position: fixed;
  }
</style>
