import rawManifest from '../block.manifest.json';

export const manifest = rawManifest as unknown as Record<string, unknown>;

/* 🔴 `validateManifest` AND `ManifestValidationError` WERE REMOVED HERE, BECAUSE
   `@civitai/app-sdk` MOVED THE VALIDATOR SOMEWHERE THIS MODULE CANNOT IMPORT IT
   FROM. Stated so a reviewer can object on the facts rather than on the diff.

   WHAT MOVED. `defineBlock` left `@civitai/app-sdk/blocks` for
   `@civitai/app-sdk/manifest` in the release that closed starters#330 — before
   `0.49.0`, which is the FLOOR `@civitai/blocks-react@0.62.0`'s peer range
   (`>=0.49.0 <1.0.0`) admits, so no admissible version of the SDK still exports
   it from `/blocks`. Checked by reading `0.49.0`'s own `dist/blocks/index.d.ts`
   out of its npm tarball rather than inferred from the peer floor; that file
   carries the migration note in its own words.

   WHY NOT JUST REPOINT THE IMPORT. The new subpath is NODE-ONLY by design and
   upstream says so on the export it removed: validation now compiles the
   vendored canonical schema with Ajv, which needs `node:fs` plus a runtime
   dependency, "neither of which belongs on this browser-facing,
   zero-dependency surface". `src/manifest.ts` is browser-surface code and is
   imported by `src/listing-claims.seam.test.tsx`, which runs in jsdom — a
   top-level `node:fs` import there does not work. So repointing is not a
   smaller change than this one; it is a different module layout plus an `ajv`
   devDependency.

   WHY DELETING LOSES NOTHING TODAY. `validateManifest` had ZERO callers and
   `ManifestValidationError` was never thrown or caught anywhere — grep both
   names across `src/` and `eval/` and the only hits were their own
   declarations. The live exports of this module are `manifest`, which
   `listing-claims.seam.test.tsx` reads, and `manifestBuzzBudgetPerGen` below.
   Nothing validated the manifest at build time before this commit either: the
   function was never wired into `pnpm build`.

   🔴 AND IT WOULD NOT HAVE PASSED THE NEW VALIDATOR AS WRITTEN. The body above
   augmented the manifest with `iframe.src` — which the 0.49+ validator now
   REFUSES as one of its declared `SCHEMA_DIVERGENCES` ("the platform refuses
   it"), along with the `appId` the canonical schema does not declare. So this
   was not a working validator waiting for a one-line import fix.

   THE UPSTREAM-RECOMMENDED REPLACEMENT, if build-time validation is wanted:
   `@civitai/app-sdk/vite` ("most callers want the Vite plugin rather than the
   function"), added to `vite.config.ts`, which runs in Node where the subpath
   is usable. That is strictly MORE coverage than the dead function provided and
   it is deliberately NOT bundled into this dependency bump — it needs an `ajv`
   devDependency and it can fail `pnpm build` on a manifest the stricter rules
   reject, which is a reviewable behaviour change rather than bookkeeping. */

export function manifestBuzzBudgetPerGen(
  source: Record<string, unknown> = manifest,
): number | undefined {
  const page = source.page as Record<string, unknown> | undefined;
  const v = page?.buzzBudgetPerGen;
  return typeof v === 'number' ? v : undefined;
}
