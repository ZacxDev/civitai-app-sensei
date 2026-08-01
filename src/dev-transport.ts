import { getTransport } from '@civitai/blocks-react';
import { resetTransport } from '@civitai/blocks-react/testing';

export function installHarnessTransport() {
  getTransport({ allowedParentOrigins: [window.location.origin] });
}

export function resetHarnessTransport() {
  resetTransport();
  getTransport({ allowedParentOrigins: [window.location.origin] });
}
