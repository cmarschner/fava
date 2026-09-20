<script lang="ts">
  import { _ } from "../i18n.ts";
  import { keyboardShortcut } from "../keyboard-shortcuts.ts";
  import { router } from "../router.ts";
  import { ledger_data } from "../stores/index.ts";
  import { ledger_title } from "../stores/options.ts";
  import FilterForm from "./FilterForm.svelte";
  import HeaderIcon from "./HeaderIcon.svelte";
  import PageTitle from "./PageTitle.svelte";
  import { has_changes } from "./page-title.ts";

  let other_ledgers = $derived($ledger_data.other_ledgers);
  let has_dropdown = $derived(other_ledgers.length);
</script>

<header>
  <HeaderIcon />
  <h1>
    {$ledger_title}{#if has_dropdown}&nbsp;▾{/if}<PageTitle />
    {#if has_dropdown}
      <div class="beancount-files">
        <ul>
          {#each other_ledgers as [name, url] (url)}
            <li>
              <a href={url} data-remote>{name}</a>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </h1>
  <button
    type="button"
    class="reload-page"
    class:has-changes={$has_changes}
    title={_("Reload")}
    {@attach keyboardShortcut("r")}
    onclick={router.reload}
  >
    &#8635;
  </button>
  <span class="spacer"></span>
  <FilterForm />
</header>

<style>
  /* Previously only rendered at all when Fava's own change-detection
     (get_changed(), backed by an inotify watcher known to be unreliable
     on a bind-mounted ledger - see category_edit.svelte.ts's flush_all
     doc comment) had actually fired - meaning if that detection missed a
     change (its own file being fixed externally, e.g. by a process other
     than Fava's own save endpoint), there was no visible way at all to
     force a reload. Always available now; the warning color is reserved
     for when Fava itself believes something changed, so it still pops in
     the common case, but a manual reload no longer depends on that
     detection succeeding. */
  .reload-page {
    color: var(--dark-gray);
    background-color: var(--background);
  }

  .reload-page.has-changes {
    background-color: var(--warning);
  }

  h1 {
    display: inline-block;
    padding: 0.5rem;
    margin: 0;
    overflow: hidden;
    font-size: 16px;
    font-weight: normal;
  }

  a:hover,
  a:link,
  a:visited {
    color: inherit;
  }

  .beancount-files {
    position: absolute;
    z-index: var(--z-index-floating-ui);
    display: none;
    width: 20em;
    margin-top: 0.25em;
    color: var(--link-color);
    background-color: var(--background);
    border: 1px solid var(--border);
    box-shadow: var(--box-shadow-dropdown);
  }

  .beancount-files a {
    display: block;
    padding: 8px 12px 8px 28px;
    cursor: pointer;
  }

  h1:hover .beancount-files {
    display: block;
  }

  .beancount-files ul {
    max-height: 400px;
    margin-bottom: 0;
    overflow-y: auto;
  }

  .beancount-files a:hover {
    color: var(--background);
    background-color: var(--link-color);
  }
</style>
