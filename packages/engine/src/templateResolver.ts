/** templateResolver — Pure function for {{variable}} to value substitution. */

export function resolveTemplate(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in data ? data[key] : match;
  });
}

export function resolveOptionalTemplate(
  value: string | undefined,
  data: Record<string, string>,
): string | undefined {
  if (value === undefined) return undefined;
  return resolveTemplate(value, data);
}
