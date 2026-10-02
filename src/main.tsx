import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BlockGate, injectBlocksStyles } from '@civitai/blocks-react/ui';

import '@civitai/theme/styles.css';

import { App } from './App.js';
import { Harness } from './Harness.js';
import { RootBoundary } from './components/RootBoundary.js';
import { createRestFake } from './dev-rest.js';
import { installHarnessTransport } from './dev-transport.js';
import { configureSdkRuntime, useBlockAnalytics } from './lib/sdk-runtime.js';
import './index.css';

// 🔴 THE SECOND INJECTOR IS GONE, AND IT WAS ALREADY A NO-OP BEFORE IT WENT.
// This used to read `injectBlocksStyles(); injectComponentStyles();`, the second
// from `@civitai/components-react`. `@civitai/components-react@0.9.x` is a
// rewrite — attribute-driven `data-civitai-ui` markup replaced by `<civitai-*>`
// custom elements that are self-styling (shadow DOM `:host` rules reading
// `--civitai-*`, tokens injected by `CivitaiElement.connectedCallback()`), so
// there is no stylesheet to import and `injectStyles` is no longer exported at
// all. Removing the call is forced.
//
// It also costs nothing, which was MEASURED IN THIS REPO BEFORE THIS BUMP and is
// written up at the top of `src/civitai-dependency-lockstep.test.ts`: both
// packages spell their marker `data-civitai-components`, so the second caller's
// `querySelector` finds the first caller's sheet and returns early. FIRST WRITER
// WINS, and `injectBlocksStyles()` is the first writer. Probed in jsdom, exactly
// three `<style>` elements landed either way. Do not re-derive "two injectors,
// both inject" — that was measured false.
injectBlocksStyles();

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
