export enum GitRefType {
  Unknown,
  Head,
  PullRequest,
  Tag
}

export type GitRef = {
  type: GitRefType;
  name?: string;
}

export function parseBool(value: string): boolean {
  value = value.trim().toLowerCase();
  if (['1', 't', 'true'].includes(value)) return true;
  else if (['0', 'f', 'false'].includes(value)) return false;

  throw new Error(`could not parse [${value}] as boolean, expected one of: 1, t, true, 0, f, false (case-insensitive)`);
}

export function parseGitRef(ref: string): GitRef {
  const [_, type, name] = ref.split('/', 3);
  if (!type || !name) return { type: GitRefType.Unknown };

  switch (type) {
    case 'heads':
      return { type: GitRefType.Head, name };
    case 'pull':
      return { type: GitRefType.PullRequest, name };
    case 'tags':
      return { type: GitRefType.Tag, name };
  }

  return { type: GitRefType.Unknown };
}
