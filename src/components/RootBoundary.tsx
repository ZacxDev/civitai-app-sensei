import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button, Stack } from '@civitai/blocks-react/ui';
import { token, radius } from '../theme.js';

export interface RootBoundaryProps {
  children: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface RootBoundaryState {
  error: Error | null;
}

export class RootBoundary extends Component<RootBoundaryProps, RootBoundaryState> {
  override state: RootBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      this.props.onError?.(error, info);
    } catch {
      /* swallow */
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        data-testid="root-boundary-fallback"
        role="alert"
        style={{
          fontFamily: token.font,
          background: token.body,
          color: token.text,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          padding: 'clamp(16px, 4vw, 32px)',
          boxSizing: 'border-box',
        }}
      >
        <Stack
          gap={12}
          align="center"
          style={{
            maxWidth: 440,
            textAlign: 'center',
            padding: '28px 24px',
            borderRadius: radius.md,
            border: `1px solid ${token.border}`,
            background: token.surface,
          }}
        >
          <strong style={{ fontSize: 16 }}>Something went wrong</strong>
          <Alert color="error" data-testid="root-boundary-message">
            {error.message || 'The app hit an unexpected error.'}
          </Alert>
          <span style={{ color: token.dimmed, fontSize: 13, lineHeight: 1.5 }}>
            Your sessions and settings are safe. Try reloading this view.
          </span>
          <Button data-testid="root-boundary-retry" onClick={this.reset}>
            Try again
          </Button>
        </Stack>
      </div>
    );
  }
}
