/**
 * Fold a single character to a diacritic-insensitive base form, e.g. "ö" ->
 * "o", so that typing a plain "o" can match account/payee names that use
 * the accented form (common with German umlauts: ÖPNV, Straße, ...).
 * NFD-decomposes the character into a base letter plus zero or more
 * combining marks and keeps just the base - this is applied per character
 * (not to a whole string at once) specifically so it stays one-to-one with
 * the original string's character positions, which fuzzytest/fuzzywrap's
 * index-based matching and slicing both depend on.
 */
function fold_char(char: string): string {
  return char.normalize("NFD").charAt(0);
}

/** Diacritic-insensitive lowercase, preserving length/position. */
function fold(text: string): string {
  return [...text].map((c) => fold_char(c.toLowerCase())).join("");
}

/**
 * Fuzzy match a pattern against a string.
 *
 * @param pattern The pattern to search for.
 * @param text The string to search in.
 *
 * Returns a score greater than zero if all characters of `pattern` can be
 * found in order in `string`. For lowercase characters in `pattern` match both
 * lower and upper case, for uppercase only an exact match counts. Matching
 * is also diacritic-insensitive when `pattern` is lowercase (see fold_char).
 */
export function fuzzytest(pattern: string, text: string): number {
  const casesensitive = pattern === pattern.toLowerCase();
  const exact = casesensitive
    ? fold(text).indexOf(fold(pattern))
    : text.indexOf(pattern);
  if (exact > -1) {
    return pattern.length ** 2;
  }
  let score = 0;
  let localScore = 0;
  let pindex = 0;
  for (const char of text) {
    const search = pattern[pindex];
    if (
      char === search ||
      char.toLowerCase() === search ||
      (search != null && fold_char(char.toLowerCase()) === fold_char(search))
    ) {
      pindex += 1;
      localScore += 1;
    } else {
      localScore = 0;
    }
    score += localScore;
  }
  return pindex === pattern.length ? score : 0;
}

/**
 * Filter a list of possible suggestions to only those that match the pattern
 */
export function fuzzyfilter(
  pattern: string,
  suggestions: readonly string[],
): readonly string[] {
  if (!pattern) {
    return suggestions;
  }
  return suggestions
    .map((s): [string, number] => [s, fuzzytest(pattern, s)])
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
}

export type FuzzyWrappedText = ["text" | "match", string][];

/**
 * Wrap fuzzy matched characters.
 *
 * Wrap all occurrences of characters of `pattern` (in order) in `string` in
 * tuples with a "match" marker (and the others as plain "text") to allow for
 * the matches to be wrapped in markers to highlight them in the HTML.
 */
export function fuzzywrap(pattern: string, text: string): FuzzyWrappedText {
  if (!pattern) {
    return [["text", text]];
  }
  const casesensitive = pattern === pattern.toLowerCase();
  const exact = casesensitive
    ? fold(text).indexOf(fold(pattern))
    : text.indexOf(pattern);
  if (exact > -1) {
    const before = text.slice(0, exact);
    const match = text.slice(exact, exact + pattern.length);
    const after = text.slice(exact + pattern.length);
    const result: FuzzyWrappedText = [];
    if (before) {
      result.push(["text", before]);
    }
    result.push(["match", match]);
    if (after) {
      result.push(["text", after]);
    }
    return result;
  }
  // current index into the pattern
  let pindex = 0;
  // current unmatched string
  let plain: string | null = null;
  // current matched string
  let match: string | null = null;
  const result: FuzzyWrappedText = [];
  for (const char of text) {
    const search = pattern[pindex];
    if (
      char === search ||
      char.toLowerCase() === search ||
      (search != null && fold_char(char.toLowerCase()) === fold_char(search))
    ) {
      match = match != null ? match + char : char;
      if (plain != null) {
        result.push(["text", plain]);
        plain = null;
      }
      pindex += 1;
    } else {
      plain = plain != null ? plain + char : char;
      if (match != null) {
        result.push(["match", match]);
        match = null;
      }
    }
  }
  if (pindex < pattern.length) {
    return [["text", text]];
  }
  if (plain != null) {
    result.push(["text", plain]);
  }
  if (match != null) {
    result.push(["match", match]);
  }
  return result;
}
