export const MERGE_FIELDS = ['first_name', 'last_name', 'company', 'email'] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Partial<Record<MergeField, string | null | undefined>>;

const ANY_TOKEN = /\{\{[^{}]*\}\}/g;
const STRICT_TOKEN = /^\{\{\s*([a-z_]+)\s*(?:\|([^{}]*))?\}\}$/;

function isMergeField(value: string): value is MergeField {
  return (MERGE_FIELDS as readonly string[]).includes(value);
}

/**
 * Anything that looks like a merge field but is not a supported one, such as `{{ firstname }}`.
 * These are rejected when a campaign is saved so a typo never reaches a recipient as literal text.
 */
export function findInvalidTokens(text: string): string[] {
  const invalid: string[] = [];
  for (const token of text.match(ANY_TOKEN) ?? []) {
    const match = STRICT_TOKEN.exec(token);
    if (!match || !isMergeField(match[1]!)) invalid.push(token);
  }
  return [...new Set(invalid)];
}

/** Replaces `{{first_name}}` or `{{first_name|there}}`, using the fallback when the value is empty. */
export function renderTemplate(text: string, values: MergeValues): string {
  return text.replace(ANY_TOKEN, (token) => {
    const match = STRICT_TOKEN.exec(token);
    if (!match || !isMergeField(match[1]!)) return token;
    const value = values[match[1]]?.trim();
    return value ? value : (match[2]?.trim() ?? '');
  });
}

export function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}
