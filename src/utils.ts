export function parseBool(value: string): boolean {
  value = value.trim().toLowerCase();
  if (['1', 't', 'true'].includes(value)) return true;
  else if (['0', 'f', 'false'].includes(value)) return false;

  throw new Error(`could not parse [${value}] as boolean, expected one of: 1, t, true, 0, f, false (case-insensitive)`);
}
