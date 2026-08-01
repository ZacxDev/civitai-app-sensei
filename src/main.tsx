import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useBlockAnalytics } from '@civitai/blocks-react';
import { BlockGate, injectBlocksStyles } from '@civitai/blocks-react/ui';
import { injectStyles as injectComponentStyles } from '@civitai/components-react';

import '@civitai/theme/styles.css';

import { App } from './App.js';
import { Harness } from './Harness.js';
import { RootBoundary } from './components/RootBoundary.js';
import { installHarnessTransport } from './dev-transport.js';
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

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>
    <BlockGate>{useHarness ? <Harness><Root /></Harness> : <Root />}</BlockGate>
  </StrictMode>,
);
