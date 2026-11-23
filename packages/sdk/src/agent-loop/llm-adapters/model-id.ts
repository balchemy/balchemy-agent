/** Provider model IDs: 1-160 characters of letters, digits, `.`, `_`, `:` and `-`, optionally in `/`-separated segments
 * (OpenRouter's `vendor/model`). Every ID the earlier pattern accepted is still accepted; an empty segment or a leading or
 * trailing `/` is refused. The ID is only ever sent in a JSON request body, never in a URL. */
const MODEL_ID = /^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/;

export function isLlmModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 160 && MODEL_ID.test(value);
}
