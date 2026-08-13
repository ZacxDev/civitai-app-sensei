import { useState, useCallback } from 'react';
import { Button, Group, TextInput } from '@civitai/blocks-react/ui';
import type { ModelSearchResult } from '../lib/research.js';
import { formatStat } from '../lib/research.js';
import { token, radius, mutedText } from '../theme.js';

export interface ResearchPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  searchResults: ModelSearchResult | null;
  isSearching: boolean;
  onSearch: (query: string) => void;
  onInsert: (text: string) => void;
}

export function ResearchPanel({
  isOpen,
  onToggle,
  searchResults,
  isSearching,
  onSearch,
  onInsert,
}: ResearchPanelProps) {
  const [query, setQuery] = useState('');

  const handleSearch = useCallback(() => {
    if (query.trim()) onSearch(query.trim());
  }, [query, onSearch]);

  if (!isOpen) {
    return (
      <Button
        variant="subtle"
        size="sm"
        onClick={onToggle}
        data-testid="open-research"
        style={{ position: 'absolute', right: 8, top: 8 }}
      >
        🔍 Research
      </Button>
    );
  }

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
