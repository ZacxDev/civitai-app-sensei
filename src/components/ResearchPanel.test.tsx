import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResearchPanel } from './ResearchPanel.js';
import type { ModelSearchResult } from '../lib/research.js';
import { BLOCK_MODEL_ITEM, BLOCK_MODEL_ITEM_HIDDEN_STATS } from '../test-helpers.js';

/**
 * 🔴 THE FIXTURE IS THE ENDPOINT'S SHAPE, NOT THE COMPONENT'S WISH. This file
 * used to build `stats: { downloads: 100, rating: 4.5 }` — fields the API has
 * never returned — while the component read exactly those two. Both sides were
 * wrong in the same direction, so every render test passed and the panel threw
 * on the first real response.
 */
const REAL_RESULTS: ModelSearchResult = { items: [BLOCK_MODEL_ITEM] };

describe('ResearchPanel', () => {
  it('renders toggle button when closed', () => {
    render(
      <ResearchPanel
        isOpen={false}
        onToggle={vi.fn()}
        searchResults={null}
        isSearching={false}
        onSearch={vi.fn()}
        onInsert={vi.fn()}
      />,
    );
    expect(screen.getByTestId('open-research')).toBeTruthy();
  });

  it('renders panel when open', () => {
    render(
      <ResearchPanel
        isOpen={true}
        onToggle={vi.fn()}
        searchResults={null}
        isSearching={false}
        onSearch={vi.fn()}
        onInsert={vi.fn()}
      />,
    );
    expect(screen.getByTestId('research-panel')).toBeTruthy();
    expect(screen.getByTestId('research-search-input')).toBeTruthy();
  });

  it('calls onSearch when clicking search button', () => {
    const onSearch = vi.fn();
    render(
      <ResearchPanel
        isOpen={true}
        onToggle={vi.fn()}
        searchResults={null}
        isSearching={false}
        onSearch={onSearch}
        onInsert={vi.fn()}
      />,
    );
    const input = screen.getByTestId('research-search-input');
    fireEvent.change(input, { target: { value: 'anime' } });
    fireEvent.click(screen.getByTestId('research-search-button'));
    expect(onSearch).toHaveBeenCalledWith('anime');
  });

  it('calls onSearch on Enter', () => {
    const onSearch = vi.fn();
    render(
      <ResearchPanel
        isOpen={true}
        onToggle={vi.fn()}
        searchResults={null}
        isSearching={false}
        onSearch={onSearch}
        onInsert={vi.fn()}
      />,
    );
    const input = screen.getByTestId('research-search-input');
    fireEvent.change(input, { target: { value: 'lora' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSearch).toHaveBeenCalledWith('lora');
  });

  it('shows searching indicator', () => {
    render(
      <ResearchPanel
        isOpen={true}
        onToggle={vi.fn()}
        searchResults={null}
        isSearching={true}
        onSearch={vi.fn()}
        onInsert={vi.fn()}
      />,
    );
    expect(screen.getByText('Searching…')).toBeTruthy();
  });

  it('renders REAL search results without throwing on the real stats shape', () => {
    render(
      <ResearchPanel
        isOpen={true}
        onToggle={vi.fn()}
        searchResults={REAL_RESULTS}
        isSearching={false}
        onSearch={vi.fn()}
        onInsert={vi.fn()}
      />,
    );
    expect(screen.getByText('Test Model')).toBeTruthy();
    expect(screen.getByText(/Checkpoint/)).toBeTruthy();
    // The stats the API actually sends: thumbsUpCount + downloadCount.
    expect(screen.getByText(/👍 42/)).toBeTruthy();
    expect(screen.getByText(/1,000/)).toBeTruthy();
  });

  it('renders a NULL downloadCount as "hidden" instead of crashing', () => {
    // Creator Controls metric privacy nulls this per-owner. The old code called
    // `.toLocaleString()` on it unguarded.
    render(
      <ResearchPanel
        isOpen={true}
        onToggle={vi.fn()}
        searchResults={{ items: [BLOCK_MODEL_ITEM_HIDDEN_STATS] }}
        isSearching={false}
        onSearch={vi.fn()}
        onInsert={vi.fn()}
      />,
    );
    expect(screen.getByText('Private Stats Model')).toBeTruthy();
    expect(screen.getByText(/hidden/)).toBeTruthy();
  });

  it('calls onInsert when clicking insert button', () => {
    const onInsert = vi.fn();
    render(
      <ResearchPanel
        isOpen={true}
        onToggle={vi.fn()}
        searchResults={REAL_RESULTS}
        isSearching={false}
        onSearch={vi.fn()}
        onInsert={onInsert}
      />,
    );
    fireEvent.click(screen.getByTestId('insert-model-1234'));
    expect(onInsert).toHaveBeenCalledWith('Test Model');
  });

  it('shows no results message', () => {
    const results: ModelSearchResult = { items: [] };
    render(
      <ResearchPanel
        isOpen={true}
        onToggle={vi.fn()}
        searchResults={results}
        isSearching={false}
        onSearch={vi.fn()}
        onInsert={vi.fn()}
      />,
    );
    expect(screen.getByText('No results found.')).toBeTruthy();
  });
});
