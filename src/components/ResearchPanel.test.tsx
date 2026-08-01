import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResearchPanel } from './ResearchPanel.js';
import type { ModelSearchResult } from '../lib/research.js';

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

  it('renders search results', () => {
    const results: ModelSearchResult = {
      items: [
        { id: 1, name: 'Test Model', type: 'Checkpoint', stats: { downloads: 100, rating: 4.5 } },
      ],
    };
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
    expect(screen.getByText('Test Model')).toBeTruthy();
    expect(screen.getByText(/Checkpoint/)).toBeTruthy();
  });

  it('calls onInsert when clicking insert button', () => {
    const onInsert = vi.fn();
    const results: ModelSearchResult = {
      items: [
        { id: 1, name: 'Test Model', type: 'Checkpoint', stats: { downloads: 100, rating: 4.5 } },
      ],
    };
    render(
      <ResearchPanel
        isOpen={true}
        onToggle={vi.fn()}
        searchResults={results}
        isSearching={false}
        onSearch={vi.fn()}
        onInsert={onInsert}
      />,
    );
    fireEvent.click(screen.getByTestId('insert-model-1'));
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
