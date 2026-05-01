# Changes — domo-app-double-aggregate-new

Session goal: get the app to react to dashboard page filters, deploy it to `domo-elliott-leonard`, and create a card.

## Problem

When a page filter was added on the dashboard, the chart did not update. The chart's query was firing on filter change, but the outgoing URL only carried the static `chan!='Warehouse Transfer/Placeholder'` filter — the page filter was missing.

## Root cause

`domo.data.query(alias, options)` does **not** auto-merge page filters when the caller passes an explicit `filter` string. The developer-supplied filter is sent verbatim. Page filters must be merged in by the app.

The original merging code (already in `app.js`) attempted this but had two bugs:

1. **Column-name vs alias mismatch.** Page filter events deliver the dataset's raw column name (`6chan`, `OU_NAME`, `Season Split Sort`). The Domo filter DSL expects the manifest alias (`chan`, `ouName`, `seasonSplit`). Composing `6chan='Inline'` produced an invalid expression that was either rejected or silently dropped.
2. **Empty `onDataUpdated` handler.** Dataset-level updates didn't trigger a refetch.

## Fix

### app.js
- Added a static `COLUMN_TO_ALIAS` map mirroring the manifest's `fields` mappings.
- `pageFilterToExpr` now translates the event's raw column name to its alias before composing the DSL expression. Filters on columns not in the manifest are skipped (returns `null`).
- Tolerates either `operator` or `operand` on the filter object (different host contracts use different keys).
- `onFiltersUpdated` normalizes the payload into an array regardless of shape (array, `{ filters: [...] }`, or object-of-objects), then calls `loadAndRender()`.
- `onDataUpdated` now also calls `loadAndRender()` so dataset-level changes trigger a refetch.
- `[double-agg]` console diagnostics added for filter payload, normalized filters, and composed filter string.

### manifest.json
- `dataSetId` → `0a0f0b7c-7c53-4617-a5de-4dd850450e36` (TEMP _ JR286 Sales Sample on `domo-elliott-leonard`).
- `seasonSplit` alias remapped from `Season Split` → `Season Split Sort` (column rename on the new dataset).
- Old `id` and `proxyId` removed pre-publish so a fresh design was created on the new instance; the `id` is now `f339b501-dbb7-4f44-a5fd-a0ba90af6a68`.

## Deployment

- **Instance:** `domo-elliott-leonard.domo.com`
- **Design ID:** `f339b501-dbb7-4f44-a5fd-a0ba90af6a68`
- **Card / context ID:** `214f83c4-cdc1-4dec-b0f4-bf2a76546d1b` (fullpage, in asset library)
- Published via `domo publish`.
- Card created via Dev Studio API: `POST /domoapps/apps/v2/contexts` then `POST /domoapps/apps/v2?fullpage=true&pageId=-100000`.

## Verified
- Page filter on `6chan` (e.g. `Inline`) is now appended to the query and reflected in the chart.
- Variable handlers (`Season/Year/Fiscal_DL`, `Cat/PL/Cat-PL_DL`) untouched — period/category dropdowns still drive the query alongside the page filter.
