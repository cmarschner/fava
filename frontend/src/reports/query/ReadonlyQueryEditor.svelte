<script lang="ts">
  import { attach_editor } from "../../codemirror/dom.ts";
  import type { CodemirrorBql } from "../../codemirror/types.ts";

  interface Props {
    value: string;
    error?: boolean | undefined;
    /** Real character range of the error in `value`, if known - highlighted in the editor. */
    error_range?: { pos: number; endpos: number } | undefined;
    codemirror_bql: CodemirrorBql;
  }

  let { value, error = false, error_range, codemirror_bql }: Props = $props();

  let editor = $derived(
    codemirror_bql.init_readonly_query_editor(value, error_range),
  );
</script>

<pre class:error {@attach attach_editor(editor)}></pre>

<style>
  .error {
    border: 1px solid var(--error);
  }

  :global(.cm-query-error-span) {
    background-color: var(--error);
    opacity: 0.4;
    border-radius: 2px;
  }
</style>
