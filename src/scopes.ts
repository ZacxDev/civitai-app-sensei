// Block-scope constants used by the app. All are declared in the manifest.
export const AI_WRITE_BUDGETED = 'ai:write:budgeted';
export const BUZZ_READ_SELF = 'buzz:read:self';
/** The document store (private `kv` collection, see `lib/kv-store.ts`). Not consent-gated. */
export const APPS_STORAGE = 'apps:storage';

export const DECLARED_SCOPES = [
  AI_WRITE_BUDGETED,
  BUZZ_READ_SELF,
  APPS_STORAGE,
] as const;

export function hasGenerateScope(tokenScopes: readonly string[] | undefined): boolean {
  return (tokenScopes ?? []).includes(AI_WRITE_BUDGETED);
}
