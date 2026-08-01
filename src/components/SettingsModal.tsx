import { useState } from 'react';
import { Button, Group, Modal, Stack, Textarea } from '@civitai/blocks-react/ui';
import type { AppSettings } from '../types.js';
import { token } from '../theme.js';
import { DEFAULT_SETTINGS } from '../types.js';

export interface SettingsModalProps {
  opened: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

export function SettingsModal({ opened, onClose, settings, onSave }: SettingsModalProps) {
  const [local, setLocal] = useState(settings);

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
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>System Prompt</div>
          <Textarea
            value={local.systemPrompt}
            onChange={(e) => setLocal({ ...local, systemPrompt: e.currentTarget.value })}
            rows={6}
            data-testid="system-prompt-input"
          />
          <div style={{ fontSize: 12, color: token.dimmed, marginTop: 4 }}>
            Defines Sensei's personality and capabilities.
          </div>
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
