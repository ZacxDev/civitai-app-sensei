import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BlockGate, injectBlocksStyles } from '@civitai/blocks-react/ui';
import { injectStyles as injectComponentStyles } from '@civitai/components-react';

import '@civitai/theme/styles.css';

import { App } from './App.js';
import { Harness } from './Harness.js';
import { RootBoundary } from './components/RootBoundary.js';
import { createRestFake } from './dev-rest.js';
import { installHarnessTransport } from './dev-transport.js';
import { configureSdkRuntime, useBlockAnalytics } from './lib/sdk-runtime.js';
import './index.css';

injectBlocksStyles();
injectComponentStyles();

function Root(): React.JSX.Element {
  const { track } = useBlockAnalytics();
  return (
    <RootBoundary onError={(error) => track('block_error', { message: error.message })}>
      <App />
    </RootBoundary>
  );
}

const useHarness = import.meta.env.VITE_DEV_HARNESS === 'true';
if (useHarness) installHarnessTransport();

// 🔴 THE HARNESS NEEDS A REST FAKE NOW, AND WITHOUT IT THE DEV LOOP IS BROKEN
// RATHER THAN DEGRADED. App storage and the four workflow operations used to be
// postMessage, which the mock host answered; after the port they are HTTP against
// `https://civitai.com/api/v1` (`@civitai/sdk`'s `DEFAULT_SITE_URL` is absolute,
// which is also why production needs no override here). From `localhost:5189` with
// a fake token those calls cannot succeed, so sessions would never persist and
// every send would fail at the estimate — two silent-looking failures in the one
// loop a developer uses to check their work.
if (useHarness) {
  configureSdkRuntime({ fetch: createRestFake() });
}

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>
    <BlockGate>{useHarness ? <Harness><Root /></Harness> : <Root />}</BlockGate>
  </StrictMode>,
);
