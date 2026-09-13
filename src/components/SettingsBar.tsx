import type { AppSettings } from '../types.js';
import { NSFW_MODEL_ID, SFW_MODEL_ID } from '../lib/models.js';
import { token, metaText, radius, brand } from '../theme.js';

export interface SettingsBarProps {
  settings: AppSettings;
  onChange: (settings: Partial<AppSettings>) => void;
  /** Open the settings dialog, where the tuning controls now live. */
  onOpenSettings: () => void;
  /**
   * Whether this viewer may be offered the uncensored arm.
   *
   * 🔴 A REQUIRED PROP, NOT A HOOK CALL IN HERE, AND NOT OPTIONAL. Required
   * because the only safe-looking default would be `false` — which would silently
   * hide the toggle from every viewer entitled to it the moment a caller forgot
   * the prop, i.e. ship the feature as dead code with the whole suite green. A
   * prop rather than a local `useDomainMaturity()` because `App` needs the SAME
   * answer to CLAMP the model it puts on the wire: hiding a control is not a
   * guard, and two independent reads of the gate are two things that can disagree.
   * One read, one owner, passed down.
   */
  nsfwAllowed: boolean;
}

/**
 * THE FOOTER STRIP — the model SELECT is gone, replaced by an NSFW-mode toggle.
 *
 * 🔴 WHAT MOVED AND WHY, HISTORICALLY. This bar used to carry the model select, a
 * temperature slider and a max-tokens slider at full height on a raised surface.
 * `temperature` and `maxTokens` are in the Settings dialog beside the system
 * prompt. The MODEL stayed here because it is not a tuning knob — it decides what
 * a reply COSTS and it is a per-question decision, so hiding it behind a dialog
 * would hide a spend choice.
 *
 * 🔴 AND WHY A THREE-ITEM DROPDOWN BECAME A BINARY TOGGLE. "DeepSeek V3 / GPT-4o
 * mini / Dolphin Mistral 24B (uncensored)" asked the viewer to make a decision
 * they have no basis for: two of the three differ only in price and neither name
 * says so, while the third differs in something that actually matters and the word
 * "(uncensored)" in a dropdown option is the only place it said so. The real
 * choice is "do you want the grounded model or the uncensored one", which is one
 * switch with an explanation attached.
 *
 * 🔴 `data-testid="model-selector"` IS GONE, AND IT WAS DOCUMENTED AS LOAD-BEARING.
 * The app-capture recipe in `datapacket-talos` names it, and this file's previous
 * header said renaming it "would break a coupling that no gate in either repo can
 * see". Removing the control removes the testid; there is no honest way to keep it
 * — a `model-selector` on a thing that is not a model selector is worse than its
 * absence. `data-testid="settings-bar"` is UNCHANGED, and it is the recipe's ready
 * anchor and crop reference, so the anchor half of the coupling survives. The
 * consequence is reported with the PR, not left for a re-shoot to discover, and
 * `taste.json` records it.
 */
export function SettingsBar({
  settings,
  onChange,
  onOpenSettings,
  nsfwAllowed,
}: SettingsBarProps) {
  const nsfwOn = settings.model === NSFW_MODEL_ID;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        // Wraps rather than ellipsising: the note below is a DISCLOSURE about
        // what the viewer gives up and what they are still charged for, and a
        // truncated warning is a warning that lies. Better a two-line strip on a
        // narrow pane than a cut-off sentence.
        flexWrap: 'wrap',
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
      {/*
        🔴 RENDERED ONLY WHEN THE VIEWER MAY BE OFFERED IT, AND THE GATE FAILS
        CLOSED. `nsfwAllowed` comes from `useDomainMaturity().isLevelAllowed`,
        which answers SFW-only before `BLOCK_INIT` lands and against a host that
        projects no ceiling — so this is absent during boot and on an old host
        rather than flashing an uncensored affordance for the width of a
        handshake. See `lib/maturity.ts` for why the bit is `X` and why the
        `domain` string is the wrong input.

        🔴 ABSENT, NOT DISABLED. A disabled switch labelled "NSFW mode" tells a
        viewer on a green domain that this app has an uncensored mode they cannot
        have — an advertisement for something the platform has decided they will
        not be shown, on a surface that cannot explain why.
      */}
      {nsfwAllowed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <button
            type="button"
            // `role="switch"` + `aria-checked` rather than a checkbox: this is a
            // binary on/off with immediate effect, which is what a switch IS, and
            // it is announced as such rather than as a form field awaiting submit.
            role="switch"
            aria-checked={nsfwOn}
            aria-label="NSFW mode"
            data-testid="nsfw-toggle"
            onClick={() => onChange({ model: nsfwOn ? SFW_MODEL_ID : NSFW_MODEL_ID })}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'none',
              border: 'none',
              padding: '2px 4px',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 11,
              color: token.text,
            }}
          >
            {/*
              The track. `aria-hidden` because `role="switch"` + `aria-checked`
              already carries the state — and the state is never carried by colour
              alone, because the knob MOVES as well as the track changing tint.
            */}
            <span
              aria-hidden="true"
              style={{
                width: 26,
                height: 14,
                borderRadius: 999,
                background: nsfwOn ? brand.plate : token.border,
                display: 'inline-flex',
                alignItems: 'center',
                padding: 2,
                boxSizing: 'border-box',
                justifyContent: nsfwOn ? 'flex-end' : 'flex-start',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: nsfwOn ? brand.onPlate : token.surface,
                }}
              />
            </span>
            NSFW mode
          </button>
          {/*
            🔴 THE COPY IS THE ONLY MITIGATION THAT EXISTS, so it is visible
            BEFORE the flip rather than after it, and it names all three costs.

            Dolphin cannot call tools — its only OpenRouter endpoint (Venice) does
            not expose them, though the model's own weights implement Mistral tool
            calling. OpenRouter treats `tools` as a SOFT preference, so
            declarations are silently dropped and THE VIEWER IS STILL CHARGED. So
            in this mode the model cannot search the catalog, it answers from its
            own knowledge, and the citation gate strips any model link it invents.
            The viewer is trading catalog grounding for an uncensored model; they
            should know that before they flip it, not after.
          */}
          <span data-testid="nsfw-mode-note" style={{ ...metaText, fontSize: 11, minWidth: 0 }}>
            Uncensored answers, but no catalog: this model can’t look anything up, so it answers
            from its own knowledge and any model link it writes is stripped. Replies cost Buzz
            either way.
          </span>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 12 }} />
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
          borderRadius: radius.sm,
        }}
        data-testid="open-tuning"
      >
        Prompt &amp; tuning
      </button>
    </div>
  );
}
