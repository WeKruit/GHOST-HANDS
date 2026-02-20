/**
 * templateResolver — Pure function for {{variable}} to value substitution.
 *
 * Replaces all occurrences of {{key}} in a template string with the
 * corresponding value from the provided data map.
 */

/**
 * Resolve template variables in a string.
 *
 * @param template - String potentially containing {{variable}} placeholders
 * @param data - Map of variable names to values
 * @returns Resolved string with all known variables replaced
 *
 * Unknown variables (no matching key in data) are left as-is.
 */
export function resolveTemplate(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in data ? data[key] : match;
  });
}

/**
 * Resolve template variables in a value that may be undefined.
 * Returns undefined if the input is undefined.
 */
export function resolveOptionalTemplate(
  value: string | undefined,
  data: Record<string, string>,
): string | undefined {
  if (value === undefined) return undefined;
  return resolveTemplate(value, data);
}
