import { syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder } from "@codemirror/view";

import { base_extensions } from "./base-extensions.ts";
import { bql_highlight } from "./bql-highlight.ts";
import { bql_language_support } from "./bql-language.ts";

export { replace_contents } from "./editor-transactions.ts";

/**
 * A basic readonly editor for an asynchronously loaded document.
 *
 * This doesn't use any of the BQL syntax but is provided in this file
 * to avoid more smaller chunks.
 */
export function init_document_preview_editor(): EditorView {
  return new EditorView({
    extensions: [
      base_extensions,
      EditorState.readOnly.of(true),
      placeholder("Loading..."),
    ],
  });
}

/**
 * A basic readonly BQL editor that only does syntax highlighting.
 *
 * `error_range`, if given, marks that character range with a decoration
 * (`.cm-query-error-span`) - used to highlight the offending span of a
 * failed query, when the backend was able to provide real position info.
 * Silently ignored if the range falls outside the document (defensive -
 * PEG-parser backtracking means error positions aren't always exactly
 * where you'd expect, so this must never throw).
 */
export function init_readonly_query_editor(
  value: string,
  error_range?: { pos: number; endpos: number },
): EditorView {
  const extensions = [
    bql_language_support,
    syntaxHighlighting(bql_highlight),
    EditorState.readOnly.of(true),
  ];
  if (error_range) {
    const from = Math.max(0, Math.min(error_range.pos, value.length));
    const to = Math.max(from + 1, Math.min(error_range.endpos, value.length));
    if (from < value.length) {
      const mark = Decoration.mark({ class: "cm-query-error-span" });
      extensions.push(
        EditorView.decorations.of(Decoration.set([mark.range(from, to)])),
      );
    }
  }
  return new EditorView({
    doc: value,
    extensions,
  });
}

/**
 * The main BQL editor.
 */
export function init_query_editor(
  value: string,
  onDocChanges: (s: EditorState) => void,
  placeholder_value: string,
  get_submit: () => () => void,
): EditorView {
  return new EditorView({
    doc: value,
    extensions: [
      bql_language_support,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onDocChanges(update.state);
        }
      }),
      keymap.of([
        {
          key: "Control-Enter",
          mac: "Meta-Enter",
          run: () => {
            const submit = get_submit();
            submit();
            return true;
          },
        },
      ]),
      placeholder(placeholder_value),
      base_extensions,
      syntaxHighlighting(bql_highlight),
    ],
  });
}
