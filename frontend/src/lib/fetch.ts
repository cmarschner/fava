import { is_json_object, number, object, optional, string } from "./validation.ts";

export class FetchError extends Error {}

/** Optional character-position info an error response might carry (currently only query parse/compilation errors). */
export interface FetchErrorPosition {
  readonly pos: number;
  readonly endpos: number;
  readonly line: number;
  readonly col: number;
}

export class FetchHTTPError extends FetchError {
  readonly status: number;
  /** Position info from the error response, if the error carried any (see `error_response_validator`). */
  readonly position: FetchErrorPosition | undefined;

  constructor(
    message: string | null,
    status: number,
    position?: FetchErrorPosition,
  ) {
    super(
      message != null
        ? `HTTP ${status.toString()} - ${message}`
        : `HTTP ${status.toString()}`,
    );
    this.status = status;
    this.position = position;
  }
}

export class FetchInvalidResponseError extends FetchError {
  constructor(msg: string) {
    super(`Invalid response: ${msg}`);
  }
}

const error_response_validator = object({
  error: string,
  pos: optional(number),
  endpos: optional(number),
  line: optional(number),
  col: optional(number),
});

/**
 * Fetch JSON content, also handling an HTTP error status.
 *
 * Checks for an object at the top JSON level. For errors, looks
 * for an error message like `{ "error": "error message" }`, optionally
 * with `pos`/`endpos`/`line`/`col` fields (currently only sent for query
 * parse/compilation errors, where they're real character offsets into
 * the query string - see `fava.core.query_shell`).
 */
export async function fetch_json(
  input: URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(input, init);
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = error_response_validator(json);
    const position = parsed
      .map((d) =>
        d.pos != null && d.endpos != null && d.line != null && d.col != null
          ? { pos: d.pos, endpos: d.endpos, line: d.line, col: d.col }
          : undefined,
      )
      .unwrap_or(undefined);
    throw new FetchHTTPError(
      parsed.map((d) => d.error).unwrap_or(null),
      response.status,
      position,
    );
  }
  if (!is_json_object(json)) {
    throw new FetchInvalidResponseError("Not a valid JSON object");
  }
  return json;
}

/**
 * Fetch text content, also handling an HTTP error status.
 */
export async function fetch_text(
  input: string | URL,
  init?: RequestInit,
): Promise<string> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const message = await response.text().catch(() => null);
    throw new FetchHTTPError(message, response.status);
  }
  return response.text();
}
