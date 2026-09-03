import { Select } from '@civitai/blocks-react/ui';
import type { AppSettings } from '../types.js';
import { AVAILABLE_MODELS } from '../lib/models.js';
import { token, metaText } from '../theme.js';

export interface SettingsBarProps {
  settings: AppSettings;
  onChange: (settings: Partial<AppSettings>) => void;
  /** Open the settings dialog, where the tuning controls now live. */
  onOpenSettings: () => void;
}

/**
 * THE FOOTER STRIP — DEMOTED, AND ONE CONTROL SHORTER THAN IT WAS.
 *
 * 🔴 WHAT MOVED AND WHY. This bar used to carry the model select, a temperature
 * slider and a max-tokens slider, at full height, on a raised surface, spanning
 * the width of the app — the same visual weight as the conversation above it.
 * Three power-user knobs level with the product's entire reason for existing.
 *
 * `temperature` and `maxTokens` are now in the Settings dialog beside the system
 * prompt, which is where the app's other tuning already lived. The MODEL stays
 * here because it is not a tuning knob: it decides what a reply COSTS (measured
 * 2 to 4 Buzz for the same conversation across the three, see `lib/models.ts`)
 * and it is a per-question decision, so hiding it behind a dialog would hide a
 * spend choice.
 *
 * 🔴 `data-testid="settings-bar"` AND `data-testid="model-selector"` ARE
 * DELIBERATELY UNCHANGED. The app-capture recipe for this app names
 * `settings-bar` as an alternative ready anchor and its crop rect is measured
 * to end just under this strip; renaming either would break a coupling that no
 * gate in either repo can see. `temperature-slider` and `max-tokens-slider` DO
 * move — into the dialog — which is reported with the pass rather than left for
 * a re-shoot to discover.
 */
export function SettingsBar({ settings, onChange, onOpenSettings }: SettingsBarProps) {
  const modelOptions = AVAILABLE_MODELS.map((m) => ({
    value: m.id,
    label: m.name,
  })) as Array<{ value: string; label: string }>;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        // Half the old vertical padding, and on the BODY colour rather than the
        // raised `surface` the conversation panel uses — so the strip reads as
        // the floor of the app rather than as a second panel of equal standing.
        padding: '5px 12px',
        borderTop: `1px solid ${token.border}`,
        background: token.body,
        flexShrink: 0,
      }}
      data-testid="settings-bar"
    >
      <span style={{ ...metaText, fontSize: 11 }}>Model</span>
      <div style={{ minWidth: 170 }}>
        <Select
          options={modelOptions}
          value={settings.model}
          onChange={(v) => onChange({ model: v })}
          data-testid="model-selector"
        />
      </div>
      <div style={{ flex: 1 }} />
      {/*
        The one thing the removed sliders leave behind: a way to reach them.
        Text, not a button — it is a pointer to somewhere else, and giving it
        button chrome would re-inflate exactly the weight this change removed.
      */}
      <button
        type="button"
        onClick={onOpenSettings}
        style={{
          ...metaText,
          fontSize: 11,
          background: 'none',
          border: 'none',
          padding: '2px 4px',
          cursor: 'pointer',
          textDecoration: 'underline',
          textUnderlineOffset: 2,
        }}
        data-testid="open-tuning"
      >
        Prompt &amp; tuning
      </button>
    </div>
  );
}
