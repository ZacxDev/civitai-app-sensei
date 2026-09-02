import { useEffect, useState } from 'react';
import { Button, Group, Modal, Slider, Stack, Textarea } from '@civitai/blocks-react/ui';
import type { AppSettings } from '../types.js';
import { token, metaText } from '../theme.js';
import { DEFAULT_SETTINGS } from '../types.js';

export interface SettingsModalProps {
  opened: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

/**
 * 🔴 THE TUNING CONTROLS LIVE HERE NOW — see `SettingsBar` for why they moved.
 * Their testids (`temperature-slider`, `max-tokens-slider`) are carried over
 * UNCHANGED rather than renamed, so anything holding them still resolves; what
 * changed is that they are behind the settings button instead of on the app's
 * bottom edge at all times.
 */
export function SettingsModal({ opened, onClose, settings, onSave }: SettingsModalProps) {
  const [local, setLocal] = useState(settings);

  // 🔴 RE-SEED ON OPEN. `useState(settings)` only reads its argument on the
  // FIRST render, and this component is mounted for the app's whole life — so
  // before the sliders moved in here, a dialog opened after any settings change
  // showed the values as they were at mount. That was invisible while the only
  // field was a system prompt nobody edited twice; with `model`, `temperature`
  // and `maxTokens` all reachable from two places it would silently write a
  // stale value back over a fresh one on Save.
  useEffect(() => {
    if (opened) setLocal(settings);
  }, [opened, settings]);

  const handleSave = () => {
    onSave(local);
    onClose();
  };

  const handleReset = () => {
    setLocal(DEFAULT_SETTINGS);
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Settings"
      size="lg"
      data-testid="settings-modal"
    >
      <Stack gap={16}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>System prompt</div>
          {/* 🔴 "Defines Sensei's personality and capabilities." was deleted from
              under this box. A labelled textarea in a Settings dialog does not
              need a sentence telling the reader that typing in it changes how
              the assistant behaves. */}
          <Textarea
            value={local.systemPrompt}
            onChange={(e) => setLocal({ ...local, systemPrompt: e.currentTarget.value })}
            rows={6}
            data-testid="system-prompt-input"
          />
        </div>

        <div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Reply tuning</div>
          <Stack gap={12}>
            <TuningRow
              label="Temperature"
              value={local.temperature.toFixed(1)}
              hint="Lower is more literal, higher is more inventive."
            >
              <Slider
                min={0}
                max={2}
                step={0.1}
                value={local.temperature}
                onChange={(v) => setLocal({ ...local, temperature: v })}
                data-testid="temperature-slider"
              />
            </TuningRow>
            <TuningRow
              label="Max tokens"
              value={String(local.maxTokens)}
              // Not an explainer for the control — a fact about SPEND that the
              // control does not show. Measured in `lib/models.ts`: the same
              // conversation quotes 1 Buzz at 256 and 6 at 4,000.
              hint="A longer ceiling costs more Buzz per reply."
            >
              {/*
                🔴 CEILING IS THE HOST'S, NOT A UI CHOICE. `chat-completion`
                bounds `maxTokens` at 4,000 (`.max(CHAT_COMPLETION_MAX_OUTPUT_
                TOKENS)`), so a higher ceiling here lets a viewer drag the slider
                into a guaranteed BAD_REQUEST. Mirrors `MAX_OUTPUT_TOKENS` in
                lib/orchestrator-bridge.ts.
              */}
              <Slider
                min={256}
                max={4000}
                step={256}
                value={local.maxTokens}
                onChange={(v) => setLocal({ ...local, maxTokens: v })}
                data-testid="max-tokens-slider"
              />
            </TuningRow>
          </Stack>
        </div>

        <Group justify="flex-end" gap={8}>
          <Button variant="subtle" onClick={handleReset} data-testid="reset-defaults">
            Reset Defaults
          </Button>
          <Button onClick={handleSave} data-testid="save-settings">
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function TuningRow({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 2 }}>
        <span style={{ fontSize: 13 }}>{label}</span>
        <span style={{ fontSize: 13, color: token.dimmed, fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </span>
      </div>
      {children}
      <div style={{ ...metaText, marginTop: 2 }}>{hint}</div>
    </div>
  );
}
