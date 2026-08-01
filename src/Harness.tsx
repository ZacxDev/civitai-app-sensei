import type { ReactNode } from 'react';
import { Harness as SdkHarness } from '@civitai/blocks-react/testing';

export function Harness({ children }: { children: ReactNode }) {
  return (
    <SdkHarness
      viewer={{ id: 99, username: 'me' }}
      theme="dark"
      consentGranted
      buzzBudget={50}
      buzz={{ balance: 5000 }}
      buzzBalance={{ blue: 1200, green: 0, yellow: 5000 }}
    >
      {children}
    </SdkHarness>
  );
}
