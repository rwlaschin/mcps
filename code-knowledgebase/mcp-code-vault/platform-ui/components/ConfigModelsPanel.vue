<template>
  <GlassCard class="!overflow-visible [&_input]:select-text [&_select]:select-text [&_textarea]:select-text">
    <div v-if="!savedModels.length" class="rounded-2xl border border-white/10 bg-black/20 px-4 py-14 text-center text-sm text-gray-500">
      No models yet. Use
      <StyleUiButton
        type="button"
        variant="link-accent"
        :disabled="actionPending"
        @click="openRemoteModal"
      >
        Add remote
      </StyleUiButton>
      <span class="text-gray-600"> or </span>
      <StyleUiButton
        type="button"
        variant="link-accent"
        :disabled="actionPending"
        @click="openLocalModal"
      >
        Add local
      </StyleUiButton>
      <span class="text-gray-600">.</span>
    </div>
    <div v-else class="space-y-2">
      <div
        v-for="group in modelsByProvider"
        :key="group.groupKey"
        class="rounded-2xl border border-white/10 overflow-clip bg-black/20"
      >
        <div class="flex items-stretch gap-1 border-b border-white/10">
          <button
            type="button"
            class="flex flex-1 min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.04] transition-colors"
            :aria-expanded="expanded[group.groupKey] === true"
            @click="toggleProvider(group.groupKey)"
          >
            <span
              class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white bg-gradient-to-br from-[var(--accent)] to-[var(--chart-pink)]"
              :aria-hidden="true"
            >{{ providerInitial(group.provider) }}</span>
            <div class="flex flex-col min-w-0 flex-1">
              <span class="text-sm font-semibold text-white leading-tight">{{ providerLabel(group.provider) }}</span>
              <span
                v-if="showAccountDisambiguation(group)"
                class="text-[10px] text-gray-500 truncate mt-0.5"
                :title="providerAccountHint(group)"
              >{{ providerAccountHint(group) }}</span>
            </div>
            <span class="text-xs text-gray-500 tabular-nums shrink-0">{{ group.models.length }} saved</span>
            <Icon
              name="lucide:chevron-down"
              class="size-5 text-gray-400 shrink-0 transition-transform duration-200"
              :class="expanded[group.groupKey] === true ? 'rotate-180' : ''"
              aria-hidden="true"
            />
          </button>
          <div class="flex items-center gap-1 pr-2 shrink-0" @click.stop>
            <StyleUiButton
              type="button"
              variant="icon"
              title="Edit in Add remote / Add local dialog (provider locked)"
              :aria-label="`Edit ${providerGroupTitle(group)}`"
              :disabled="actionPending"
              @click="startEditingProviderGroup(group)"
            >
              <Icon name="lucide:pencil" class="size-4" aria-hidden="true" />
            </StyleUiButton>
            <StyleUiButton
              type="button"
              variant="icon-danger"
              :title="
                group.models.length > 1
                  ? `Remove all ${group.models.length} models in ${providerGroupTitle(group)}`
                  : 'Remove model'
              "
              :aria-label="
                group.models.length > 1
                  ? `Remove all models in ${providerGroupTitle(group)}`
                  : `Remove ${group.models[0]!.label}`
              "
              :disabled="actionPending"
              @click.stop="requestDeleteProviderHeader(group)"
            >
              <Icon name="lucide:trash-2" class="size-4" aria-hidden="true" />
            </StyleUiButton>
          </div>
        </div>
        <div v-show="expanded[group.groupKey] === true">
          <div
            v-if="group.models.length > 1"
            class="px-4 py-2.5 border-b border-white/[0.06] flex items-baseline gap-2 min-w-0"
          >
            <span class="text-[10px] uppercase tracking-widest text-gray-500 shrink-0">Connection</span>
            <span
              class="text-[11px] text-gray-500 font-mono truncate min-w-0"
              :title="keyTitle(group.models[0]!)"
            >{{ endpointOrKeySummary(group.models[0]!) }}</span>
          </div>
          <div
            v-for="m in group.models"
            :key="m._id"
            class="px-4 py-4 border-b border-white/[0.06] last:border-b-0 flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6"
          >
            <div
              v-if="inlineDraft[m._id]"
              class="flex flex-col items-start gap-1.5 shrink-0 lg:pt-0.5"
            >
              <span class="text-[10px] uppercase tracking-widest text-gray-500">Active</span>
              <button
                type="button"
                role="switch"
                :aria-checked="inlineDraft[m._id].enabled"
                class="relative h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60"
                :class="inlineDraft[m._id].enabled ? 'bg-[var(--accent)]' : 'bg-white/15'"
                :disabled="actionPending"
                @click="inlineDraft[m._id].enabled = !inlineDraft[m._id].enabled"
              >
                <span
                  class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform"
                  :class="inlineDraft[m._id].enabled ? 'translate-x-5' : 'translate-x-0'"
                />
              </button>
            </div>
            <div class="min-w-0 flex-1 lg:min-w-[160px]">
              <div class="flex items-start gap-1">
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium text-white leading-snug">{{ m.label }}</div>
                  <div class="text-[11px] text-gray-400 font-mono mt-0.5 truncate" :title="m.name">{{ m.name }}</div>
                  <div
                    v-if="group.models.length <= 1"
                    class="text-[11px] text-gray-500 mt-0.5 truncate"
                    :title="keyTitle(m)"
                  >
                    {{ endpointOrKeySummary(m) }}
                  </div>
                </div>
                <div v-if="group.models.length > 1" class="flex items-center shrink-0 mt-0.5">
                  <StyleUiButton
                    type="button"
                    variant="icon-danger"
                    title="Remove this model"
                    :aria-label="`Remove ${m.label}`"
                    :disabled="actionPending"
                    @click="requestDelete(m)"
                  >
                    <Icon name="lucide:trash-2" class="size-4" aria-hidden="true" />
                  </StyleUiButton>
                </div>
              </div>
            </div>
            <div
              v-if="inlineDraft[m._id]"
              class="flex flex-col sm:flex-row flex-wrap gap-4 lg:gap-5 items-stretch sm:items-end flex-1 min-w-0"
            >
              <div class="min-w-[200px] max-w-md flex-1">
                <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">Categories</div>
                <ModelCategoriesInput v-model="inlineDraft[m._id].categories" />
              </div>
              <div class="w-full sm:w-24">
                <label class="text-[10px] uppercase tracking-widest text-gray-500 mb-1.5 block" :for="`pri-${m._id}`">Priority</label>
                <input
                  :id="`pri-${m._id}`"
                  v-model.number="inlineDraft[m._id].priority"
                  type="number"
                  min="0"
                  class="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
                />
              </div>
              <div class="flex shrink-0 sm:ml-auto lg:ml-0 sm:items-end">
                <StyleUiButton
                  type="button"
                  variant="icon"
                  title="Revert this row"
                  aria-label="Revert this row"
                  :disabled="actionPending || !isRowInlineDirty(m)"
                  @click="revertInlineRow(m)"
                >
                  <Icon name="lucide:undo-2" class="size-4" aria-hidden="true" />
                </StyleUiButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Remote wizard — v-if on Teleport avoids empty-teleport vnode bugs (null subTree / getNextHostNode). -->
    <Teleport v-if="remoteOpen" to="body">
      <div
        class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        @click.self="closeRemoteWizard"
      >
        <div
          class="w-full max-w-lg min-w-0 max-h-[min(90vh,720px)] flex flex-col rounded-2xl border border-white/10 bg-[var(--surface-card)] shadow-2xl shadow-black/50"
          role="dialog"
          aria-labelledby="remote-modal-title"
        >
          <div class="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
            <h3 id="remote-modal-title" class="text-base font-semibold text-white">
              {{ isRemoteWizardEdit ? 'Edit remote provider' : 'New remote model provider' }}
            </h3>
            <StyleUiButton type="button" variant="icon" aria-label="Close" @click="closeRemoteWizard">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
            </StyleUiButton>
          </div>
          <div class="px-5 py-4 space-y-4 overflow-y-auto overflow-x-hidden flex-1 min-h-0 min-w-0">
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1.5" for="wiz-provider">Provider</label>
              <select
                id="wiz-provider"
                v-model="providerForm.provider"
                :disabled="isRemoteWizardEdit"
                class="w-full rounded-xl border border-white/15 bg-black/30 pl-3 py-2.5 pe-10 text-sm text-white disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <option v-for="opt in wizardProviderSelectOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </div>
            <div v-if="needsCustomBaseUrl">
              <label class="block text-xs font-medium text-gray-400 mb-1.5" for="wiz-base-url">API base URL</label>
              <input
                id="wiz-base-url"
                v-model="providerForm.base_url"
                type="url"
                autocomplete="off"
                class="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-white font-mono placeholder:text-gray-600"
                placeholder="https://…/v1 or https://models.github.ai/inference"
              />
              <p v-if="fieldErrors.base_url" class="mt-1 text-xs text-red-300/90">{{ fieldErrors.base_url }}</p>
              <p class="mt-1.5 text-[11px] text-gray-500 leading-snug">
                Use the vendor’s OpenAI-compatible root (often ends with
                <span class="text-gray-400 font-mono">/v1</span>
                ). GitHub Models:
                <span class="text-gray-400 font-mono">https://models.github.ai/inference</span>
                and a PAT with the
                <span class="text-gray-400">models</span>
                scope — not the
                <span class="text-gray-400 font-mono">…/chat/completions</span>
                URL.
              </p>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1.5" for="wiz-key">API key</label>
              <div class="relative">
                <input
                  id="wiz-key"
                  v-model="providerForm.access_key"
                  :type="showRemoteKey ? 'text' : 'password'"
                  autocomplete="off"
                  class="w-full rounded-xl border border-white/15 bg-black/30 pl-3 pr-10 py-2.5 text-sm text-white"
                  :placeholder="isRemoteWizardEdit ? 'Leave blank to keep current key' : 'sk-…'"
                />
                <StyleUiButton
                  type="button"
                  variant="text"
                  class="absolute right-2 top-1/2 -translate-y-1/2"
                  @click="showRemoteKey = !showRemoteKey"
                >
                  {{ showRemoteKey ? 'Hide' : 'Show' }}
                </StyleUiButton>
              </div>
              <p v-if="fieldErrors.access_key" class="mt-1 text-xs text-red-300/90">{{ fieldErrors.access_key }}</p>
              <p v-else-if="isRemoteWizardEdit" class="mt-1 text-[11px] text-gray-500 leading-snug">
                Leave blank to keep the saved token.
                <span class="text-gray-600">Load models</span>
                and auto-refresh still use that stored key unless you paste a new one.
              </p>
              <p v-else class="mt-1 text-[11px] text-gray-500 leading-snug">
                Models load automatically shortly after you enter a key (custom hosts need the API base URL first).
              </p>
            </div>
            <div class="flex rounded-xl border border-white/10 p-0.5 bg-black/20">
                <StyleUiButton
                  type="button"
                  size="sm"
                  class="flex-1 !rounded-lg !py-2"
                  :variant="remoteTab === 'models' ? 'soft' : 'segment-inactive'"
                  @click="remoteTab = 'models'"
                >
                  Catalog
                </StyleUiButton>
                <StyleUiButton
                  type="button"
                  size="sm"
                  class="flex-1 !rounded-lg !py-2"
                  :variant="remoteTab === 'custom' ? 'soft' : 'segment-inactive'"
                  @click="remoteTab = 'custom'"
                >
                  Custom
                </StyleUiButton>
              </div>
              <div v-if="remoteTab === 'models'" class="flex flex-col gap-2">
                <div class="flex items-center gap-2">
                  <StyleUiButton type="button" variant="soft" size="sm" :disabled="actionPending" @click="runDiscover">
                    Load models
                  </StyleUiButton>
                  <label class="inline-flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                    <input
                      type="checkbox"
                      class="rounded border-white/20 bg-white/10"
                      :checked="allFilteredSelected"
                      @change="toggleSelectAll"
                    />
                    Select all (filtered)
                  </label>
                </div>
                <div class="flex items-center gap-2 min-w-0">
                  <input
                    id="wiz-discover-search"
                    v-model="discoverSearch"
                    type="search"
                    autocomplete="off"
                    placeholder="Filter catalog by name, id, description, or capability…"
                    class="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-gray-600"
                  />
                  <span
                    v-if="discoveredModels.length"
                    class="shrink-0 text-xs text-gray-500 tabular-nums whitespace-nowrap"
                    aria-live="polite"
                  >
                    <template v-if="discoverSearch.trim()">
                      {{ filteredDiscovered.length }}/{{ discoveredModels.length }}
                    </template>
                    <template v-else>
                      {{ discoveredModels.length }}
                    </template>
                    <span class="text-gray-600"> models</span>
                  </span>
                </div>
                <div class="max-h-60 overflow-y-auto overflow-x-hidden rounded-xl border border-white/10 bg-black/20">
                  <div
                    v-for="item in filteredDiscovered"
                    :key="item.id"
                    class="flex flex-col gap-3 px-3 py-3 hover:bg-white/[0.05] transition-colors border-b border-white/[0.06] last:border-b-0 min-w-0"
                  >
                  <label class="flex items-start gap-3 min-w-0 w-full cursor-pointer">
                    <input
                      v-model="selectedDiscovered"
                      type="checkbox"
                      :value="item.id"
                      class="mt-0.5 h-4 w-4 shrink-0 rounded border-white/25 bg-white/5 accent-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 focus-visible:ring-offset-0"
                    />
                    <div class="min-w-0 flex-1 overflow-hidden">
                      <div class="text-sm font-medium text-gray-100 leading-snug break-words">{{ item.label }}</div>
                      <div
                        class="text-xs text-gray-400 font-mono mt-0.5 break-all"
                        :title="item.name"
                      >
                        {{ item.name }}
                      </div>
                      <p
                        v-if="item.description?.trim()"
                        class="text-[11px] text-gray-500 leading-snug mt-1.5 line-clamp-4 break-words"
                        :title="item.description"
                      >
                        {{ item.description }}
                      </p>
                      <div
                        v-if="(item.capabilities ?? []).length"
                        class="flex flex-wrap gap-1 mt-2 max-h-20 overflow-y-auto overflow-x-hidden pr-0.5"
                      >
                        <span
                          v-for="c in item.capabilities ?? []"
                          :key="c"
                          class="text-[10px] leading-tight px-2 py-0.5 rounded-md bg-white/[0.07] text-gray-300 border border-white/10 font-medium tracking-wide max-w-full break-all"
                        >{{ c }}</span>
                      </div>
                    </div>
                  </label>
                  <div
                    class="flex flex-col gap-3 min-w-0 w-full border-t border-white/[0.08] pt-3 sm:flex-row sm:items-start sm:gap-4"
                    @click.stop
                  >
                    <div class="min-w-0 flex-1 sm:min-w-0">
                      <label class="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Categories</label>
                      <p
                        v-if="
                          item.suggested_category &&
                            remoteModelRow(item.id).categories?.length === 1 &&
                            remoteModelRow(item.id).categories[0] === item.suggested_category
                        "
                        class="text-[10px] text-gray-600 mb-1 leading-tight"
                      >
                        Default tier from discovery
                      </p>
                      <ModelCategoriesInput v-model="remoteModelRow(item.id).categories" />
                    </div>
                    <div class="w-full shrink-0 sm:w-24">
                      <label class="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Priority</label>
                      <input
                        v-model.number="remoteModelRow(item.id).priority"
                        type="number"
                        min="0"
                        class="w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-xs text-white"
                      />
                    </div>
                  </div>
                  </div>
                  <p
                    v-if="!discoveredModels.length"
                    class="px-3 py-6 text-center text-xs text-gray-500"
                  >
                    No models loaded. Enter a key and click Load models.
                  </p>
                  <p
                    v-else-if="!filteredDiscovered.length"
                    class="px-3 py-6 text-center text-xs text-gray-500"
                  >
                    No models match “{{ discoverSearch.trim() }}”. Try a shorter or different term.
                  </p>
                </div>
              </div>
            <template v-else>
              <label class="block text-xs text-gray-400 mb-1" for="wiz-custom">Custom model id</label>
              <input
                id="wiz-custom"
                v-model="saveForm.customName"
                type="text"
                class="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
                placeholder="e.g. gpt-4-turbo-preview"
              />
            </template>
            <div v-if="remoteTab === 'custom'" class="space-y-3">
              <div>
                <label class="block text-xs text-gray-400 mb-1">Categories</label>
                <ModelCategoriesInput v-model="saveForm.categories" />
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">Priority</label>
                <input
                  v-model.number="saveForm.priority"
                  type="number"
                  min="0"
                  class="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
                />
              </div>
            </div>
            <p v-else class="text-[11px] text-gray-500 leading-relaxed">
              Tier defaults from discovery when available; add custom tags (e.g. Vision) per model. A saved model can belong to multiple categories. Only checked rows are saved.
            </p>
            <p v-if="fieldErrors.save" class="text-xs text-red-300/90">{{ fieldErrors.save }}</p>
          </div>
          <div class="px-5 py-4 border-t border-white/10 flex justify-end gap-2 shrink-0">
            <StyleUiButton type="button" variant="secondary" @click="closeRemoteWizard">Cancel</StyleUiButton>
            <StyleUiButton type="button" size="lg" :disabled="actionPending" @click="submitRemoteSave">
              {{ isRemoteWizardEdit ? 'Save' : 'Add' }}
            </StyleUiButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Local -->
    <Teleport v-if="localOpen" to="body">
      <div
        class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        @click.self="closeLocalWizard"
      >
        <div class="w-full max-w-lg max-h-[min(90vh,760px)] flex flex-col rounded-2xl border border-white/10 bg-[var(--surface-card)] shadow-2xl">
          <div class="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
            <h3 class="text-base font-semibold text-white">
              {{ isLocalWizardEdit ? 'Edit local connection' : 'Add local model' }}
            </h3>
            <StyleUiButton type="button" variant="icon" aria-label="Close" @click="closeLocalWizard">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
            </StyleUiButton>
          </div>
          <div class="px-5 py-4 space-y-3 overflow-y-auto flex-1 min-h-0">
            <p class="text-xs text-gray-500 leading-relaxed">
              Point the vault at a server the <span class="text-gray-400">stats / MCP host</span> can reach (same machine →
              <span class="font-mono text-gray-400">http://127.0.0.1:…</span>). <strong class="text-gray-400">Ollama</strong> uses the HTTP API on port
              11434 (<span class="font-mono text-gray-500">/api/tags</span>, <span class="font-mono text-gray-500">/api/chat</span>).
              <strong class="text-gray-400">LM Studio / vLLM / LocalAI</strong> usually expose an OpenAI-compatible API — base URL typically ends with
              <span class="font-mono text-gray-500">/v1</span> and lists models at <span class="font-mono text-gray-500">/v1/models</span>.
            </p>
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1.5" for="loc-mode">Local API</label>
              <select
                id="loc-mode"
                v-model="localForm.local_api_mode"
                class="w-full rounded-xl border border-white/15 bg-black/30 pl-3 py-2.5 pe-10 text-sm text-white"
              >
                <option value="ollama">Ollama (native HTTP API)</option>
                <option value="openai">OpenAI-compatible (LM Studio, vLLM, LocalAI, …)</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1.5" for="loc-base">Base URL</label>
              <input
                id="loc-base"
                v-model="localForm.api_base_url"
                type="url"
                autocomplete="off"
                class="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-white font-mono placeholder:text-gray-600"
                :placeholder="localBasePlaceholder"
              />
            </div>
            <p v-if="localWizardConnectionOnly" class="text-[11px] text-amber-200/80 leading-snug">
              This account has multiple saved models. Here you can change the shared base URL, API style, and optional token. Edit model id, label, and tiers on each row in the list.
            </p>
            <template v-else>
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1.5" for="loc-name">Model id / tag</label>
                <input
                  id="loc-name"
                  v-model="localForm.name"
                  type="text"
                  class="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-white font-mono"
                  :placeholder="localModelPlaceholder"
                />
                <p class="mt-1 text-[11px] text-gray-600">{{ localModelHint }}</p>
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1.5" for="loc-label">Display name</label>
                <input
                  id="loc-label"
                  v-model="localForm.label"
                  type="text"
                  class="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-white"
                  placeholder="optional — defaults to model id"
                />
              </div>
            </template>
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1.5" for="loc-lkey">API key (optional)</label>
              <div class="relative">
                <input
                  id="loc-lkey"
                  v-model="localForm.access_key"
                  :type="showLocalKey ? 'text' : 'password'"
                  autocomplete="off"
                  class="w-full rounded-xl border border-white/15 bg-black/30 pl-3 pr-14 py-2.5 text-sm text-white"
                  placeholder="Bearer token if your local server requires it"
                />
                <StyleUiButton
                  type="button"
                  variant="text"
                  class="absolute right-2 top-1/2 -translate-y-1/2"
                  @click="showLocalKey = !showLocalKey"
                >
                  {{ showLocalKey ? 'Hide' : 'Show' }}
                </StyleUiButton>
              </div>
            </div>
            <div v-if="!localWizardConnectionOnly">
              <label class="block text-xs text-gray-400 mb-1">Categories</label>
              <ModelCategoriesInput v-model="localForm.categories" />
            </div>
            <div v-if="!localWizardConnectionOnly">
              <label class="block text-xs text-gray-400 mb-1">Priority</label>
              <input v-model.number="localForm.priority" type="number" min="0" class="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white" />
            </div>
            <p v-if="localError" class="text-xs text-red-300/90">{{ localError }}</p>
          </div>
          <div class="px-5 py-4 border-t border-white/10 flex flex-wrap justify-end gap-2 shrink-0">
            <StyleUiButton
              type="button"
              variant="muted"
              :disabled="actionPending || verifyLocalPending"
              @click="runVerifyLocal"
            >
              {{ verifyLocalPending ? 'Testing…' : 'Test connection' }}
            </StyleUiButton>
            <StyleUiButton type="button" variant="secondary" @click="closeLocalWizard">Cancel</StyleUiButton>
            <StyleUiButton type="button" size="lg" :disabled="actionPending" @click="submitLocal">
              {{ isLocalWizardEdit ? 'Save' : 'Add' }}
            </StyleUiButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete confirm (single model or whole provider) -->
    <Teleport v-if="deleteTarget || deleteBulkTarget" to="body">
      <div
        class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        @click.self="clearDeleteModals"
      >
        <div v-if="deleteTarget" class="w-full max-w-sm rounded-2xl border border-white/10 bg-[var(--surface-card)] p-5">
          <p class="text-sm text-white mb-2">Remove this model?</p>
          <p class="text-xs text-gray-500 mb-4">{{ deleteTarget.label }} <span class="text-gray-600">({{ deleteTarget.name }})</span></p>
          <div class="flex justify-end gap-2">
            <StyleUiButton type="button" variant="secondary" @click="clearDeleteModals">Cancel</StyleUiButton>
            <StyleUiButton type="button" variant="danger" :disabled="actionPending" @click="confirmDeleteDo">
              Remove
            </StyleUiButton>
          </div>
        </div>
        <div v-else-if="deleteBulkTarget" class="w-full max-w-sm rounded-2xl border border-white/10 bg-[var(--surface-card)] p-5">
          <p class="text-sm text-white mb-2">Remove all models in this provider?</p>
          <p class="text-xs text-gray-500 mb-4">
            {{ deleteBulkTarget.providerLabel }} — {{ deleteBulkTarget.ids.length }} model(s) will be removed.
          </p>
          <div class="flex justify-end gap-2">
            <StyleUiButton type="button" variant="secondary" @click="clearDeleteModals">Cancel</StyleUiButton>
            <StyleUiButton type="button" variant="danger" :disabled="actionPending" @click="confirmBulkDeleteDo">
              Remove all
            </StyleUiButton>
          </div>
        </div>
      </div>
    </Teleport>
  </GlassCard>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import ModelCategoriesInput from './ModelCategoriesInput.vue'
import { categoriesFromSavedModel, defaultModelCategoriesIfEmpty } from '../lib/modelCategories'
import { mongoIdString } from '../lib/mongoId'

/** Debounce API key → model list fetch so pasting a key loads models without clicking "Load models". */
const AUTO_DISCOVER_MS = 400

/** Which provider accordions are open. Absent keys default closed; only `true` is persisted. */
const PROVIDER_EXPANDED_STORAGE_KEY = 'mcp-code-vault:config-models-provider-expanded'

function providerExpandedStorageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function readProviderExpandedFromStorage(): Record<string, true> {
  if (!providerExpandedStorageAvailable()) return {}
  try {
    const raw = localStorage.getItem(PROVIDER_EXPANDED_STORAGE_KEY)
    if (!raw) return {}
    const o = JSON.parse(raw) as unknown
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: Record<string, true> = {}
    for (const [k, v] of Object.entries(o)) {
      if (v === true) out[k] = true
    }
    return out
  } catch {
    return {}
  }
}

function writeProviderExpandedToStorage(openKeys: Record<string, true>) {
  if (!providerExpandedStorageAvailable()) return
  try {
    localStorage.setItem(PROVIDER_EXPANDED_STORAGE_KEY, JSON.stringify(openKeys))
  } catch {
    // quota / private mode
  }
}

interface DiscoveredModel {
  id: string
  name: string
  label: string
  capabilities: string[]
  description?: string
  suggested_category?: 'fast' | 'blended' | 'thinking'
}

interface SavedModel {
  _id: string
  provider: string
  name: string
  label: string
  /** Mongo id of `model_provider_credentials` row — shared by all models saved in one Add-remote / Add-local flow. */
  credential_id?: string
  category?: 'fast' | 'blended' | 'thinking'
  categories?: string[]
  priority?: number
  access_key?: string
  api_base_url?: string
  local_api_mode?: 'ollama' | 'openai'
  enabled?: boolean
  capabilities?: string[]
  is_custom?: boolean
}

type ProviderModelGroup = {
  groupKey: string
  provider: string
  models: SavedModel[]
}

const props = withDefaults(
  defineProps<{
    discoveredModels: DiscoveredModel[]
    savedModels: SavedModel[]
    actionPending?: boolean
    verifyLocalPending?: boolean
  }>(),
  { verifyLocalPending: false }
)

const emit = defineEmits<{
  (
    e: 'discover',
    payload: { provider: string; access_key: string; base_url?: string },
    options?: { quiet?: boolean }
  ): void
  (e: 'clear-discovered'): void
  (
    e: 'save-models',
    payload: {
      provider: string
      access_key: string
      base_url?: string
      selectedIds: string[]
      customName?: string
      categories: string[]
      priority: number
      /** Per discovered-model id when adding from the Models tab (checked rows only). */
      perModel?: Record<string, { categories: string[]; priority: number }>
    }
  ): void
  (
    e: 'save-local',
    payload: {
      name: string
      label: string
      categories: string[]
      priority: number
      api_base_url: string
      local_api_mode: 'ollama' | 'openai'
      access_key?: string
    }
  ): void
  (
    e: 'verify-local',
    payload: {
      api_base_url: string
      local_api_mode: 'ollama' | 'openai'
      access_key?: string
      model_name?: string
    }
  ): void
  (e: 'delete-model', id: string): void
  (e: 'delete-models', ids: string[]): void
  (
    e: 'batch-save-inline',
    updates: Array<{ id: string; body: { categories: string[]; priority: number; enabled: boolean } }>
  ): void
  (e: 'update:inline-dirty', value: boolean): void
}>()

/** Match `normalizeLlmProviderId` in stats `config.ts` so the wizard select aligns with saved rows. */
function normalizeSavedProviderForWizard(raw: string | undefined): string {
  const p = String(raw ?? 'unknown').trim().toLowerCase()
  if (p === 'google') return 'gemini'
  return p || 'unknown'
}

/** Keep provider values in sync with `OPENAI_COMPATIBLE_PRESETS` + specials in `src/stats/providerDiscovery.ts`. */
const providerOptions = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'deepinfra', label: 'DeepInfra' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'fireworks', label: 'Fireworks AI' },
  { value: 'glm', label: 'Zhipu GLM' },
  { value: 'groq', label: 'Groq' },
  { value: 'hyperbolic', label: 'Hyperbolic' },
  { value: 'lepton', label: 'Lepton AI' },
  { value: 'mistral', label: 'Mistral AI' },
  { value: 'moonshot', label: 'Moonshot (Kimi)' },
  { value: 'nebius', label: 'Nebius AI Studio' },
  { value: 'novita', label: 'Novita AI' },
  { value: 'nvidia', label: 'NVIDIA NIM' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'perplexity', label: 'Perplexity' },
  { value: 'sambanova', label: 'SambaNova' },
  { value: 'siliconflow', label: 'SiliconFlow' },
  { value: 'together', label: 'Together AI' },
  { value: 'xai', label: 'xAI (Grok)' },
  { value: 'openai_compatible', label: 'Custom (OpenAI-compatible base URL)' }
]

/** If the DB has a legacy slug not in the preset list, still expose it so the edit dialog shows the real provider. */
const wizardProviderSelectOptions = computed(() => {
  const p = providerForm.provider.trim()
  if (p && !providerOptions.some((o) => o.value === p)) {
    return [...providerOptions, { value: p, label: `${p} (saved)` }]
  }
  return providerOptions
})

const remoteOpen = ref(false)
const localOpen = ref(false)
const showRemoteKey = ref(false)
const remoteTab = ref<'models' | 'custom'>('models')
const discoverSearch = ref('')
const pendingRemoteSave = ref(false)
const deleteTarget = ref<SavedModel | null>(null)
const deleteBulkTarget = ref<{ ids: string[]; providerLabel: string } | null>(null)

const selectedDiscovered = ref<string[]>([])
const providerForm = reactive({ provider: 'openai', access_key: '', base_url: '' })
const saveForm = reactive({
  categories: ['fast'] as string[],
  priority: 100,
  customName: ''
})
/** Categories / priority for each id in `discoveredModels` (Models tab). */
const remoteModelOptions = reactive({} as Record<string, { categories: string[]; priority: number }>)

/** Always returns a row object for catalog v-model (avoids undefined during render). */
function remoteModelRow(id: string): { categories: string[]; priority: number } {
  if (!(id in remoteModelOptions)) {
    const disc = props.discoveredModels.find((d) => d.id === id)
    const sc = disc?.suggested_category ?? 'fast'
    remoteModelOptions[id] = {
      categories: defaultModelCategoriesIfEmpty([sc]),
      priority: 100
    }
  }
  return remoteModelOptions[id]!
}

const localForm = reactive({
  name: '',
  label: '',
  categories: ['fast'] as string[],
  priority: 100,
  api_base_url: '',
  local_api_mode: 'ollama' as 'ollama' | 'openai',
  access_key: ''
})
const showLocalKey = ref(false)
const localError = ref('')

const fieldErrors = reactive({
  access_key: '',
  base_url: '',
  save: ''
})

const needsCustomBaseUrl = computed(() => providerForm.provider === 'openai_compatible')

const localBasePlaceholder = computed(() =>
  localForm.local_api_mode === 'ollama'
    ? 'http://127.0.0.1:11434'
    : 'http://127.0.0.1:1234/v1'
)

const localModelPlaceholder = computed(() =>
  localForm.local_api_mode === 'ollama' ? 'llama3.2 or llama3.2:latest' : 'model-id-from-/v1/models'
)

const localModelHint = computed(() =>
  localForm.local_api_mode === 'ollama'
    ? 'Must match a name from `ollama list` / GET /api/tags (with or without :latest).'
    : 'Must match an id returned by GET …/v1/models in the local server.'
)

const verifyLocalPending = computed(() => props.verifyLocalPending)

const inlineDraft = reactive<Record<string, { categories: string[]; priority: number; enabled: boolean }>>({})
const expanded = reactive<Record<string, boolean>>(
  providerExpandedStorageAvailable() ? { ...readProviderExpandedFromStorage() } : {}
)

/** Reuse Add-remote wizard to edit an existing account (`null` = create flow). */
const remoteEditModelIds = ref<string[] | null>(null)
/** When the key field is empty, discovery still uses this stored key. */
const remoteEditFallbackKey = ref('')
const remoteWizardHydrating = ref(false)
const remoteEditCatalogSeeded = ref(false)

const localEditModelIds = ref<string[] | null>(null)
/** Multiple models under one local credential — only connection fields in the modal. */
const localWizardConnectionOnly = ref(false)

const isRemoteWizardEdit = computed(() => remoteEditModelIds.value != null && remoteEditModelIds.value.length > 0)
const isLocalWizardEdit = computed(() => localEditModelIds.value != null && localEditModelIds.value.length > 0)

function persistProviderExpandedState() {
  const open: Record<string, true> = {}
  for (const k of Object.keys(expanded)) {
    if (expanded[k] === true) open[k] = true
  }
  writeProviderExpandedToStorage(open)
}

function modelInlineBaseline(m: SavedModel) {
  return {
    categories: categoriesFromSavedModel(m),
    priority: m.priority ?? 100,
    enabled: m.enabled !== false
  }
}

const modelsByProvider = computed((): ProviderModelGroup[] => {
  const map = new Map<string, SavedModel[]>()
  for (const m of props.savedModels) {
    const p = normalizeSavedProviderForWizard(m.provider)
    const ck = (m.credential_id ?? '').toString().trim()
    const groupKey = `${p}\0${ck}`
    if (!map.has(groupKey)) map.set(groupKey, [])
    map.get(groupKey)!.push(m)
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([groupKey, models]) => ({
      groupKey,
      provider: normalizeSavedProviderForWizard(models[0]!.provider),
      models: [...models].sort(
        (x, y) => (x.priority ?? 100) - (y.priority ?? 100) || x.label.localeCompare(y.label)
      )
    }))
})

const providerRowCountByVendorId = computed(() => {
  const counts = new Map<string, number>()
  for (const g of modelsByProvider.value) {
    counts.set(g.provider, (counts.get(g.provider) ?? 0) + 1)
  }
  return counts
})

function showAccountDisambiguation(group: ProviderModelGroup): boolean {
  return (providerRowCountByVendorId.value.get(group.provider) ?? 0) > 1
}

function firstAccessKeyInGroup(models: SavedModel[]): string {
  for (const x of models) {
    const k = x.access_key?.trim()
    if (k) return k
  }
  return ''
}

function firstApiBaseInGroup(models: SavedModel[], provider: string): string {
  if (provider !== 'openai_compatible') return ''
  for (const x of models) {
    const b = x.api_base_url?.trim()
    if (b) return b
  }
  return ''
}

function providerAccountHint(group: ProviderModelGroup): string {
  const m = group.models[0]
  if (!m) return ''
  const line = endpointOrKeySummary(m)
  if (!showAccountDisambiguation(group)) return line
  const cid = (m.credential_id ?? '').toString().replace(/\s/g, '')
  if (cid.length >= 6) return `${line} · acct …${cid.slice(-6)}`
  if (cid.length) return `${line} · acct …${cid}`
  return line
}

function providerGroupTitle(group: ProviderModelGroup): string {
  const base = providerLabel(group.provider)
  if (!showAccountDisambiguation(group)) return base
  const hint = providerAccountHint(group)
  return hint ? `${base} (${hint})` : base
}

function openRemoteModalForEdit(group: ProviderModelGroup) {
  clearAutoDiscoverTimer()
  remoteTab.value = 'models'
  fieldErrors.access_key = ''
  fieldErrors.save = ''
  fieldErrors.base_url = ''
  discoverSearch.value = ''
  saveForm.customName = ''
  remoteEditCatalogSeeded.value = false
  remoteEditModelIds.value = group.models.map((m) => m._id)
  const m = group.models[0]!
  const prov = normalizeSavedProviderForWizard(m.provider)
  remoteEditFallbackKey.value = firstAccessKeyInGroup(group.models)
  remoteWizardHydrating.value = true
  try {
    providerForm.provider = prov
    providerForm.base_url = prov === 'openai_compatible' ? firstApiBaseInGroup(group.models, prov) : ''
    providerForm.access_key = ''
  } finally {
    void nextTick(() => {
      remoteWizardHydrating.value = false
    })
  }
  remoteOpen.value = true
}

function openLocalModalForEdit(group: ProviderModelGroup) {
  localError.value = ''
  const m = group.models[0]!
  localEditModelIds.value = group.models.map((x) => x._id)
  localWizardConnectionOnly.value = group.models.length > 1
  localForm.api_base_url = m.api_base_url ?? ''
  localForm.local_api_mode = m.local_api_mode === 'openai' ? 'openai' : 'ollama'
  localForm.access_key = ''
  localForm.name = m.name
  localForm.label = m.label
  localForm.categories = [...categoriesFromSavedModel(m)]
  localForm.priority = m.priority ?? 100
  showLocalKey.value = false
  localOpen.value = true
}

function startEditingProviderGroup(group: ProviderModelGroup) {
  if (group.provider === 'local') {
    openLocalModalForEdit(group)
  } else {
    openRemoteModalForEdit(group)
  }
}

watch(
  () => props.savedModels,
  (list) => {
    for (const id of Object.keys(inlineDraft)) {
      if (!list.some((m) => m._id === id)) delete inlineDraft[id]
    }
    for (const m of list) {
      if (!(m._id in inlineDraft)) {
        const b = modelInlineBaseline(m)
        inlineDraft[m._id] = { categories: [...b.categories], priority: b.priority, enabled: b.enabled }
      }
    }
  },
  { deep: true, immediate: true }
)

function isRowInlineDirty(m: SavedModel): boolean {
  const d = inlineDraft[m._id]
  if (!d) return false
  const b = modelInlineBaseline(m)
  if (d.enabled !== b.enabled || d.priority !== b.priority) return true
  return [...d.categories].sort().join('\0') !== [...b.categories].sort().join('\0')
}

function revertInlineRow(m: SavedModel) {
  const b = modelInlineBaseline(m)
  inlineDraft[m._id] = { categories: [...b.categories], priority: b.priority, enabled: b.enabled }
}

function toggleProvider(p: string) {
  if (expanded[p] === true) {
    delete expanded[p]
  } else {
    expanded[p] = true
  }
  persistProviderExpandedState()
}

watch(
  modelsByProvider,
  (groups) => {
    const keys = new Set(groups.map((g) => g.groupKey))
    for (const k of Object.keys(expanded)) {
      if (!keys.has(k)) delete expanded[k]
    }
    persistProviderExpandedState()
  },
  { immediate: true }
)

const isInlineDirty = computed(() => {
  for (const m of props.savedModels) {
    const d = inlineDraft[m._id]
    if (!d) continue
    const b = modelInlineBaseline(m)
    if (d.enabled !== b.enabled || d.priority !== b.priority) return true
    if ([...d.categories].sort().join('\0') !== [...b.categories].sort().join('\0')) return true
  }
  return false
})

watch(isInlineDirty, (v) => emit('update:inline-dirty', v), { immediate: true })

function collectDirtyInlineUpdates() {
  const updates: Array<{ id: string; body: { categories: string[]; priority: number; enabled: boolean } }> = []
  for (const m of props.savedModels) {
    const d = inlineDraft[m._id]
    if (!d) continue
    const b = modelInlineBaseline(m)
    const catChanged = [...d.categories].sort().join('\0') !== [...b.categories].sort().join('\0')
    const priChanged = d.priority !== b.priority
    const enChanged = d.enabled !== b.enabled
    if (catChanged || priChanged || enChanged) {
      updates.push({
        id: m._id,
        body: {
          categories: defaultModelCategoriesIfEmpty([...d.categories]),
          priority: Math.min(999999, Math.floor(Number(d.priority) || 0)),
          enabled: d.enabled
        }
      })
    }
  }
  return updates
}

function flushInlineSave() {
  const updates = collectDirtyInlineUpdates()
  if (updates.length) emit('batch-save-inline', updates)
}

watch(
  () => providerForm.provider,
  () => {
    if (remoteWizardHydrating.value) return
    fieldErrors.access_key = ''
    fieldErrors.base_url = ''
    fieldErrors.save = ''
    providerForm.access_key = ''
    showRemoteKey.value = false
    discoverSearch.value = ''
    saveForm.customName = ''
    saveForm.categories = ['fast']
    saveForm.priority = 100
    if (providerForm.provider !== 'openai_compatible') providerForm.base_url = ''
    emit('clear-discovered')
  }
)

function discoveredModelMatchesQuery(m: DiscoveredModel, q: string): boolean {
  if (!q) return true
  const id = String(m.id ?? '').toLowerCase()
  const name = String(m.name ?? '').toLowerCase()
  const label = String(m.label ?? '').toLowerCase()
  const desc = String(m.description ?? '').toLowerCase()
  return (
    id.includes(q) ||
    name.includes(q) ||
    label.includes(q) ||
    desc.includes(q) ||
    (m.capabilities ?? []).some((c) => String(c).toLowerCase().includes(q))
  )
}

const filteredDiscovered = computed(() => {
  const q = discoverSearch.value.trim().toLowerCase()
  if (!q) return props.discoveredModels
  return props.discoveredModels.filter((m) => discoveredModelMatchesQuery(m, q))
})

const allFilteredSelected = computed(() => {
  const ids = filteredDiscovered.value.map((m) => m.id)
  return ids.length > 0 && ids.every((id) => selectedDiscovered.value.includes(id))
})

watch(
  () => props.discoveredModels,
  (models) => {
    const editIds = remoteEditModelIds.value
    if (!editIds?.length) {
      selectedDiscovered.value = []
    } else if (models.length && !remoteEditCatalogSeeded.value) {
      const savedNames = new Set(
        props.savedModels.filter((m) => editIds.includes(m._id)).map((m) => m.name)
      )
      selectedDiscovered.value = models.filter((d) => savedNames.has(d.name)).map((d) => d.id)
      remoteEditCatalogSeeded.value = true
    }
    for (const m of models) {
      if (!(m.id in remoteModelOptions)) {
        const sc = m.suggested_category ?? 'fast'
        remoteModelOptions[m.id] = {
          categories: defaultModelCategoriesIfEmpty([sc]),
          priority: 100
        }
      }
    }
    for (const k of Object.keys(remoteModelOptions)) {
      if (!models.some((m) => m.id === k)) delete remoteModelOptions[k]
    }
  },
  { deep: true, flush: 'sync', immediate: true }
)

function providerLabel(p: string): string {
  const x = p.toLowerCase()
  if (x === 'openai') return 'OPENAI'
  if (x === 'anthropic') return 'ANTHROPIC'
  if (x === 'gemini' || x === 'google') return 'GEMINI'
  if (x === 'openai_compatible') return 'OPENAI-COMPAT'
  if (x === 'local') return 'LOCAL'
  return p.toUpperCase()
}

function providerInitial(p: string): string {
  const x = p.toLowerCase()
  if (x === 'openai') return 'O'
  if (x === 'anthropic') return 'A'
  if (x === 'gemini' || x === 'google') return 'G'
  if (x === 'openai_compatible') return '+'
  if (x === 'local') return 'L'
  return (p[0] ?? '?').toUpperCase()
}

function endpointOrKeySummary(m: SavedModel): string {
  if (m.provider === 'local') {
    const base = m.api_base_url?.trim()
    if (!base) return '— no base URL'
    try {
      const u = new URL(base)
      const mode = m.local_api_mode === 'openai' ? 'OpenAI' : 'Ollama'
      const port = u.port || (u.protocol === 'https:' ? '443' : '80')
      return `${mode} · ${u.hostname}:${port}`
    } catch {
      return base.length > 40 ? `${base.slice(0, 38)}…` : base
    }
  }
  if (m.provider === 'openai_compatible') {
    const base = m.api_base_url?.trim()
    const k = m.access_key?.trim()
    const keyHint = !k ? '' : k.length <= 8 ? ' · ••••••••' : ` · ${k.slice(0, 4)}…${k.slice(-4)}`
    if (base) {
      return base.length > 36 ? `${base.slice(0, 34)}…${keyHint}` : `${base}${keyHint}`
    }
    if (k) {
      return k.length <= 8 ? '••••••••' : `${k.slice(0, 4)}…${k.slice(-4)}`
    }
    return '— no base URL'
  }
  const k = m.access_key?.trim()
  if (!k) return '—'
  if (k.length <= 8) return '••••••••'
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}

function keyTitle(m: SavedModel): string {
  if (m.provider === 'local') {
    const lines = [
      m.api_base_url ? `Base: ${m.api_base_url}` : '',
      m.local_api_mode ? `Mode: ${m.local_api_mode}` : '',
      `Model id: ${m.name}`,
      m.access_key?.trim() ? 'Optional bearer token stored' : ''
    ]
    return lines.filter(Boolean).join('\n')
  }
  return m.access_key ? 'Stored key (masked in UI)' : 'No key stored'
}

function closeRemoteWizard() {
  clearAutoDiscoverTimer()
  remoteOpen.value = false
  remoteEditModelIds.value = null
  remoteEditFallbackKey.value = ''
  remoteEditCatalogSeeded.value = false
  remoteWizardHydrating.value = false
}

function closeLocalWizard() {
  localOpen.value = false
  localEditModelIds.value = null
  localWizardConnectionOnly.value = false
}

function openRemoteModal() {
  remoteTab.value = 'models'
  fieldErrors.access_key = ''
  fieldErrors.base_url = ''
  fieldErrors.save = ''
  remoteEditModelIds.value = null
  remoteEditFallbackKey.value = ''
  remoteEditCatalogSeeded.value = false
  remoteWizardHydrating.value = false
  providerForm.provider = 'openai'
  providerForm.base_url = ''
  providerForm.access_key = ''
  discoverSearch.value = ''
  emit('clear-discovered')
  remoteOpen.value = true
}

function openLocalModal() {
  localError.value = ''
  localEditModelIds.value = null
  localWizardConnectionOnly.value = false
  localForm.name = ''
  localForm.label = ''
  localForm.categories = ['fast']
  localForm.priority = 100
  localForm.api_base_url = ''
  localForm.local_api_mode = 'ollama'
  localForm.access_key = ''
  showLocalKey.value = false
  localOpen.value = true
}

function requestDeleteProviderHeader(group: ProviderModelGroup) {
  deleteTarget.value = null
  if (!group.models.length) return
  if (group.models.length === 1) {
    requestDelete(group.models[0]!)
    return
  }
  deleteBulkTarget.value = {
    ids: group.models.map((m) => mongoIdString(m._id)).filter(Boolean),
    providerLabel: providerGroupTitle(group)
  }
}

function clearDeleteModals() {
  deleteTarget.value = null
  deleteBulkTarget.value = null
}

function runVerifyLocal() {
  localError.value = ''
  const api_base_url = localForm.api_base_url.trim()
  if (!api_base_url) {
    localError.value = 'Enter a base URL, then test (stats server must reach this host).'
    return
  }
  if (!/^https?:\/\//i.test(api_base_url)) {
    localError.value = 'Base URL must start with http:// or https://.'
    return
  }
  emit('verify-local', {
    api_base_url,
    local_api_mode: localForm.local_api_mode,
    access_key: localForm.access_key.trim() || undefined,
    model_name: localForm.name.trim() || undefined
  })
}

function getDiscoverPayload(): { provider: string; access_key: string; base_url?: string } | null {
  const typed = providerForm.access_key.trim()
  const fallback = remoteEditFallbackKey.value.trim()
  const access_key = typed || fallback
  if (!access_key) return null
  const provider = providerForm.provider.trim()
  if (provider === 'openai_compatible') {
    const base_url = providerForm.base_url.trim()
    if (!base_url) return null
    return { provider, access_key, base_url }
  }
  return { provider, access_key }
}

function runDiscover() {
  fieldErrors.access_key = ''
  fieldErrors.base_url = ''
  const p = getDiscoverPayload()
  if (!p) {
    if (!providerForm.access_key.trim() && !remoteEditFallbackKey.value.trim()) {
      fieldErrors.access_key = 'API key is required to load models.'
    } else {
      fieldErrors.base_url = 'Paste the OpenAI-compatible API base URL (usually ends with /v1).'
    }
    return
  }
  emit('discover', p)
}

let autoDiscoverTimer: ReturnType<typeof setTimeout> | null = null
function clearAutoDiscoverTimer() {
  if (autoDiscoverTimer) {
    clearTimeout(autoDiscoverTimer)
    autoDiscoverTimer = null
  }
}

watch(
  () =>
    [
      remoteOpen.value,
      remoteTab.value,
      providerForm.provider,
      providerForm.access_key,
      providerForm.base_url
    ] as const,
  () => {
    clearAutoDiscoverTimer()
    if (!remoteOpen.value || remoteTab.value !== 'models') return
    autoDiscoverTimer = setTimeout(() => {
      autoDiscoverTimer = null
      const p = getDiscoverPayload()
      if (!p) {
        emit('clear-discovered')
        return
      }
      emit('discover', p, { quiet: true })
    }, AUTO_DISCOVER_MS)
  }
)

onBeforeUnmount(() => {
  clearAutoDiscoverTimer()
  remoteOpen.value = false
  localOpen.value = false
  clearDeleteModals()
})

function toggleSelectAll() {
  const ids = filteredDiscovered.value.map((m) => m.id)
  if (allFilteredSelected.value) {
    selectedDiscovered.value = selectedDiscovered.value.filter((id) => !ids.includes(id))
  } else {
    const set = new Set([...selectedDiscovered.value, ...ids])
    selectedDiscovered.value = [...set]
  }
}

function submitRemoteSave() {
  fieldErrors.save = ''
  fieldErrors.base_url = ''
  const provider = providerForm.provider.trim()
  const access_key = providerForm.access_key.trim()
  const editIds = remoteEditModelIds.value
  const hasStoredKey = Boolean(remoteEditFallbackKey.value.trim())
  if (!access_key && !(isRemoteWizardEdit.value && hasStoredKey)) {
    fieldErrors.save = 'API key is required.'
    return
  }
  if (provider === 'openai_compatible') {
    const base_url = providerForm.base_url.trim()
    if (!base_url) {
      fieldErrors.base_url = 'API base URL is required for custom providers.'
      return
    }
  }
  const custom = saveForm.customName.trim()
  const hasSelection = selectedDiscovered.value.length > 0
  if (remoteTab.value === 'custom' && !custom && !isRemoteWizardEdit.value) {
    fieldErrors.save = 'Enter a custom model id or switch to the Catalog tab.'
    return
  }
  if (remoteTab.value === 'models' && !hasSelection && !custom && !isRemoteWizardEdit.value) {
    fieldErrors.save = 'Select at least one model or add a custom id on the Custom tab.'
    return
  }
  if (remoteTab.value === 'custom') {
    const p = Number(saveForm.priority)
    if (!Number.isFinite(p) || p < 0) {
      fieldErrors.save = 'Priority must be a non-negative number.'
      return
    }
  } else if (hasSelection) {
    for (const id of selectedDiscovered.value) {
      const row = remoteModelOptions[id]
      const p = Number(row?.priority)
      if (!Number.isFinite(p) || p < 0) {
        fieldErrors.save = 'Each selected model needs a valid non-negative priority.'
        return
      }
    }
  }
  pendingRemoteSave.value = true
  const base_url = provider === 'openai_compatible' ? providerForm.base_url.trim() : undefined
  const perModel: Record<string, { categories: string[]; priority: number }> = {}
  if (remoteTab.value === 'models' && hasSelection) {
    for (const id of selectedDiscovered.value) {
      const row = remoteModelOptions[id] ?? { categories: ['fast'], priority: 100 }
      perModel[id] = {
        categories: defaultModelCategoriesIfEmpty([...row.categories]),
        priority: Math.min(999999, Math.floor(Number(row.priority) || 0))
      }
    }
  }
  emit('save-models', {
    provider,
    access_key,
    ...(base_url ? { base_url } : {}),
    selectedIds: remoteTab.value === 'models' ? [...selectedDiscovered.value] : [],
    customName: remoteTab.value === 'custom' ? custom : custom || undefined,
    categories: defaultModelCategoriesIfEmpty([...saveForm.categories]),
    priority:
      remoteTab.value === 'custom'
        ? Math.min(999999, Math.floor(Number(saveForm.priority)))
        : Math.min(999999, Math.floor(Number(saveForm.priority) || 100)),
    ...(Object.keys(perModel).length ? { perModel } : {}),
    ...(editIds?.length ? { editExistingModelIds: [...editIds] } : {})
  })
}

function submitLocal() {
  localError.value = ''
  const name = localForm.name.trim()
  const api_base_url = localForm.api_base_url.trim()
  if (!api_base_url) {
    localError.value = 'Base URL is required (Ollama: http://127.0.0.1:11434 — LM Studio: often http://127.0.0.1:1234/v1).'
    return
  }
  if (!/^https?:\/\//i.test(api_base_url)) {
    localError.value = 'Base URL must start with http:// or https://.'
    return
  }
  if (!localWizardConnectionOnly.value && !name) {
    localError.value = 'Model id / tag is required and must match the running server.'
    return
  }
  const p = Number(localForm.priority)
  if (!localWizardConnectionOnly.value && (!Number.isFinite(p) || p < 0)) {
    localError.value = 'Invalid priority.'
    return
  }
  const safePriority = Number.isFinite(p) ? Math.min(999999, Math.floor(p)) : 100
  const editIds = localEditModelIds.value
  emit('save-local', {
    name,
    label: localForm.label.trim() || name,
    categories: defaultModelCategoriesIfEmpty([...localForm.categories]),
    priority: safePriority,
    api_base_url,
    local_api_mode: localForm.local_api_mode,
    access_key: localForm.access_key.trim() || undefined,
    ...(editIds?.length ? { editExistingModelIds: [...editIds] } : {}),
    ...(localWizardConnectionOnly.value ? { connectionOnly: true } : {})
  })
  if (!editIds?.length) closeLocalWizard()
}

function requestDelete(m: SavedModel) {
  deleteBulkTarget.value = null
  deleteTarget.value = m
}

function confirmDeleteDo() {
  if (!deleteTarget.value) return
  emit('delete-model', mongoIdString(deleteTarget.value._id))
  clearDeleteModals()
}

function confirmBulkDeleteDo() {
  if (!deleteBulkTarget.value?.ids.length) return
  emit('delete-models', deleteBulkTarget.value.ids.map((x) => mongoIdString(x)).filter(Boolean))
  clearDeleteModals()
}

defineExpose({
  notifySaveComplete(ok: boolean) {
    pendingRemoteSave.value = false
    if (ok) {
      clearAutoDiscoverTimer()
      remoteOpen.value = false
      localOpen.value = false
      remoteEditModelIds.value = null
      remoteEditFallbackKey.value = ''
      remoteEditCatalogSeeded.value = false
      localEditModelIds.value = null
      localWizardConnectionOnly.value = false
      selectedDiscovered.value = []
      saveForm.customName = ''
      fieldErrors.save = ''
    }
  },
  openRemoteModal,
  openLocalModal,
  collectDirtyInlineUpdates,
  flushInlineSave
})
</script>
