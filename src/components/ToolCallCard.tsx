import { useState, type ReactNode } from 'react';
import { Group } from '@civitai/blocks-react/ui';
import type { ToolCall, Message } from '../types.js';
import { parseToolArguments } from '../lib/tools.js';
import { token, radius } from '../theme.js';

export interface ToolCallCardProps {
  toolCall: ToolCall;
  result?: Message;
  isLoading?: boolean;
}

interface ModelItem {
  id: number;
  name: string;
  type: string;
  description?: string;
  stats?: {
    downloadCount?: number;
    downloads?: number;
    thumbsUpCount?: number;
    rating?: number;
  };
  images?: Array<{ url: string; nsfwLevel?: number }>;
  modelVersions?: Array<{ id: number; name: string; baseModel: string }>;
}

interface ModelDetailItem extends ModelItem {
  tags?: string[];
  modelVersions: Array<{ id: number; name: string; baseModel: string }>;
}

interface ImageItem {
  id: number;
  url: string;
  width?: number;
  height?: number;
  stats?: { reactionCount?: number; commentCount?: number };
}

function tryParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function formatNumber(n: number | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function getDownloads(model: ModelItem): number {
  return model.stats?.downloadCount ?? model.stats?.downloads ?? 0;
}

function getRating(model: ModelItem): number {
  return model.stats?.thumbsUpCount ?? model.stats?.rating ?? 0;
}

function getThumbnail(model: ModelItem): string | null {
  const img = model.images?.[0];
  if (!img) return null;
  return img.url;
}

function ModelCard({ model }: { model: ModelItem }) {
  const thumbnail = getThumbnail(model);
  return (
    <div
      style={{
        border: `1px solid ${token.border}`,
        borderRadius: radius.sm,
        overflow: 'hidden',
        background: token.surface,
        fontSize: 12,
      }}
    >
      {thumbnail && (
        <img
          src={thumbnail}
          alt={model.name}
          style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }}
          loading="lazy"
        />
      )}
      <div style={{ padding: '6px 8px' }}>
        <div style={{ fontWeight: 600, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {model.name}
        </div>
        <div style={{ color: token.dimmed, fontSize: 11, marginBottom: 4 }}>
          {model.type}
        </div>
        <div style={{ display: 'flex', gap: 8, color: token.dimmed, fontSize: 11 }}>
          <span>⬇ {formatNumber(getDownloads(model))}</span>
          <span>⭐ {formatNumber(getRating(model))}</span>
        </div>
      </div>
    </div>
  );
}

function ModelGrid({ models }: { models: ModelItem[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
      {models.map((m) => (
        <ModelCard key={m.id} model={m} />
      ))}
    </div>
  );
}

function ModelDetailCard({ model }: { model: ModelDetailItem }) {
  return (
    <div
      style={{
        border: `1px solid ${token.border}`,
        borderRadius: radius.sm,
        padding: 12,
        background: token.surface,
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{model.name}</div>
      <div style={{ color: token.dimmed, fontSize: 11, marginBottom: 8 }}>{model.type}</div>
      {model.description && (
        <div style={{ marginBottom: 8, lineHeight: 1.5, color: token.text }}>
          {model.description}
        </div>
      )}
      {model.tags && model.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {model.tags.map((tag) => (
            <span
              key={tag}
              style={{
                padding: '2px 6px',
                borderRadius: 4,
                background: token.primaryLight,
                color: token.primary,
                fontSize: 11,
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      {model.modelVersions && model.modelVersions.length > 0 && (
        <div style={{ color: token.dimmed, fontSize: 11 }}>
          <strong>Versions:</strong>{' '}
          {model.modelVersions.map((v) => `${v.name} (${v.baseModel})`).join(', ')}
        </div>
      )}
    </div>
  );
}

function ImageGrid({ images }: { images: ImageItem[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6 }}>
      {images.map((img) => (
        <img
          key={img.id}
          src={img.url}
          alt={`Image ${img.id}`}
          style={{
            width: '100%',
            height: 120,
            objectFit: 'cover',
            borderRadius: radius.sm,
            display: 'block',
          }}
          loading="lazy"
        />
      ))}
    </div>
  );
}

function NsfwResultBlock({ content }: { content: string }) {
  return (
    <div
      style={{
        border: `1px solid ${token.error}`,
        borderRadius: radius.sm,
        padding: 10,
        background: token.surface,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <div style={{ marginBottom: 6 }}>
        <span
          style={{
            display: 'inline-block',
            padding: '1px 6px',
            borderRadius: 4,
            background: token.error,
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.5,
          }}
        >
          NSFW
        </span>
      </div>
      <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>
    </div>
  );
}

function formatToolResult(toolName: string, resultJson: string): ReactNode {
  switch (toolName) {
    case 'search_models': {
      const data = tryParse<{ items?: ModelItem[] }>(resultJson);
      if (data?.items && data.items.length > 0) {
        return (
          <div>
            <div style={{ color: token.dimmed, fontSize: 11, marginBottom: 6 }}>
              {data.items.length} model{data.items.length !== 1 ? 's' : ''} found
            </div>
            <ModelGrid models={data.items} />
          </div>
        );
      }
      break;
    }
    case 'get_model_details': {
      const data = tryParse<ModelDetailItem>(resultJson);
      if (data && data.name) {
        return <ModelDetailCard model={data} />;
      }
      break;
    }
    case 'search_images': {
      const data = tryParse<{ items?: ImageItem[] }>(resultJson);
      if (data?.items && data.items.length > 0) {
        return (
          <div>
            <div style={{ color: token.dimmed, fontSize: 11, marginBottom: 6 }}>
              {data.items.length} image{data.items.length !== 1 ? 's' : ''}
            </div>
            <ImageGrid images={data.items} />
          </div>
        );
      }
      break;
    }
    case 'delegate_to_nsfw_agent':
      return <NsfwResultBlock content={resultJson} />;
  }

  // Fallback: pretty-print JSON
  const pretty = tryParse<unknown>(resultJson);
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
      {pretty != null ? JSON.stringify(pretty, null, 2) : resultJson}
    </pre>
  );
}

export function ToolCallCard({ toolCall, result, isLoading = false }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const args = parseToolArguments(toolCall.function.arguments);
  const hasResult = result != null && result.content;
  const content = hasResult ? result!.content : null;

  return (
    <div
      style={{
        margin: '4px 0 4px 24px',
        borderRadius: radius.sm,
        border: `1px solid ${token.border}`,
        background: token.surface,
        fontSize: 12,
        overflow: 'hidden',
      }}
      data-testid="tool-call-card"
      onClick={() => setExpanded(!expanded)}
    >
      {/* Header — always visible */}
      <div
        style={{
          padding: '8px 10px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((prev) => !prev);
          }
        }}
      >
        <Group gap={6}>
          <span style={{ color: token.dimmed }}>🔧</span>
          <span style={{ fontSize: 12, fontWeight: 500 }}>{toolCall.function.name}</span>
          {isLoading && (
            <span style={{ color: token.dimmed, fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                border: `2px solid ${token.border}`,
                borderTopColor: token.primary,
                borderRadius: '50%',
                animation: 'spin 0.6s linear infinite',
              }} />
              Running…
            </span>
          )}
          {!isLoading && hasResult && (
            <span style={{ color: token.success, fontSize: 11 }}>✓</span>
          )}
        </Group>
        <span style={{ color: token.dimmed, fontSize: 10 }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {/* Collapsible body */}
      {expanded && (
        <div
          style={{
            padding: '0 10px 8px',
            borderTop: `1px solid ${token.border}`,
          }}
          data-testid="tool-call-body"
        >
          {/* Args */}
          <div
            style={{
              marginTop: 8,
              padding: '6px 8px',
              borderRadius: radius.sm,
              background: token.body,
              fontFamily: 'monospace',
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              color: token.dimmed,
            }}
            data-testid="tool-call-args"
          >
            {JSON.stringify(args, null, 2)}
          </div>

          {/* Result or loading */}
          {isLoading && !content && (
            <div style={{ marginTop: 8, color: token.dimmed, fontSize: 11, fontStyle: 'italic' }}>
              Waiting for result…
            </div>
          )}
          {content && (
            <div style={{ marginTop: 8 }} data-testid="tool-call-result">
              {formatToolResult(toolCall.function.name, content)}
            </div>
          )}
        </div>
      )}

      {/* Keyframes for spinner — injected once via style tag */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
