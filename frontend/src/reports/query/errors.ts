/**
 * A structured query error - unlike a generic API error, a failed query
 * can carry real position info (character offset, line, column) from
 * the underlying beanquery parse/compilation error, which the query
 * editor can use to highlight the offending span. Position info is
 * best-effort: PEG-parser backtracking means it doesn't always land on
 * the most intuitive character, and some error types (e.g. "query not
 * found") never have it at all.
 */
export interface QueryError {
  readonly message: string;
  readonly range?: { readonly pos: number; readonly endpos: number };
}
