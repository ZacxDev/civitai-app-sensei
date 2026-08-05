import { Select, Slider } from '@civitai/blocks-react/ui';
import type { AppSettings } from '../types.js';
import { AVAILABLE_MODELS } from '../lib/models.js';
import { token } from '../theme.js';

export interface SettingsBarProps {
  settings: AppSettings;
  onChange: (settings: Partial<AppSettings>) => void;
}

export function SettingsBar({ settings, onChange }: SettingsBarProps) {
  const modelOptions = AVAILABLE_MODELS.map((m) => ({
    value: m.id,
    label: m.name,
  })) as Array<{ value: string; label: string }>;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '8px 16px',
        borderTop: `1px solid ${token.border}`,
        background: token.surface,
        flexWrap: 'wrap',
      }}
      data-testid="settings-bar"
    >
      <div style={{ minWidth: 180 }}>
        <Select
          options={modelOptions}
          value={settings.model}
          onChange={(v) => onChange({ model: v })}
          data-testid="model-selector"
        />
      </div>
      <div style={{ minWidth: 120, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: token.dimmed, whiteSpace: 'nowrap' }}>
          Temp
        </span>
        <Slider
          min={0}
          max={2}
          step={0.1}
          value={settings.temperature}
          onChange={(v) => onChange({ temperature: v })}
          style={{ flex: 1 }}
          data-testid="temperature-slider"
        />
        <span style={{ fontSize: 12, color: token.dimmed, minWidth: 28, textAlign: 'right' }}>
          {settings.temperature.toFixed(1)}
        </span>
      </div>
      <div style={{ minWidth: 120, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: token.dimmed, whiteSpace: 'nowrap' }}>
          Max Tokens
        </span>
        {/*
          🔴 CEILING IS THE HOST'S, NOT A UI CHOICE. `chat-completion` bounds
          `maxTokens` at 4,000 (`.max(CHAT_COMPLETION_MAX_OUTPUT_TOKENS)`), so
          the old 8,192 ceiling let a user drag the slider into a guaranteed
          BAD_REQUEST. Mirrors `MAX_OUTPUT_TOKENS` in lib/orchestrator-bridge.ts.
        */}
        <Slider
          min={256}
          max={4000}
          step={256}
          value={settings.maxTokens}
          onChange={(v) => onChange({ maxTokens: v })}
          style={{ flex: 1 }}
          data-testid="max-tokens-slider"
        />
        <span style={{ fontSize: 12, color: token.dimmed, minWidth: 40, textAlign: 'right' }}>
          {settings.maxTokens}
        </span>
      </div>
    </div>
  );
}
