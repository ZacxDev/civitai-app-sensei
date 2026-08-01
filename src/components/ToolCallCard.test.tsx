import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallCard } from './ToolCallCard.js';
import type { ToolCall } from '../types.js';

const mockToolCall: ToolCall = {
  id: 'tc-1',
  type: 'function',
  function: {
    name: 'search_models',
    arguments: '{"query":"anime","limit":5}',
  },
};

describe('ToolCallCard', () => {
  it('renders tool name', () => {
    render(<ToolCallCard toolCall={mockToolCall} />);
    expect(screen.getByText('search_models')).toBeTruthy();
  });

  it('shows collapsed by default', () => {
    render(<ToolCallCard toolCall={mockToolCall} />);
    expect(screen.queryByTestId('tool-call-args')).toBeNull();
  });

  it('expands on click', () => {
    render(<ToolCallCard toolCall={mockToolCall} />);
    fireEvent.click(screen.getByTestId('tool-call-card'));
    expect(screen.getByTestId('tool-call-args')).toBeTruthy();
    expect(screen.getByText(/"query"/)).toBeTruthy();
  });

  it('collapses on second click', () => {
    render(<ToolCallCard toolCall={mockToolCall} />);
    fireEvent.click(screen.getByTestId('tool-call-card'));
    fireEvent.click(screen.getByTestId('tool-call-card'));
    expect(screen.queryByTestId('tool-call-args')).toBeNull();
  });
});
