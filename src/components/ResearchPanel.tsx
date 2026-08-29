import { useState, useCallback } from 'react';
import { Button, Group, TextInput } from '@civitai/blocks-react/ui';
import type { ModelSearchResult } from '../lib/research.js';
import { formatStat } from '../lib/research.js';
import { token, radius, mutedText } from '../theme.js';

export interface ResearchPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  searchResults: ModelSearchResult | null;
  /** The query actually SENT for the last retrieval — not what the user typed. */
  lastQuery?: string | null;
  isSearching: boolean;
  onSearch: (query: string) => void;
  onInsert: (text: string) => void;
}

/**
 * The header control that opens/closes the panel.
 *
 * 🔴 IT LIVES IN THE HEADER'S FLEX ROW, AND THAT IS THE FIX, NOT A REFACTOR.
 * This used to be rendered by `ResearchPanel` itself, in the closed branch, as
 * `style={{ position: 'absolute', right: 8, top: 8 }}`. Absolutely positioned
 * against the page, it landed ON TOP of the ⚙️ settings button, which is
 * right-anchored in the same corner — measured at an iframe width of 1498:
 *
 *   open-research    x 1382–1490, y  8–38
 *   settings-button  x 1436–1482, y 13–43     → 46 × 25 px of overlap
 *   elementFromPoint(centre of settings-button) → "open-research"
 *
 * A real click at the centre of ⚙️ hit the Research toggle, so the Settings
 * modal — model picker, temperature, max tokens, system prompt — COULD NOT BE
 * OPENED AT ALL. Both controls are right-anchored, so this was structural, not a
 * narrow-viewport artefact.
 *
 * Being a sibling in the same `Group` is what makes overlap impossible: flex
 * lays the two out side by side and neither is taken out of flow. Do not give
 * this `position: absolute` again.
 */
export function ResearchToggle({
  isOpen,
  onToggle,
}: {
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="subtle"
      size="sm"
      onClick={onToggle}
      data-testid="open-research"
      aria-pressed={isOpen}
      title={isOpen ? 'Hide the Research panel' : 'Show the Research panel'}
    >
      🔍 Research
    </Button>
  );
}

export function ResearchPanel({
  isOpen,
  onToggle,
  searchResults,
  lastQuery,
  isSearching,
  onSearch,
  onInsert,
}: ResearchPanelProps) {
  const [query, setQuery] = useState('');

  const handleSearch = useCallback(() => {
    if (query.trim()) onSearch(query.trim());
  }, [query, onSearch]);

  // Closed: nothing. The toggle is `ResearchToggle`, in the header.
  if (!isOpen) return null;

  return (
    <div
      style={{
        width: 300,
        minWidth: 260,
        borderLeft: `1px solid ${token.border}`,
        background: token.surface,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
      data-testid="research-panel"
    >
      <div
        style={{
          padding: '12px',
          borderBottom: `1px solid ${token.border}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <strong style={{ fontSize: 14 }}>Research</strong>
        <Button variant="subtle" size="sm" onClick={onToggle} data-testid="close-research">
          ✕
        </Button>
      </div>

      <div style={{ padding: '12px' }}>
        <Group gap={8}>
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search models…"
            style={{ flex: 1 }}
            data-testid="research-search-input"
          />
          <Button size="sm" onClick={handleSearch} data-testid="research-search-button">
            Search
          </Button>
        </Group>
        {/*
          🔴 THE QUERY THAT WAS ACTUALLY SENT, not the sentence that was typed.
          For a chat turn this is the query the MODEL wrote when it called a
          catalog tool; for a panel search it is what was typed, verbatim. Either
          way a bad query is visible instead of silently poisoning an answer —
          which is exactly how the DreamShaper case went unnoticed. (It used to
          be a stopword rewrite of the sentence; `deriveSearchQuery` is gone.)
        */}
        {lastQuery ? (
          <div style={{ ...mutedText, marginTop: 8, fontSize: 11 }} data-testid="research-query">
            Searched for: <strong>{lastQuery}</strong>
          </div>
        ) : null}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
        {isSearching && (
          <div style={{ padding: '16px', textAlign: 'center', ...mutedText }}>
            Searching…
          </div>
        )}
        {!isSearching && searchResults && searchResults.items.length === 0 && (
          <div style={{ padding: '16px', textAlign: 'center', ...mutedText }}>
            No results found.
          </div>
        )}
        {searchResults?.items.map((model) => (
          <div
            key={model.id}
            style={{
              padding: '10px',
              marginBottom: 8,
              borderRadius: radius.sm,
              border: `1px solid ${token.border}`,
              background: token.body,
            }}
            data-testid={`research-result-${model.id}`}
          >
            <Group justify="space-between" align="flex-start">
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{model.name}</span>
                {/*
                  🔴 THIS LINE USED TO READ `model.stats.rating.toFixed(1)` AND
                  `model.stats.downloads.toLocaleString()`. Neither field exists:
                  the API returns `{ downloadCount, thumbsUpCount,
                  thumbsDownCount, commentCount, tippedAmountCount }`, so both
                  reads were `undefined` and each method call was a live
                  TypeError that blanked the panel on the first real result. It
                  passed CI because the fixture invented the same two fields the
                  code invented. `downloadCount` is additionally NULLABLE
                  (Creator Controls metric privacy), which is why it renders
                  through `formatStat` rather than a bare method call.
                */}
                <div style={{ ...mutedText, marginTop: 2 }}>
                  {model.type} · 👍 {formatStat(model.stats?.thumbsUpCount)} · ↓{' '}
                  {formatStat(model.stats?.downloadCount)}
                </div>
              </div>
              <Button
                size="sm"
                variant="light"
                onClick={() => onInsert(model.name)}
                data-testid={`insert-model-${model.id}`}
              >
                + Insert
              </Button>
            </Group>
          </div>
        ))}
      </div>
    </div>
  );
}
