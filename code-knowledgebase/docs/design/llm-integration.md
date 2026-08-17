---
modified: 2026-07-06
dependencies: [storage]
---

# LLM provider integration — model chain, invocation, and metrics

Describes how `mcp-code-vault` talks to LLM providers (Google Gemini, OpenAI and OpenAI-compatible vendors, Anthropic, and local servers like Ollama/LM Studio) through LangChain chat model classes, how it builds a per-project model fallback chain from saved config, retries and continues truncated output, and how every completion is reported as a metric. Read this before touching anything under `src/llm/`, `src/stats/providerDiscovery.ts`, the `LLMModel` / `ModelProviderCredential` schemas, or the `model_call` metric shape.

## Sensitive Areas

- **Credential resolution and precedence** (`resolveModelAuthForLlm` / `batchResolveModelAuth` in `src/llm/resolveModelAuth.ts`): a saved `LLMModel` row's own `access_key` / `api_base_url` / `local_api_mode` are the defaults, but if the row has a `credential_id`, the linked `ModelProviderCredential` document's non-empty fields override them field-by-field (not wholesale). Getting this precedence backwards would silently use stale per-model keys instead of a shared, centrally-rotated credential.
- **API keys are stored in plaintext in Mongo** (`ILLMModel.access_key`, `IModelProviderCredential.access_key`) — there is no encryption-at-rest or redaction in these schemas. `formatMongoUrlForSettings` (`src/utils/redactMongoUrl.ts`) redacts the Mongo *connection string's* userinfo for display, but nothing in this subsystem redacts LLM provider keys before logging or persisting them; treat `access_key` fields as secrets when touching config UI, logs, or metrics.
- **Local-provider placeholder key** (`createChatModelForSavedModel.ts`): when `local`/`ollama`/`lmstudio` providers have no real API key, the code substitutes the literal string `'ollama'` (`PLACEHOLDER_LOCAL_KEY`) as the OpenAI-client `apiKey` so the LangChain `ChatOpenAI` constructor doesn't reject an empty key. This is not a real secret and must never be treated as one or leak into a "credential present" check.
- **Retry classification** (`isRetryableLlmError` in `src/llm/retryable.ts`) is a string/status heuristic, not a provider-specific error taxonomy — it pattern-matches error messages for things like `429`, `rate`, `quota`, `timeout`, `econnreset`. A provider that phrases a genuinely non-retryable error (e.g. bad request) using one of these words would be retried and then rotated past unnecessarily; this is a known trade-off, not a bug to silently "fix" by narrowing the regex without checking real provider error shapes first.
- **Metrics never include raw prompt/response content** — `postModelCallMetric` only ever forwards token counts, provider/model identifiers, duration, and status/error code, never message text. Do not add a "log the prompt" field to `PostModelCallMetricParams` without treating it as a sensitive-data change (prompts can contain file source and generated summaries).

## Design Constraints

- All chat model construction goes through LangChain (`@langchain/openai`, `@langchain/anthropic`, `@langchain/google-genai`) — there is no direct HTTP client for chat completions in this subsystem. New providers should be added by extending `createChatModelForSavedModel`'s provider branches, not by adding a bespoke fetch-based path.
- `createChatModelForSavedModel` returns `null` (never throws) when a provider is unusable (missing key, missing base URL, unknown provider string) — callers are required to treat `null` as "skip this model and try the next one," not as a fatal error.
- Provider identifiers are normalized (trimmed, lowercased, spaces→underscores) before matching (`normalizeProvider`), and several aliases map to the same branch (e.g. `google`/`gemini`/`google_genai`/`google-ai`; `anthropic`/`claude`; `local`/`ollama`/`lmstudio`/`localmodels`). Any new alias must be added to this normalization, not compared ad hoc elsewhere.
- Local providers only support two wire modes, `'ollama'` (native Ollama API) and `'openai'` (OpenAI-compatible `/v1` endpoint) — encoded as a literal union type on `ILLMModel.local_api_mode` / `IModelProviderCredential.local_api_mode`, not a free-form string.
- The model fallback chain (`invokeWithModelFallback`) is ordered strictly by each `LLMModel.priority` (ascending, default 100) then `name` — there is no cost-based, latency-based, or load-based reordering.
- Retries only happen for errors classified retryable by `isRetryableLlmError`; non-retryable errors move immediately to the next model in the chain (or fail the whole call if it was the last model).
- Output-truncation continuation (`invokeChatWithOutputTruncationContinuation`) is capped by `FILE_PROCESSING_LLM_MAX_CONTINUATION_ROUNDS` (default 32) and is a deliberate port of the same control flow as `getResponse` in the separate Mathsense/`llmShared.js` codebase — keep the two in sync conceptually if one changes.
- The cached model list (`getCachedVaultLlmModels`) is intentionally eventually-consistent: up to 5 minutes stale, plus a 5% random early-refresh chance per read, to avoid hammering Mongo on every file processed. Callers that need a guaranteed-fresh list after an admin edit must call `invalidateVaultLlmModelsCache()` explicitly.

## Feature Overview

`mcp-code-vault` indexes a project's source files by asking an LLM to summarize each file. Rather than hardwiring one vendor, the vault lets an admin configure a prioritized list of saved LLM models (`LLMModel` documents, any mix of providers) with optional shared credentials (`ModelProviderCredential`), and the file-processing pipeline walks that list in priority order until one model produces output, retrying transient failures and rotating past hard failures. If no usable saved model exists, the pipeline falls back to a single hardcoded Gemini call keyed by the `GEMINI_API_KEY` environment variable. Every attempt — success or failure, saved-chain or env fallback — is reported as a `model_call` metric with token counts and timing for the Stats home dashboard. A separate provider-discovery module (`src/stats/providerDiscovery.ts`) lets the config UI query a vendor's live model catalog (OpenAI, Gemini, Anthropic, GitHub Models, and OpenAI-compatible presets like Groq/Together/Mistral/OpenRouter/DeepSeek/etc.) and suggests a routing category (fast/blended/thinking) per discovered model, plus a `verifyLocalConnection` helper for testing an Ollama or LM Studio endpoint is reachable before saving it.

## Architecture

The subsystem is layered as: model config storage → per-call model construction → single-model invocation with continuation → multi-model fallback/retry → metrics. Concretely:

1. **Config storage** — `LLMModel` (`src/db/models/LLMModel.ts`, Mongo collection `models`) holds one row per saved model: provider, name, label, routing `categories`, priority, `enabled`, and either its own `access_key`/`api_base_url`/`local_api_mode` or a `credential_id` pointing at a shared `ModelProviderCredential` (`src/db/models/ModelProviderCredential.ts`, collection `model_provider_credentials`) — letting several models from the same vendor share one API key.
2. **Cache** — `vaultLlmModelsCache.ts` loads all `enabled !== false` `LLMModel` rows sorted by `priority` then `name`, and caches them in-process (`getCachedVaultLlmModels`) for up to 5 minutes with a small random early-refresh chance; `invalidateVaultLlmModelsCache()` forces a reload (e.g. after a config-admin save).
3. **Auth resolution** — `resolveModelAuth.ts` merges each candidate model's own auth fields with its linked credential (credential wins field-by-field when present); `batchResolveModelAuth` does this for a whole candidate list with a single `ModelProviderCredential.find({_id:{$in:[...]}})` instead of one query per model.
4. **Chat model construction** — `createChatModelForSavedModel.ts` turns one `LLMModel` + its `ResolvedModelAuth` into a LangChain `BaseChatModel` (`ChatGoogleGenerativeAI`, `ChatOpenAI`, or `ChatAnthropic`), or `null` if unusable. Local providers are routed through `ChatOpenAI` pointed at either the Ollama-native origin (rewritten to `.../v1` by `ollamaOpenAiBase`) or an already-OpenAI-compatible base.
5. **Single-call invocation with continuation** — `invokeWithContinuation.ts` calls `chat.invoke(messages)` and, if the response's `finish_reason` indicates it was cut off for length (`finishReasonImpliesMaxOutputLength`), appends the AI's partial reply plus a "continue from here" user turn (`DEFAULT_CONTINUATION_USER_PROMPT`, seeded with the last `lastChunkSnippetChars` of output) and calls again, up to `maxContinuationRounds`.
6. **Multi-model fallback with retry** — `invokeWithModelFallback.ts` takes an ordered list of `ChatModelSlot` (chat instance + `LlmModelAttemptMeta`) and, per slot, retries up to `retriesPerModel` times with exponential backoff (`baseDelayMs * 2^attempt` plus jitter) only for errors `isRetryableLlmError` accepts, then moves to the next slot; it throws the last error only after every slot is exhausted.
7. **Orchestration entry point** — `runFileProcessingLlm.ts` ties all of the above together for one file: resolves the project's file-processing system prompt (from a `SystemPrompt` slug, an `agent` bundle, or a hardcoded default) and category filter, reads and truncates the file (120,000 chars), builds `messages`, gets the cached model list filtered by category and sorted by priority, resolves auth and builds chat slots, calls `invokeWithModelFallback`, and on any outcome (`db_chain` success, `db_chain` exhaustion, or `env_gemini` fallback/failure) posts one `model_call` metric via `postModelCallMetric`. It is called from `src/analyzer.ts` (`caller: MODEL_CALL_CALLER_SCAN_ANALYZE`) and `src/fileProcessingStartup.ts` (`caller: MODEL_CALL_CALLER_FILE_PROCESSING`).
8. **Legacy standalone helper** — `src/llm.ts`'s `getGeminiLLM(apiKey)` is the hardcoded, no-fallback Gemini client (`model: 'gemini-pro'`) used only as the last-resort branch in `runFileProcessingLlm` when no saved model chain produced a usable slot.
9. **Metrics** — `postModelCallMetric.ts` posts one `operation: 'model_call'` event (via the generic `postMetric` in `src/stats/metricsClient.ts`) per completion attempt, with snake_case `metadata.tokens_*` fields for the Stats home UI; `metricsClient.ts` queues metrics until the local stats server signals readiness, then flushes and sends live.
10. **Provider discovery (config-time, separate call path)** — `src/stats/providerDiscovery.ts` is invoked by the config UI (not by `runFileProcessingLlm`) to list a vendor's available models before a `LLMModel` row is saved, and to sanity-check a local server is reachable (`verifyLocalConnection`).

## Functions

- `getGeminiLLM(apiKey)` (`src/llm.ts`) — constructs a `ChatGoogleGenerativeAI` hardcoded to `model: 'gemini-pro'`; the fallback-of-last-resort chat client.
- `createChatModelForSavedModel(model, auth, opts?)` (`src/llm/createChatModelForSavedModel.ts`) — builds a `BaseChatModel` for one saved model row + resolved auth, or `null` if unusable. `opts.temperature` defaults to `0.2`; `opts.maxOutputTokens` is passed through as `maxTokens` where the client supports it. Internal helpers `normalizeProvider` and `ollamaOpenAiBase` are not exported.
- `invokeChatWithOutputTruncationContinuation(params)` (`src/llm/invokeWithContinuation.ts`) — invokes a single chat model, chaining continuation turns while `finish_reason` implies max-output truncation; returns `{ text, usage, rounds, lastFinishReason, outputTruncated }`. Exposes `finishReasonImpliesMaxOutputLength(reason)` and `maxLlmContinuationRounds()` (reads `FILE_PROCESSING_LLM_MAX_CONTINUATION_ROUNDS`, default 32) and the constant `DEFAULT_CONTINUATION_USER_PROMPT`.
- `invokeWithModelFallback(params)` (`src/llm/invokeWithModelFallback.ts`) — walks `params.slots` in order, retrying transient errors per slot (`retriesPerModel`, default 2; `baseDelayMs`, default 400) before rotating; returns `{ text, usage, used, attempts, continuationRounds?, outputTruncated?, lastFinishReason? }` or throws the last error once every slot is exhausted. Throws immediately if `slots` is empty.
- `messageContentToString(content)` / `baseMessageText(msg)` (`src/llm/messageText.ts`) — normalize LangChain message `content` (string or multimodal block array) to plain text.
- `isRetryableLlmError(err)` / `sleep(ms)` (`src/llm/retryable.ts`) — heuristic transient-error classifier (matches `429|503|502|504|rate|quota|overloaded|throttl|timeout|timed out|econnreset|etimedout|fetch failed|socket|temporar` in the message, or numeric `status`/`code` fields) and a promise-based delay helper.
- `extractTokenUsageFromAiMessage(msg)` (`src/llm/tokenUsage.ts`) — best-effort token extraction from either LangChain's `usage_metadata` (input/output/reasoning, several field-name spellings per provider) or `response_metadata.token_usage` (OpenAI-style prompt/completion/total); returns `{}` when nothing recognizable is present rather than guessing.
- `resolveModelAuthForLlm(model)` / `batchResolveModelAuth(models)` (`src/llm/resolveModelAuth.ts`) — merge a model row's own auth fields with its linked `ModelProviderCredential` (credential fields win when non-empty); the batch form does one `find` for all distinct `credential_id`s instead of N lookups.
- `getCachedVaultLlmModels()` / `invalidateVaultLlmModelsCache()` / `resetVaultLlmModelsCacheForTesting()` (`src/llm/vaultLlmModelsCache.ts`) — process-local cache (max age 5 minutes, 5% random early refresh) of enabled `LLMModel` rows, deduplicating concurrent loads via a shared `inflight` promise.
- `postModelCallMetric(params)` (`src/llm/postModelCallMetric.ts`) — builds and posts one `model_call` metric event; re-exports `METRIC_OPERATION_MODEL_CALL` from `metricsConstants.ts`.
- `runFileProcessingLlm(params)` (`src/llm/runFileProcessingLlm.ts`) — the orchestration entry point described in Architecture; also exports caller-id constants `MODEL_CALL_CALLER_FILE_PROCESSING` and `MODEL_CALL_CALLER_SCAN_ANALYZE`.
- `normalizeModelCategoryToken` / `normalizeModelCategoriesInput` / `modelCategoriesFromDoc` / `defaultModelCategoriesIfEmpty` / `normalizeAgentModelCategoriesInput` (`src/utils/modelCategories.ts`) — normalize and default the `fast`/`blended`/`thinking` (+ custom, e.g. `Vision`) routing tags shared by saved models and agents.
- `formatMongoUrlForSettings(url)` / `mongoUrlLinesForSettingsContent(url)` (`src/utils/redactMongoUrl.ts`) — format the **Mongo** connection string for display without leaking user/password; unrelated to LLM provider keys but the only redaction helper in the codebase, referenced here because it sets the pattern any future LLM-key redaction should follow.
- `discoverProviderModels(provider, apiKey, opts?)` and per-vendor helpers `discoverOpenAiModels` / `discoverOpenAiCompatibleModels` / `discoverGeminiModels` / `discoverAnthropicModels` / `discoverGithubModelsCatalog` (`src/stats/providerDiscovery.ts`) — query a vendor's live model list for the config UI; `suggestedCategoryForDiscoveredModel` heuristically assigns fast/blended/thinking per model id/label/description; `verifyLocalConnection` pings an Ollama (`/api/tags`) or OpenAI-compatible (`/v1/models`) local server.

## Models

**`LLMModel`** (`src/db/models/LLMModel.ts`, Mongoose collection `models`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| name | string | yes | Provider-specific model id (e.g. `gpt-4o-mini`, `claude-3-5-haiku-latest`). |
| provider | string | yes | Free-text provider slug, normalized at use-time by `createChatModelForSavedModel`. |
| label | string | yes | Display label. |
| categories | string[] | no | Routing tags (`fast`/`blended`/`thinking`/custom); normalized via `modelCategoriesFromDoc`. |
| category | string | no | Deprecated legacy single-tier field, migrated to `categories` in API responses. |
| access_key | string | no | Provider API key, plaintext. |
| credential_id | ObjectId (ref `ModelProviderCredential`) | no | Shared credential; overrides `access_key`/`api_base_url`/`local_api_mode` field-by-field when present and non-empty. |
| api_base_url | string | no | Local-provider origin (Ollama) or OpenAI-compatible base. |
| local_api_mode | `'ollama' \| 'openai'` | no | Wire protocol for local providers. |
| priority | number | no | Default `100`; ascending sort order for the fallback chain. |
| enabled | boolean | no | Default `true`; `getCachedVaultLlmModels` only loads `enabled !== false` rows. |
| capabilities | string[] | no | Free-form capability tags. |
| is_custom | boolean | no | Default `false`. |

Indexed on `{ provider: 1, name: 1, credential_id: 1 }`.

**`ModelProviderCredential`** (`src/db/models/ModelProviderCredential.ts`, collection `model_provider_credentials`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| provider | string | yes | Vendor slug. |
| access_key | string | no | Shared API key, plaintext. |
| api_base_url | string | no | Shared base URL. |
| local_api_mode | `'ollama' \| 'openai'` | no | Shared wire mode. |

Indexed on `{ provider: 1 }`. One credential can be referenced by many `LLMModel` rows.

**`Metric`** (`src/db/models/Metric.ts`, `IMetric`, default collection)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| instance_id | string | yes | Process instance identifier (`INSTANCE_ID` env, default `mcp-code-vault`). |
| operation | string | yes | e.g. `model_call` (`METRIC_OPERATION_MODEL_CALL`). |
| kind | `'query' \| 'event'` | yes | `model_call` is posted as `'event'`. |
| started_at / ended_at | Date | yes | Derived from `durationMs` at post time. |
| duration_ms | number | yes | |
| status | `'ok' \| 'error'` | yes | |
| error_code | string | no | e.g. the error's `name`, or `'no_llm_config'` for the no-model/no-env-key case. |
| metadata | Mixed (default `{}`) | no | For `model_call`: `projectKey`, `caller`, `provider`, `model_id`, `model_label`, `file_path`, `file_processing_driver`, `tokens_in`, `tokens_out`, `tokens_thinking`, `continuation_rounds`, `output_truncated`, `last_finish_reason`. |

Indexed on `{ instance_id: 1, started_at: -1 }` and `{ operation: 1, started_at: -1 }`.

**`LlmTokenUsage`** (`src/llm/tokenUsage.ts`, plain type, not persisted directly) — `{ inputTokens?, outputTokens?, thinkingTokens? }`, all optional and omitted (not zeroed) when a provider doesn't report them.

**`ResolvedModelAuth`** (`src/llm/resolveModelAuth.ts`, plain type) — `{ apiKey: string; baseUrl?: string; localApiMode?: 'ollama' | 'openai' }`, the merged output of model-row + credential.

**`CachedVaultLlmModel`** (`src/llm/vaultLlmModelsCache.ts`, plain type) — the subset of `LLMModel` fields the cache carries: `_id, name, provider, label, categories, priority, access_key?, credential_id?, api_base_url?, local_api_mode?`.

**`ProviderModel`** (`src/stats/providerDiscovery.ts`, plain type, config-UI-facing) — `{ id, name, label, capabilities, description?, suggested_category? }`, `suggested_category` being one of `'fast' | 'blended' | 'thinking'`.

## Use Cases

### UC1 — Index a file through the saved-model fallback chain

**Goal:** Produce an LLM summary for one file by walking the project's prioritized saved-model list, tolerating transient provider errors and unusable models without failing the whole call.

**Stakeholders:** Platform operators (want indexing to keep working through provider hiccups without manual intervention); admins who configured the model chain (expect priority order to be honored); end users waiting on file-processing/scan results.

**Actors:** `runFileProcessingLlm` (`src/llm/runFileProcessingLlm.ts`); `getCachedVaultLlmModels` (`src/llm/vaultLlmModelsCache.ts`); `batchResolveModelAuth` (`src/llm/resolveModelAuth.ts`); `createChatModelForSavedModel` (`src/llm/createChatModelForSavedModel.ts`); `invokeWithModelFallback` (`src/llm/invokeWithModelFallback.ts`); `isRetryableLlmError` (`src/llm/retryable.ts`); `postModelCallMetric` (`src/llm/postModelCallMetric.ts`). Called from `src/analyzer.ts` (`caller: MODEL_CALL_CALLER_SCAN_ANALYZE`) and `src/fileProcessingStartup.ts` (`caller: MODEL_CALL_CALLER_FILE_PROCESSING`).

**Preconditions:** At least one enabled `LLMModel` row exists for the project's category filter; the file to process is readable.

**Postconditions:** Exactly one `model_call` metric is posted for the attempt, recording which model actually served the request (or that the chain was exhausted); on success, `runFileProcessingLlm` returns the generated text to its caller.

**Basic Course of Events (BCE):**
1. `runFileProcessingLlm` resolves the project's file-processing system prompt and category filter, reads and truncates the target file (120,000 chars), and builds the `messages` array.
2. It calls `getCachedVaultLlmModels()` to get the enabled `LLMModel` rows (sorted by `priority` ascending, then `name`), filtered to the resolved category.
3. It calls `batchResolveModelAuth` to merge each candidate's own auth fields with its linked `ModelProviderCredential` (one query for all distinct `credential_id`s).
4. For each resolved candidate, `createChatModelForSavedModel` builds a LangChain `BaseChatModel`, producing an ordered list of `ChatModelSlot`s.
5. `invokeWithModelFallback` calls `invokeChatWithOutputTruncationContinuation` on the first slot; the call succeeds.
6. `runFileProcessingLlm` posts a `model_call` metric with `status: 'ok'`, the winning model's provider/id, token counts, and duration.

**Alternate Flows:**
- A1 — Provider outage or rate limit on the top-priority model: `isRetryableLlmError` classifies the error as transient (matches patterns like `429`, `rate`, `quota`, `timeout`, `econnreset`), so `invokeWithModelFallback` retries that same slot with exponential backoff (`baseDelayMs * 2^attempt` plus jitter) up to `retriesPerModel` times (default 2) before moving to the next slot in priority order, without failing the overall call.
- A2 — Hard failure on the top-priority model (e.g. bad API key, invalid request): `isRetryableLlmError` classifies it as non-retryable, so the fallback loop skips straight to the next slot instead of spending retries on it.
- A3 — One or more candidates are unusable at construction time (missing auth, missing base URL, unrecognized provider string): `createChatModelForSavedModel` returns `null` for those candidates rather than throwing; `runFileProcessingLlm` must exclude `null` results from the slot list before calling `invokeWithModelFallback` — a `null` is a "skip," never a fatal error.
- A4 — A provider response is cut off by the output-length limit: `invokeChatWithOutputTruncationContinuation` detects the truncating `finish_reason` (`finishReasonImpliesMaxOutputLength`), appends the partial reply plus a continuation user turn seeded with the tail of the output (`DEFAULT_CONTINUATION_USER_PROMPT`), and calls again, up to `maxContinuationRounds` (default 32, `FILE_PROCESSING_LLM_MAX_CONTINUATION_ROUNDS`); if the cap is hit while still truncated, `outputTruncated: true` is set and surfaced through to the metric.

**Exceptions:**
- E1 — Every slot in the chain is exhausted (all retries and rotations failed, or the resolved chain was empty because every candidate returned `null`): `runFileProcessingLlm` falls back to `getGeminiLLM(GEMINI_API_KEY)` (`src/llm.ts`), the hardcoded no-fallback Gemini client (`model: 'gemini-pro'`).
- E2 — `GEMINI_API_KEY` is also unset (or the env fallback call itself fails): `runFileProcessingLlm` posts a `model_call` metric with `error_code: 'no_llm_config'` and throws.
- E3 — `isRetryableLlmError`'s string/status heuristic is a known trade-off, not a provider-specific taxonomy: a provider that phrases a genuinely non-retryable error (e.g. a bad request) using a matched word (`rate`, `timeout`, etc.) would be retried unnecessarily before rotating past it. This is documented behavior, not a bug to silently narrow by tightening the regex without checking real provider error shapes first.

### UC2 — Admin shares one vendor credential across several saved models

**Goal:** Let several `LLMModel` rows from the same vendor authenticate through one centrally-rotated credential instead of duplicating an API key per row.

**Stakeholders:** Admins managing provider keys (want to rotate a key once, not per model row); platform operators (reduced risk of stale per-model keys after a rotation).

**Actors:** An admin (via the config UI); `ModelProviderCredential` (`src/db/models/ModelProviderCredential.ts`); `resolveModelAuthForLlm` / `batchResolveModelAuth` (`src/llm/resolveModelAuth.ts`).

**Preconditions:** The admin has a valid API key for the vendor and at least one `LLMModel` row for that vendor already exists or is being created.

**Postconditions:** Multiple `LLMModel` rows reference the same `ModelProviderCredential._id` via `credential_id`; resolving auth for any of those rows yields the credential's fields wherever the credential has non-empty values.

**Basic Course of Events (BCE):**
1. Admin creates one `ModelProviderCredential` document with the vendor's `access_key` (and, for local providers, `api_base_url`/`local_api_mode`).
2. Admin sets `credential_id` on multiple `LLMModel` rows to point at that credential instead of setting each row's own `access_key`.
3. At call time, `resolveModelAuthForLlm` (or the batch form for a whole candidate list) merges each row's own auth fields with the linked credential's fields, with the credential's non-empty fields overriding the row's field-by-field (not wholesale).
4. To rotate the key, the admin updates the single `ModelProviderCredential` document; every `LLMModel` row referencing it picks up the new key on its next resolution.

**Alternate Flows:**
- A1 — A row has both its own `access_key` and a `credential_id`: the credential's non-empty fields win per-field, so a row can still set fields the credential leaves blank (e.g. a row-specific `api_base_url` while sharing the credential's key) — the merge is never wholesale replacement.

**Exceptions:**
- E1 — A row has no `credential_id`: `resolveModelAuthForLlm` uses the row's own fields directly and no `ModelProviderCredential` lookup happens; `batchResolveModelAuth` skips the `find` call entirely if no row in the batch has a `credential_id`. This is expected behavior, not an error condition.
- E2 — Getting the override precedence backwards (row wins over credential) would silently use a stale per-model key instead of the shared, centrally-rotated one — this is flagged as a Sensitive Area precisely because the failure mode is silent, not an error.

### UC3 — Admin adds a local model via Ollama or LM Studio

**Goal:** Let an admin point a saved `LLMModel` at a locally-hosted model server instead of a cloud vendor, without a real API key.

**Stakeholders:** Admins running local inference (cost/privacy motivated); platform operators supporting mixed cloud/local fleets.

**Actors:** An admin (via the config UI); `createChatModelForSavedModel` (`src/llm/createChatModelForSavedModel.ts`); `verifyLocalConnection` (`src/stats/providerDiscovery.ts`).

**Preconditions:** A local Ollama or LM Studio server is running and reachable from the vault process.

**Postconditions:** A saved `LLMModel` row with `provider: 'local'` (or `ollama`/`lmstudio`), `api_base_url`, and `local_api_mode` set is usable by the fallback chain like any other model.

**Basic Course of Events (BCE):**
1. Admin sets the row's `provider` to `local`, `ollama`, or `lmstudio` (normalized to the same branch by `normalizeProvider`), `api_base_url` to the server's origin, and `local_api_mode` to `'ollama'` (native Ollama API) or `'openai'` (OpenAI-compatible `/v1` endpoint).
2. Before saving, the config UI calls `verifyLocalConnection` to confirm the base URL (and optionally a specific model tag) is reachable — pinging `/api/tags` for Ollama-mode or `/v1/models` for OpenAI-compatible mode.
3. At call time, `createChatModelForSavedModel` normalizes the base URL to an OpenAI-compatible `/v1` root (`ollamaOpenAiBase`) and constructs a `ChatOpenAI` instance pointed at it.
4. Since local servers typically have no real API key, `createChatModelForSavedModel` substitutes the literal placeholder string `'ollama'` (`PLACEHOLDER_LOCAL_KEY`) as the `ChatOpenAI` constructor's `apiKey` so the client doesn't reject an empty key.

**Alternate Flows:**
- A1 — The row does supply a real `access_key` (e.g. a hosted OpenAI-compatible endpoint requiring auth): that key is used instead of the placeholder.

**Exceptions:**
- E1 — The local server is unreachable at verification time: `verifyLocalConnection` reports the failure to the config UI before save, rather than deferring discovery of a bad endpoint to the first real file-processing call.
- E2 — The placeholder `'ollama'` string must never be treated as a real secret or leak into a "credential present" check — it is a constructor workaround, not a credential.

### UC4 — Config UI discovers a provider's live model catalog

**Goal:** Let an admin pick a real, currently-available model id/category from the vendor instead of typing one from memory when creating or editing an `LLMModel` row.

**Stakeholders:** Admins configuring models (want accurate, current model ids without guessing); platform operators (fewer misconfigured rows that fail at call time).

**Actors:** An admin (via the config UI); `discoverProviderModels` and per-vendor helpers (`src/stats/providerDiscovery.ts`).

**Preconditions:** The admin has a valid API key for the vendor being queried (or is targeting a preset/local server that doesn't require one).

**Postconditions:** The config UI is populated with a live list of `ProviderModel` entries (`id`, `name`, `label`, `capabilities`, optional `description`/`suggested_category`) for the admin to choose from before the `LLMModel` row is saved.

**Basic Course of Events (BCE):**
1. Admin opens the "add model" form for a given provider (OpenAI, Gemini, Anthropic, GitHub Models, or an OpenAI-compatible preset like Groq/Together/Mistral/OpenRouter/DeepSeek/etc.).
2. Config UI calls `discoverProviderModels(provider, apiKey, opts?)`, which dispatches to the matching vendor helper (`discoverOpenAiModels`, `discoverOpenAiCompatibleModels`, `discoverGeminiModels`, `discoverAnthropicModels`, `discoverGithubModelsCatalog`).
3. The helper queries the vendor's live model-list endpoint and maps the response into `ProviderModel[]`.
4. `suggestedCategoryForDiscoveredModel` heuristically assigns a `fast`/`blended`/`thinking` routing category per discovered model based on its id/label/description.
5. Admin selects a model from the returned list; the form fills in `name` and a suggested `categories` value instead of free-typed entry.

**Alternate Flows:**
- A1 — Provider is unrecognized by `discoverProviderModels`'s dispatch: it falls back to returning `[]` rather than throwing, so the UI can show "no models found" instead of erroring the whole form.
- A2 — The vendor endpoint host is detected as a GitHub Models host: `discoverProviderModels` routes to `discoverGithubModelsCatalog` with its catalog URL rewriting and auth headers instead of the generic OpenAI-compatible path.

**Exceptions:**
- E1 — The supplied API key is empty: `discoverProviderModels` short-circuits without calling the vendor endpoint.
- E2 — The vendor endpoint responds non-OK: the relevant `discover*Models` helper throws with the HTTP status rather than returning a partial or fabricated list.

### UC5 — Stats home dashboard consumes model_call metrics

**Goal:** Give platform operators visibility into LLM usage (token volume, latency, error rate) across every provider and pipeline without inspecting logs.

**Stakeholders:** Platform operators monitoring cost/latency/reliability; admins deciding whether to re-prioritize or replace a model in the chain.

**Actors:** `postModelCallMetric` (`src/llm/postModelCallMetric.ts`); `metricsClient.ts` (`postMetric`, queue-until-ready); the Stats home dashboard (consumer, not covered by this doc).

**Preconditions:** At least one `runFileProcessingLlm` invocation (saved-chain success/exhaustion or env-Gemini fallback/failure) has occurred and posted a metric.

**Postconditions:** The Stats home dashboard's token/latency percentile views reflect the newly posted `model_call` event.

**Basic Course of Events (BCE):**
1. `runFileProcessingLlm` reaches an outcome (`db_chain` success, `db_chain` exhaustion, or `env_gemini` fallback/failure) and calls `postModelCallMetric` with camelCase params.
2. `postModelCallMetric` builds one `operation: 'model_call'` event with snake_case `metadata` fields (`tokens_in`, `tokens_out`, `tokens_thinking`, `model_id`, `model_label`, `provider`, `file_path`, `file_processing_driver`, `continuation_rounds`, `output_truncated`, `last_finish_reason`) and posts it via the generic `postMetric` in `metricsClient.ts`.
3. `metricsClient.ts` queues the metric until the local stats server signals readiness, then flushes and sends it live.
4. The Stats home dashboard reads `tokens_in/out/thinking`, `duration_ms`, and `status` to feed token/latency percentile views, using `caller` (`file_processing_watcher` vs `scan_analyze_file`) and `file_processing_driver` (`prompt:<slug>` or `agent:<tool_name>`) to distinguish which pipeline and configured driver produced each call.

**Alternate Flows:**
- A1 — The call ended in the `no_llm_config` exception path (UC1 E2): the posted metric still records one event, with `status: 'error'` and `error_code: 'no_llm_config'`, so the dashboard can surface total misconfiguration incidents rather than silently dropping them.

**Exceptions:**
- E1 — Metrics never include raw prompt/response content — only token counts, provider/model identifiers, duration, and status/error code are forwarded. A dashboard feature that wants prompt/response text would require a deliberate, reviewed schema change to `PostModelCallMetricParams`, not an incidental addition.

## Tests

- `__tests__/llm.test.ts` — `getGeminiLLM` instantiates `ChatGoogleGenerativeAI` with the given key and hardcoded `model: 'gemini-pro'`.
- `__tests__/llmHelpers.test.ts` — `isRetryableLlmError` matches `429`/`rate limit`/`{status:503}` and rejects an unrelated message; `sleep` actually delays; `messageContentToString`/`baseMessageText` normalize string and block-array content; `extractTokenUsageFromAiMessage` reads both the `usage_metadata` and `response_metadata.token_usage` shapes.
- `__tests__/createChatModelForSavedModel.test.ts` — builds each of Google/OpenAI(-compatible)/Anthropic/local-OpenAI-mode successfully with the mocked LangChain constructors; returns `null` when the Google key is missing and when the provider string is unrecognized.
- `__tests__/invokeWithContinuation.test.ts` — `finishReasonImpliesMaxOutputLength` classifies `length`/`MAX_TOKENS`/`max_output_tokens` as truncated and `stop`/`STOP`/`END_TURN`/empty as complete; `invokeChatWithOutputTruncationContinuation` chains a length→stop pair into one merged text with `rounds: 2` and confirms the second `invoke` call carries the growing conversation (≥4 messages), and sets `outputTruncated: true` when the round cap is exhausted while still hitting `length`.
- `__tests__/invokeWithModelFallback.test.ts` — first model succeeds without touching the second; a non-retryable error on model 1 falls through to model 2; an exhausted single-model chain rethrows the original error; a retryable error on the same model succeeds on the second attempt without rotating.
- `__tests__/resolveModelAuth.test.ts` — credential fields override row fields when a `credential_id` resolves; row-only fields are used when there's no credential (and no DB lookup happens); `batchResolveModelAuth` performs exactly one `find` for the distinct credential ids and maps results back per input row, and skips the `find` call entirely when no row has a `credential_id`.
- `__tests__/vaultLlmModelsCache.test.ts` — a second read within the cache window does not re-hit `LLMModel.find`; `invalidateVaultLlmModelsCache()` forces the next read to re-query.
- `__tests__/postModelCallMetric.test.ts` — posts `operation: METRIC_OPERATION_MODEL_CALL`, correct `duration_ms`, and snake_case `metadata` (`tokens_in/out/thinking`, `model_id`, `model_label`, `file_path`) from the camelCase params.
- `__tests__/normalizeMetric.test.ts` — covers the generic metric-payload normalization (`resolveProjectKeyForMetricMetadata`, `ensureMetadataProjectKeyForRead`, `normalizeMetricPayload`) that all metrics including `model_call` pass through, including the `projectKey`/`projectName`/env-var precedence and defaulting to `'default'`.
- `__tests__/metric-model.test.ts` — `Metric` Mongoose model constructs with required fields, accepts optional `error_code`/`metadata`, and exercises the `status` enum.
- `__tests__/modelCategories.test.ts` — token normalization (`BLEND`→`blended`, case-insensitive built-ins, custom tokens like `Vision` pass through as-is), list dedup, empty-list default to `['fast']`, and doc-level legacy `category` vs `categories` resolution.
- `__tests__/providerDiscovery.test.ts` — `openAiCompatibleModelsListUrl` version-suffix handling; each vendor's `discover*Models` maps its response shape to `ProviderModel[]` and throws with the HTTP status on non-OK responses; `suggestedCategoryForDiscoveredModel` heuristics per vendor (Gemini flash-lite/flash/pro/flash-thinking, Anthropic haiku/opus/sonnet, OpenAI o1/o3/mini/gpt-4/5); GitHub Models catalog URL rewriting and auth headers; `discoverProviderModels` dispatch across presets, GitHub Models detection by host, empty-key short-circuit, and unknown-provider fallback to `[]`.

`__tests__/runFileProcessingLlm.test.ts` also exists and exercises the orchestration entry point end-to-end (not individually enumerated per the file list above, but it is the integration test tying the unit-tested pieces together).

## UI/UX

This subsystem itself is server-side (model invocation, retries, metrics) with no direct UI. It has two indirect UI touch points: the platform UI's model/credential config screens read and write `LLMModel`/`ModelProviderCredential` documents and call `discoverProviderModels`/`verifyLocalConnection` (in `src/stats/providerDiscovery.ts`) to populate and validate those forms; and the Stats home dashboard renders the `model_call` metrics (`tokens_in/out/thinking`, `duration_ms`, `status`) that `postModelCallMetric` emits. Neither UI is implemented in the files covered by this doc.

## Dependencies

- Depends on the storage layer (`docs/design/storage.md`) only insofar as both are Mongoose/Mongo-backed; `LLMModel`, `ModelProviderCredential`, and `Metric` are independent top-level collections, not part of the per-project `knowledge_base`/`FileProcessor` collections described there.
- Depends on LangChain's provider packages (`@langchain/openai`, `@langchain/anthropic`, `@langchain/google-genai`, `@langchain/core`) as the sole chat-model abstraction — no vendor SDK is called directly.
- `runFileProcessingLlm` depends on `Project` and `SystemPrompt` models and on `loadAgentExecutionBundleById` (agent execution bundle loader) to resolve the system prompt and category filter per project.
- The metrics path depends on `src/stats/metricsClient.ts` (`postMetric`, queue-until-ready HTTP POST to the local stats server) and `src/stats/normalizeMetric.ts` (project-key normalization shared by all metric operations, not specific to `model_call`).

## Diagrams

No diagram is currently maintained for this subsystem; the Architecture section's ordered list (config storage → cache → auth resolution → chat model construction → single-call continuation → multi-model fallback/retry → orchestration → metrics) is the closest thing to a flow description.

## References

- Original control-flow model: `getResponse` in the separate Mathsense codebase's `functions/modules/llmShared.js`, explicitly cited in `invokeWithContinuation.ts`'s comments as the source of the continuation-round logic being ported here.
- `docs/design/storage.md` — sibling design doc for the per-project Mongo collections; referenced above only for contrast (LLM config/metrics are global collections, not per-project).
