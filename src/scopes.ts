// Block-scope constants used by the app. All are declared in the manifest.
export const AI_WRITE_BUDGETED = 'ai:write:budgeted';
export const BUZZ_READ_SELF = 'buzz:read:self';
export const APPS_STORAGE_READ = 'apps:storage:read';
export const APPS_STORAGE_WRITE = 'apps:storage:write';

export const DECLARED_SCOPES = [
  AI_WRITE_BUDGETED,
  BUZZ_READ_SELF,
  APPS_STORAGE_READ,
  APPS_STORAGE_WRITE,
] as const;

export function hasGenerateScope(tokenScopes: readonly string[] | undefined): boolean {
  return (tokenScopes ?? []).includes(AI_WRITE_BUDGETED);
}
