/**
 * OpenRouter model picker — Recommended + search + filters + info panel.
 *
 * Rendered ONLY for the OpenRouter provider (other providers keep the plain
 * dropdown). Every capability claim shown here comes from provider metadata
 * via lib/openrouter-catalog; unknowns render as Unknown, never as facts.
 * Selection is always explicit (row click / Use-model button); this
 * component never auto-selects, never switches providers, and never writes
 * credentials (favorites/recents are model ids in web storage only).
 */
import { useEffect, useMemo, useState } from "react";
import {
  availableFilters,
  curateRecommended,
  filterModels,
  isCatalogFresh,
  loadFavorites,
  loadRecent,
  MAX_SEARCH_RESULTS,
  modelInfoLines,
  normalizeOpenRouterCatalog,
  pushRecent,
  readCatalogCache,
  resolveSelectedModel,
  searchModels,
  toggleFavorite,
  toolSupportVerdict,
  writeCatalogCache,
  type ModelFilter,
  type OpenRouterHostModel,
  type OpenRouterModel,
} from "./lib/openrouter-catalog.js";
import { Button, Input } from "./lib/ui.js";

export interface OpenRouterModelPickerProps {
  /** This provider's model list (already provider-separated upstream). */
  models: OpenRouterHostModel[];
  modelsLoading: boolean;
  /** Host discovery error text, if the last fetch failed. */
  modelsError: string | null;
  /** Exact persisted selection (settings.model) — displayed, never altered. */
  activeModelId: string;
  /** Detail-level selection mirror (drives "Start using this provider"). */
  selectedModel: string;
  /** Catalogue default model id, when the catalogue defines one. */
  catalogDefaultId?: string;
  /** Explicit pick: update detail state + host model + recents. */
  onSelectModel: (id: string) => void;
  /** Reveal the Advanced manual model-ID entry. */
  onShowManualEntry: () => void;
  /** Re-request the provider's model list from the host. */
  onRefreshModels: () => void;
}

function Chip({ label, title }: { label: string; title?: string }) {
  return (
    <span
      className="text-[9px] px-1 py-px rounded border border-vscode-border text-vscode-desc"
      title={title}
    >
      {label}
    </span>
  );
}

function ModelRow({
  model,
  selected,
  favorite,
  onPick,
  onToggleFavorite,
}: {
  model: OpenRouterModel;
  selected: boolean;
  favorite: boolean;
  onPick: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <li>
      <div className="w-full flex items-center gap-2 px-2 py-1 text-left text-[10px] text-vscode-fg hover:bg-vscode-list-hover border-b border-vscode-border/40 last:border-b-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          aria-label={
            favorite ? `Unfavorite ${model.id}` : `Favorite ${model.id}`
          }
          aria-pressed={favorite}
          title={favorite ? "Remove from favorites" : "Add to favorites"}
          className="shrink-0 text-vscode-desc hover:text-vscode-fg"
        >
          {favorite ? "★" : "☆"}
        </button>
        <button
          type="button"
          onClick={onPick}
          aria-label={`Select model ${model.id}`}
          className="flex-1 min-w-0 text-left"
        >
          <span className="block truncate font-medium">
            {selected ? "✓ " : ""}
            {model.name}
          </span>
          <span className="block truncate text-vscode-desc font-mono text-[9px]">
            {model.id}
          </span>
          <span className="flex gap-1 flex-wrap mt-0.5">
            {model.toolsKnown && model.tools && <Chip label="Tools" />}
            {model.vision && <Chip label="Vision" />}
            {model.reasoning && <Chip label="Reasoning" />}
            {model.free && <Chip label="Free" />}
            {model.contextWindow !== undefined && (
              <Chip
                label={
                  model.contextWindow >= 1_000_000
                    ? `${Math.round(model.contextWindow / 1_000_000)}M ctx`
                    : `${Math.round(model.contextWindow / 1000)}k ctx`
                }
              />
            )}
          </span>
        </button>
      </div>
    </li>
  );
}

export function OpenRouterModelPicker(props: OpenRouterModelPickerProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const [cachedAt, setCachedAt] = useState<number | null>(null);

  const live = useMemo(
    () => normalizeOpenRouterCatalog(props.models),
    [props.models],
  );

  // Catalogue cache: only consulted when the live list is empty (failed or
  // not-yet-loaded fetch). Written whenever a live list arrives.
  useEffect(() => {
    if (live.length > 0) {
      if (writeCatalogCache(undefined, live)) setCachedAt(Date.now());
      return;
    }
    const cached = readCatalogCache();
    if (cached && cached.models.length > 0) setCachedAt(cached.savedAt);
  }, [live.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const cachedModels = useMemo(() => {
    if (live.length > 0) return [];
    const cached = readCatalogCache();
    return cached ? cached.models : [];
  }, [live.length > 0, cachedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const usingCache = live.length === 0 && cachedModels.length > 0;
  const effective = live.length > 0 ? live : cachedModels;
  const recommended = useMemo(() => curateRecommended(effective), [effective]);
  const recommendedIds = useMemo(
    () => new Set(recommended.map((m) => m.id)),
    [recommended],
  );
  const filters = useMemo(
    () => availableFilters(effective, favorites, recent),
    [effective, favorites, recent],
  );
  const searched = useMemo(
    () =>
      query.trim().length > 0
        ? searchModels(effective, query, recommendedIds)
        : [],
    [effective, query, recommendedIds],
  );
  const ctx = useMemo(
    () => ({ favorites, recent, recommendedIds }),
    [favorites, recent, recommendedIds],
  );
  const filtered = useMemo(
    () => filterModels(effective, filter, ctx).slice(0, MAX_SEARCH_RESULTS),
    [effective, filter, ctx],
  );
  const totalForFilter = useMemo(
    () => filterModels(effective, filter, ctx).length,
    [effective, filter, ctx],
  );

  // Effective selection display: explicit detail selection first, then the
  // persisted active id (only when it names a model in this catalogue),
  // else nothing (never an arbitrary catalogue entry).
  const displayModelId = resolveSelectedModel(
    props.selectedModel || props.activeModelId,
    new Set(effective.map((m) => m.id)),
    null,
    "openrouter",
    props.catalogDefaultId,
  );
  const displayModel =
    effective.find((m) => m.id === displayModelId) ??
    (props.selectedModel || props.activeModelId
      ? {
          id: props.selectedModel || props.activeModelId,
          name: props.selectedModel || props.activeModelId,
          vendor: "OpenRouter",
          tools: false,
          toolsKnown: false,
          vision: false,
          reasoning: false,
          free: false,
        }
      : undefined);
  const verdict = displayModel ? toolSupportVerdict(displayModel) : null;

  const pick = (id: string) => {
    setRecent(pushRecent(undefined, id));
    props.onSelectModel(id);
  };

  const searching = query.trim().length > 0;
  const listLabel = searching
    ? `${searched.length} result${searched.length === 1 ? "" : "s"}`
    : showAll
      ? `Showing ${filtered.length} of ${totalForFilter}`
      : null;

  return (
    <div className="space-y-2">
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search models…"
        aria-label="Search OpenRouter models"
        className="w-full"
      />
      {props.modelsLoading && effective.length === 0 && (
        <p className="text-[10px] text-vscode-desc" role="status">
          Loading models…
        </p>
      )}
      {!props.modelsLoading && effective.length === 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-vscode-error-fg" role="alert">
            {props.modelsError
              ? "Unable to load model catalog."
              : "Model catalog unavailable — enter model ID manually."}
          </p>
          {props.modelsError && (
            <p className="text-[9px] text-vscode-desc">{props.modelsError}</p>
          )}
          <div className="flex gap-1.5 flex-wrap">
            <Button
              variant="secondary"
              size="sm"
              onClick={props.onRefreshModels}
            >
              Retry
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={props.onShowManualEntry}
            >
              Enter model ID manually
            </Button>
          </div>
        </div>
      )}
      {usingCache && (
        <p className="text-[9px] text-vscode-desc">
          Using cached model catalog
          {cachedAt && !isCatalogFresh(cachedAt)
            ? " (may be outdated)"
            : ""}.{" "}
          <button
            type="button"
            className="underline hover:text-vscode-fg"
            onClick={props.onRefreshModels}
          >
            Refresh
          </button>
        </p>
      )}
      {effective.length > 0 && !searching && !showAll && (
        <>
          {favorites.filter((id) => effective.some((m) => m.id === id)).length >
            0 && (
            <div>
              <p className="text-[10px] font-semibold text-vscode-desc uppercase tracking-wider mb-1">
                Favorites
              </p>
              <ul className="rounded border border-vscode-border max-h-40 overflow-y-auto">
                {effective
                  .filter((m) => favorites.includes(m.id))
                  .map((m) => (
                    <ModelRow
                      key={m.id}
                      model={m}
                      selected={m.id === displayModelId}
                      favorite
                      onPick={() => pick(m.id)}
                      onToggleFavorite={() =>
                        setFavorites(toggleFavorite(undefined, m.id))
                      }
                    />
                  ))}
              </ul>
            </div>
          )}
          <div>
            <p className="text-[10px] font-semibold text-vscode-desc uppercase tracking-wider mb-1">
              Recommended
            </p>
            {recommended.length === 0 ? (
              <p className="text-[10px] text-vscode-desc">
                No verified tool-capable models in the current catalogue —
                search below or enter an ID manually.
              </p>
            ) : (
              <ul className="rounded border border-vscode-border max-h-60 overflow-y-auto">
                {recommended.map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    selected={m.id === displayModelId}
                    favorite={favorites.includes(m.id)}
                    onPick={() => pick(m.id)}
                    onToggleFavorite={() =>
                      setFavorites(toggleFavorite(undefined, m.id))
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {effective.length > 0 && (
        <div
          className="flex gap-1 flex-wrap"
          role="group"
          aria-label="Model filters"
        >
          {filters.map((f) => (
            <Button
              key={f.id}
              variant={filter === f.id ? "primary" : "secondary"}
              size="sm"
              onClick={() => {
                setFilter(f.id);
                setShowAll(true);
              }}
              title={`${f.count} model${f.count === 1 ? "" : "s"}`}
            >
              {f.label}
            </Button>
          ))}
        </div>
      )}
      {effective.length > 0 && (searching || showAll) && (
        <div>
          {searching && searched.length === 0 ? (
            <p className="text-[10px] text-vscode-desc">No models found.</p>
          ) : !searching && filtered.length === 0 ? (
            <p className="text-[10px] text-vscode-desc">
              No models match this filter.
            </p>
          ) : (
            <>
              {listLabel && (
                <p className="text-[9px] text-vscode-desc mb-1">{listLabel}</p>
              )}
              <ul
                className="rounded border border-vscode-border max-h-60 overflow-y-auto"
                aria-label={
                  searching ? "Model search results" : "OpenRouter models"
                }
              >
                {(searching ? searched : filtered).map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    selected={m.id === displayModelId}
                    favorite={favorites.includes(m.id)}
                    onPick={() => pick(m.id)}
                    onToggleFavorite={() =>
                      setFavorites(toggleFavorite(undefined, m.id))
                    }
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {effective.length > 0 && !searching && !showAll && (
        <Button variant="secondary" size="sm" onClick={() => setShowAll(true)}>
          {`View all OpenRouter models (${effective.length})`}
        </Button>
      )}
      {displayModel && (
        <div className="rounded border border-vscode-border px-2 py-1.5 space-y-1">
          <p className="text-[10px] text-vscode-desc">
            Selected model:{" "}
            <span className="text-vscode-fg font-mono">{displayModel.id}</span>
          </p>
          <div className="text-[10px] text-vscode-desc space-y-0.5">
            {modelInfoLines(displayModel).map((row) => (
              <div key={row.label} className="flex gap-1.5">
                <span className="shrink-0 w-20 text-vscode-desc">
                  {row.label}:
                </span>
                <span className="text-vscode-fg break-words">{row.value}</span>
              </div>
            ))}
          </div>
          {verdict && (
            <p
              className={`text-[10px] ${verdict.supported ? "text-vscode-testing-run" : "text-vscode-error-fg"}`}
              role={verdict.supported ? "status" : "alert"}
            >
              {verdict.supported ? "✓ " : "⚠ "}
              {verdict.heading}
              {verdict.body ? ` — ${verdict.body}` : ""}
            </p>
          )}
        </div>
      )}
      {!displayModel && effective.length > 0 && (
        <p className="text-[10px] text-vscode-desc">
          No model selected — select one above.
        </p>
      )}
    </div>
  );
}
