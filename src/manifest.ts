import { defineBlock } from '@civitai/app-sdk/blocks';
import type { BlockManifest } from '@civitai/app-sdk/blocks';

import rawManifest from '../block.manifest.json';

export const manifest = rawManifest as unknown as Record<string, unknown>;

export class ManifestValidationError extends Error {
  override readonly name = 'ManifestValidationError';
}

export function validateManifest(source: Record<string, unknown> = manifest): BlockManifest {
  const iframeSource = (source.iframe ?? {}) as Record<string, unknown>;

  const augmented = {
    ...(source as object),
    appId: (source.appId as string) ?? 'app_local_sensei',
    targets: (source.targets as unknown[]) ?? [{ slotId: 'app.page', priority: 100 }],
    iframe: {
      ...iframeSource,
      src: (iframeSource.src as string) ?? 'https://sensei.civit.ai/',
    },
  } as BlockManifest;

  return defineBlock({ manifest: augmented });
}

export function manifestBuzzBudgetPerGen(
  source: Record<string, unknown> = manifest,
): number | undefined {
  const page = source.page as Record<string, unknown> | undefined;
  const v = page?.buzzBudgetPerGen;
  return typeof v === 'number' ? v : undefined;
}
