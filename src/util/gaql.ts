/**
 * GAQL string helpers.
 *
 * Google Ads Query Language has no parameter binding, so every value we interpolate
 * must be escaped here. GAQL string literals are single-quoted; backslash and single
 * quote are the escapable characters.
 */
export function escapeGaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Escape a value destined for a LIKE clause, neutralising the % and _ wildcards. */
export function escapeGaqlLike(value: string): string {
  return escapeGaqlString(value).replace(/[%_]/g, '');
}

/** Render a list of numeric IDs as a GAQL IN clause body. Throws on non-numeric input. */
export function gaqlIdList(ids: readonly string[]): string {
  for (const id of ids) {
    if (!/^\d{1,19}$/.test(id)) {
      throw new Error(`Refusing to interpolate non-numeric id into GAQL: ${id}`);
    }
  }
  return ids.join(', ');
}

/** Render a list of strings as a quoted GAQL IN clause body. */
export function gaqlStringList(values: readonly string[]): string {
  return values.map((v) => `'${escapeGaqlString(v)}'`).join(', ');
}
