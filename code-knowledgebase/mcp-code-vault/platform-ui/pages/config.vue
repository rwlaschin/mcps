<template>
  <div class="max-w-7xl w-full min-h-full flex flex-col select-none">
    <header
      class="sticky top-0 z-20 shrink-0 bg-transparent px-6 py-2 md:px-8 md:py-2.5 pointer-events-none"
    >
      <div class="flex flex-wrap items-start justify-between gap-4 gap-y-2">
        <div class="min-w-0 flex-1 pointer-events-none select-none cursor-default">
          <nav
            class="text-2xl md:text-3xl font-bold text-white flex flex-wrap items-baseline gap-x-2 gap-y-1"
            aria-label="Config section"
          >
            <NuxtLink
              to="/config#settings"
              class="text-gray-400 hover:text-white transition-colors shrink-0 pointer-events-auto select-none"
            >
              Config
            </NuxtLink>
            <span class="text-gray-600 font-normal" aria-hidden="true">/</span>
            <span class="min-w-0">{{ configBreadcrumbLeaf }}</span>
          </nav>
          <p
            v-if="configSectionSubtitle"
            class="text-sm text-gray-400 mt-1 max-w-3xl leading-snug cursor-default"
          >
            {{ configSectionSubtitle }}
          </p>
        </div>
        <div
          v-if="selectedSection === 'models'"
          class="flex flex-wrap items-center gap-x-3 gap-y-2 shrink-0 justify-end pointer-events-auto"
        >
          <p
            v-if="modelsInlineDirty"
            class="text-sm text-amber-300/90 max-w-[min(100%,14rem)] sm:max-w-none"
          >
            Unsaved changes
          </p>
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <StyleUiButton
              type="button"
              variant="secondary"
              size="compact"
              :disabled="configActionPending || !modelsInlineDirty"
              aria-label="Save model list changes"
              @click="modelsPanelRef?.flushInlineSave()"
            >
              Save
            </StyleUiButton>
            <StyleUiButton
              type="button"
              variant="primary"
              size="compact"
              :disabled="configActionPending"
              @click="modelsPanelRef?.openRemoteModal()"
            >
              <Icon name="lucide:plus" class="size-4 shrink-0" aria-hidden="true" />
              Add remote
            </StyleUiButton>
            <StyleUiButton
              type="button"
              variant="secondary"
              size="compact"
              :disabled="configActionPending"
              @click="modelsPanelRef?.openLocalModal()"
            >
              <Icon name="lucide:plus" class="size-4 shrink-0" aria-hidden="true" />
              Add local
            </StyleUiButton>
          </div>
        </div>
        <div
          v-else-if="selectedSection === 'prompts-global'"
          class="flex flex-wrap items-center gap-2 shrink-0 justify-end pointer-events-auto"
        >
          <StyleUiButton
            type="button"
            variant="secondary"
            size="compact"
            :disabled="configActionPending"
            aria-label="Save prompt draft"
            @click="promptsPanelRef?.submitDraft()"
          >
            Save
          </StyleUiButton>
          <StyleUiButton
            v-if="selectedProcessingPromptId"
            type="button"
            variant="secondary"
            size="compact"
            :disabled="configActionPending"
            aria-label="Restore prompt to seed default"
            @click="restorePrompt(selectedProcessingPromptId)"
          >
            Restore default
          </StyleUiButton>
          <StyleUiButton
            type="button"
            size="compact"
            :disabled="configActionPending"
            title="Start a new prompt draft (clears the form)"
            aria-label="New prompt"
            @click="promptsPanelRef?.startNewDraft()"
          >
            <Icon name="lucide:plus" class="size-4 shrink-0" aria-hidden="true" />
            <span class="hidden min-[400px]:inline">New</span>
          </StyleUiButton>
        </div>
        <div
          v-else-if="selectedSection === 'prompts-agents'"
          class="flex flex-wrap items-center gap-2 shrink-0 justify-end pointer-events-auto"
        >
          <StyleUiButton
            type="button"
            variant="secondary"
            size="compact"
            :disabled="configActionPending || !projects.length"
            aria-label="Save agent draft"
            @click="agentsPanelRef?.submitDraft()"
          >
            Save
          </StyleUiButton>
          <StyleUiButton
            type="button"
            size="compact"
            :disabled="configActionPending || !projects.length"
            title="New agent (requires at least one project in the database for storage)"
            aria-label="New agent"
            @click="agentsPanelRef?.startNewDraft()"
          >
            <Icon name="lucide:plus" class="size-4 shrink-0" aria-hidden="true" />
            <span class="hidden min-[400px]:inline">New</span>
          </StyleUiButton>
        </div>
        <div
          v-else-if="selectedSection === 'prompts-personas'"
          class="flex flex-wrap items-center gap-2 shrink-0 justify-end pointer-events-auto"
        >
          <StyleUiButton
            type="button"
            variant="secondary"
            size="compact"
            :disabled="configActionPending"
            aria-label="Save persona draft"
            @click="personasPanelRef?.submitDraft()"
          >
            Save
          </StyleUiButton>
          <StyleUiButton
            type="button"
            size="compact"
            :disabled="configActionPending"
            aria-label="New persona"
            @click="personasPanelRef?.startNewDraft()"
          >
            <Icon name="lucide:plus" class="size-4 shrink-0" aria-hidden="true" />
            <span class="hidden min-[400px]:inline">New</span>
          </StyleUiButton>
        </div>
      </div>
    </header>

    <div class="flex-1 min-w-0 space-y-6 px-6 pb-8 pt-4 md:px-8">
    <template v-if="selectedSection === 'settings'">
      <GlassCard class="mb-0">
        <h2 class="text-lg font-semibold text-gray-400 uppercase tracking-widest mb-2">Project</h2>
        <p class="text-sm text-gray-400 mb-4">Select a project to edit file processing and view the MCP snippet.</p>
        <PlatformProjectSelect
          v-model="selectedProjectKey"
          :projects="projects"
          :loading="projectsLoading"
        />
      </GlassCard>
      <GlassCard key="settings-file-processing" class="!p-4 mb-6">
        <h2 class="text-lg font-semibold text-gray-400 uppercase tracking-widest mb-2">File processing</h2>
        <p class="text-sm text-gray-500 mb-4">
          Defaults apply when fields are unset in the database. Restart the MCP client to pick up changes.
        </p>
        <div v-if="!selectedProjectKey" class="text-sm text-gray-500">Select a project first.</div>
        <div v-else-if="projectFileProcLoading" class="text-sm text-gray-500">Loading…</div>
        <div v-else class="space-y-4 max-w-3xl">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label class="block text-xs text-gray-500">
              <span class="text-[10px] uppercase tracking-widest text-gray-400 block mb-1">Batch size</span>
              <input
                v-model.number="projectFileProc.batch"
                type="number"
                min="1"
                class="w-full select-text rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
              />
            </label>
            <label class="block text-xs text-gray-500">
              <span class="text-[10px] uppercase tracking-widest text-gray-400 block mb-1">Pause between batches (ms)</span>
              <input
                v-model.number="projectFileProc.pauseMs"
                type="number"
                min="0"
                class="w-full select-text rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
              />
            </label>
            <label class="block text-xs text-gray-500">
              <span class="text-[10px] uppercase tracking-widest text-gray-400 block mb-1">Concurrency</span>
              <input
                v-model.number="projectFileProc.concurrency"
                type="number"
                min="1"
                class="w-full select-text rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
              />
            </label>
            <label class="block text-xs text-gray-500">
              <span class="text-[10px] uppercase tracking-widest text-gray-400 block mb-1">Watcher debounce (ms)</span>
              <input
                v-model.number="projectFileProc.debounceMs"
                type="number"
                min="0"
                class="w-full select-text rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
              />
            </label>
          </div>
          <div
            class="rounded-2xl border border-white/12 bg-black/25 p-4 space-y-4 max-w-3xl"
            aria-labelledby="file-indexing-heading"
          >
            <div class="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div>
                <h3
                  id="file-indexing-heading"
                  class="text-[10px] uppercase tracking-widest text-gray-400"
                >
                  Indexing instructions
                </h3>
                <p class="text-[11px] text-gray-500 mt-1 max-w-xl leading-snug">
                  <strong class="text-gray-400 font-medium">Prompt</strong> uses a file-processor template from the vault.
                  <strong class="text-gray-400 font-medium">Agent</strong> runs a full agent stack (model tags are on the agent in Config → Agents).
                </p>
              </div>
            </div>
            <div
              class="inline-flex max-w-full items-stretch overflow-hidden rounded-xl border border-white/15 bg-white/5"
              role="group"
              aria-label="Indexing mode: prompt or agent"
            >
              <button
                type="button"
                class="min-w-[5.5rem] flex-1 border-0 px-4 py-2.5 text-center text-sm font-semibold transition-colors duration-200 focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/50 sm:min-w-[7rem]"
                :class="
                  projectFileProc.driver === 'prompt'
                    ? 'bg-[var(--accent)] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]'
                    : 'bg-transparent text-gray-400 hover:bg-white/10 hover:text-gray-200'
                "
                :aria-pressed="projectFileProc.driver === 'prompt'"
                @click="projectFileProc.driver = 'prompt'"
              >
                Prompt
              </button>
              <span class="w-px shrink-0 self-stretch bg-white/10" aria-hidden="true" />
              <button
                type="button"
                class="min-w-[5.5rem] flex-1 border-0 px-4 py-2.5 text-center text-sm font-semibold transition-colors duration-200 focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/50 sm:min-w-[7rem]"
                :class="
                  projectFileProc.driver === 'agent'
                    ? 'bg-[var(--accent)] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]'
                    : 'bg-transparent text-gray-400 hover:bg-white/10 hover:text-gray-200'
                "
                :aria-pressed="projectFileProc.driver === 'agent'"
                @click="projectFileProc.driver = 'agent'"
              >
                Agent
              </button>
            </div>
            <div class="border-t border-white/10 pt-4 space-y-4">
              <div
                v-if="projectFileProc.driver === 'prompt'"
                class="rounded-xl border border-white/12 bg-black/30 p-4 space-y-5"
                aria-labelledby="file-proc-prompt-path-title"
              >
                <div>
                  <h4
                    id="file-proc-prompt-path-title"
                    class="text-xs font-semibold text-gray-200 tracking-wide"
                  >
                    Prompt path
                  </h4>
                  <p class="text-[11px] text-gray-500 mt-1.5 leading-snug max-w-xl">
                    Template first, then (optional) which saved LLM category tags may run it for this project — both settings save together below.
                  </p>
                </div>
                <label class="block text-xs text-gray-500">
                  <span class="text-[10px] uppercase tracking-widest text-gray-400 block mb-1">File processor template</span>
                  <select
                    v-model="projectFileProc.promptSlug"
                    class="w-full min-h-[2.75rem] select-text rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white [color-scheme:dark] outline-none transition-[box-shadow,border-color] focus-visible:border-[var(--accent)]/55 focus-visible:ring-2 focus-visible:ring-[var(--accent)]/25"
                  >
                    <option value="">Default (vault default for type “file processor”)</option>
                    <option
                      v-for="p in fileProcessorPromptOptions"
                      :key="p._id"
                      :value="promptRowSlug(p)"
                    >
                      {{ p.name }} — {{ promptRowSlug(p) }}
                    </option>
                  </select>
                </label>
                <div class="rounded-lg border border-white/10 bg-black/25 p-3.5 space-y-2.5">
                  <div class="text-[10px] uppercase tracking-widest text-gray-400">LLM allow-list (by tag)</div>
                  <p class="text-[11px] text-gray-500 leading-snug">
                    Matches <span class="text-gray-400">Config → Models</span> category tags. Leave all unchecked to use every enabled model in priority order, with automatic fallback.
                  </p>
                  <ModelCategoriesInput
                    v-model="projectFileProc.modelCategories"
                    allow-empty
                    hint=""
                  />
                </div>
              </div>
              <div
                v-else
                class="rounded-xl border border-white/12 bg-black/30 p-4 space-y-4"
                aria-labelledby="file-proc-agent-path-title"
              >
                <div>
                  <h4
                    id="file-proc-agent-path-title"
                    class="text-xs font-semibold text-gray-200 tracking-wide"
                  >
                    Agent path
                  </h4>
                  <p class="text-[11px] text-gray-500 mt-1.5 leading-snug max-w-xl">
                    Which models may run is controlled on the agent in <span class="text-gray-400">Config → Agents</span> (not here).
                  </p>
                </div>
                <div class="block text-xs text-gray-500">
                  <span class="text-[10px] uppercase tracking-widest text-gray-400 block mb-1">Agent</span>
                  <label
                    class="mt-2 mb-3 inline-flex cursor-pointer select-text items-center gap-2 text-[11px] text-gray-400"
                  >
                    <input
                      v-model="fileProcAgentsLimitToProject"
                      type="checkbox"
                      class="rounded border-white/20 bg-white/10"
                    />
                    <span>This project only</span>
                  </label>
                  <label class="sr-only" for="file-proc-agent-select">Choose agent for file indexing</label>
                  <select
                    id="file-proc-agent-select"
                    v-model="projectFileProc.agentId"
                    class="w-full min-h-[2.75rem] select-text rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white [color-scheme:dark] outline-none transition-[box-shadow,border-color] focus-visible:border-[var(--accent)]/55 focus-visible:ring-2 focus-visible:ring-[var(--accent)]/25"
                  >
                    <option value="">Select an agent…</option>
                    <option
                      v-for="a in agentsForFileProcessingPicker"
                      :key="a._id"
                      :value="a._id"
                    >
                      {{ a.name }} — {{ a.tool_name }} — {{ a.project_key || '?' }}
                    </option>
                  </select>
                  <p
                    v-if="!projectFileProcLoading && agentsForFileProcessingPicker.length === 0 && fileProcAgentsLimitToProject"
                    class="text-[11px] text-amber-200/90 mt-2"
                  >
                    No matches — clear the checkbox or add agents in <span class="text-gray-300">Config → Agents</span>.
                  </p>
                  <p
                    v-else-if="!projectFileProcLoading && agentsForFileProcessingPicker.length === 0 && !fileProcAgentsLimitToProject && agentsWithFileWatch.length === 0 && agentItems.length > 0"
                    class="text-[11px] text-amber-200/90 mt-2"
                  >
                    No agents have <span class="text-gray-300">File watch</span> — turn it on under Config → Agents.
                  </p>
                  <p v-else-if="!projectFileProcLoading && agentItems.length === 0" class="text-[11px] text-amber-200/90 mt-2">
                    No agents — <span class="text-gray-300">Config → Agents</span>.
                  </p>
                  <span class="text-[11px] text-gray-500 mt-1 block">Stack: global prompt → system → personas.</span>
                </div>
              </div>
            </div>
          </div>
          <StyleUiButton
            type="button"
            variant="primary"
            size="compact"
            :disabled="configActionPending || !selectedProjectKey"
            @click="saveProjectFileProcessing"
          >
            Save file processing settings
          </StyleUiButton>
        </div>
      </GlassCard>
      <GlassCard v-if="selectedProjectKey" key="settings-project-agents-mcp" class="!p-4 mb-6">
        <h2 class="text-lg font-semibold text-gray-400 uppercase tracking-widest mb-2">MCP tools and agents</h2>
        <p class="text-sm text-gray-500 mb-4 max-w-3xl leading-snug">
          When the MCP host runs with <code class="px-1 rounded bg-white/10 text-gray-300">MCP_PROJECT_NAME</code> set to
          <strong class="text-gray-400">{{ selectedProjectKey }}</strong>, each agent below is exposed as one tool named by
          <span class="text-gray-400">Tool name</span>, plus the server built-ins. Restart or reconnect the MCP client after adding agents so
          <code class="px-1 rounded bg-white/10 text-gray-300">tools/list</code> updates.
        </p>

        <div class="rounded-xl border border-white/12 bg-black/25 p-4 mb-5 space-y-3 max-w-3xl">
          <h3 class="text-[10px] uppercase tracking-widest text-gray-400">Always on the server</h3>
          <ul class="text-sm text-gray-400 space-y-2 list-none pl-0">
            <li
              v-for="row in mcpBuiltinsList"
              :key="row.id"
              class="flex flex-wrap gap-x-2 gap-y-0.5 border-b border-white/5 pb-2 last:border-0 last:pb-0"
            >
              <code class="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-emerald-200/90">{{ row.id }}</code>
              <span class="text-gray-500">{{ row.summary }}</span>
            </li>
          </ul>
        </div>

        <div class="rounded-xl border border-white/12 bg-black/25 p-4 mb-5 space-y-3 max-w-3xl">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h3 class="text-[10px] uppercase tracking-widest text-gray-400">
              Agents on <span class="text-gray-300">{{ selectedProjectKey }}</span>
            </h3>
            <StyleUiButton type="button" variant="secondary" size="compact" @click="addAgentFormOpen = !addAgentFormOpen">
              {{ addAgentFormOpen ? 'Close form' : 'Add agent to this project' }}
            </StyleUiButton>
          </div>
          <p v-if="!agentsForSelectedProject.length" class="text-sm text-gray-500">
            No agents yet for this project. Add one here (quick create) or use
            <NuxtLink to="/config#prompts-agents" class="text-accent hover:underline">Config → Agents</NuxtLink>
            for full editing.
          </p>
          <ul v-else class="text-sm text-gray-300 space-y-2 list-none pl-0">
            <li
              v-for="a in agentsForSelectedProject"
              :key="a._id"
              class="rounded-lg border border-white/10 bg-black/20 px-3 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1"
            >
              <span class="font-medium text-white">{{ a.name }}</span>
              <code class="text-xs text-emerald-200/90">{{ a.tool_name }}</code>
              <span class="text-[11px] text-gray-500 font-mono">
                file_watch={{ a.tools.file_watch }}, db={{ a.tools.db_read_write }}, web={{ a.tools.web_search }}, shell={{
                  a.tools.run_shell
                }}
              </span>
            </li>
          </ul>

          <div
            v-if="addAgentFormOpen"
            class="mt-4 rounded-lg border border-dashed border-white/20 bg-black/30 p-4 space-y-3"
          >
            <p class="text-[11px] text-gray-500">
              New agents default to all four capability flags on (same fields as
              <NuxtLink to="/docs#using-the-mcp" class="text-accent hover:underline">Docs → MCP tools reference</NuxtLink>
              per-agent tool flags). Tune them under Config → Agents.
            </p>
            <label class="block text-xs text-gray-500">
              <span class="text-[10px] uppercase tracking-widest text-gray-400 block mb-1">Name</span>
              <input
                v-model="addAgentForm.name"
                type="text"
                class="w-full select-text rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
                maxlength="200"
                autocomplete="off"
              />
            </label>
            <div class="flex flex-col sm:flex-row gap-2 sm:items-end">
              <label class="block text-xs text-gray-500 flex-1 min-w-0">
                <span class="text-[10px] uppercase tracking-widest text-gray-400 block mb-1">Tool name (MCP id)</span>
                <input
                  v-model="addAgentForm.tool_name"
                  type="text"
                  class="w-full select-text rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white font-mono"
                  maxlength="128"
                  autocomplete="off"
                  placeholder="e.g. my_agent"
                />
              </label>
              <StyleUiButton type="button" variant="secondary" size="compact" class="shrink-0" @click="fillToolNameFromAgentName">
                From name
              </StyleUiButton>
            </div>
            <label class="block text-xs text-gray-500">
              <span class="text-[10px] uppercase tracking-widest text-gray-400 block mb-1">Short description</span>
              <input
                v-model="addAgentForm.description"
                type="text"
                class="w-full select-text rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
                maxlength="400"
              />
            </label>
            <label class="block text-xs text-gray-500">
              <span class="text-[10px] uppercase tracking-widest text-gray-400 block mb-1">System prompt</span>
              <textarea
                v-model="addAgentForm.system_prompt"
                rows="4"
                class="w-full select-text rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white min-h-[6rem]"
              />
            </label>
            <div class="flex flex-wrap gap-2 pt-1">
              <StyleUiButton
                type="button"
                variant="primary"
                size="compact"
                :disabled="addAgentPending || configActionPending"
                @click="submitAddAgentToProject"
              >
                {{ addAgentPending ? 'Creating…' : 'Create agent' }}
              </StyleUiButton>
            </div>
          </div>
        </div>
      </GlassCard>
      <GlassCard key="settings-body" class="!p-4">
        <h2 class="text-lg font-semibold text-gray-400 uppercase tracking-widest mb-2">MCP snippet</h2>
        <div v-if="configLoading" class="text-sm text-gray-500">Loading…</div>
        <pre
          v-else
          class="mt-3 text-xs text-gray-200 font-mono whitespace-pre-wrap break-all min-h-[220px]"
        >{{ configText || 'Select a project to load config.' }}</pre>
      </GlassCard>
    </template>


    <ConfigPromptsPanel
      v-else-if="selectedSection === 'prompts-global'"
      ref="promptsPanelRef"
      key="prompts-global"
      :prompts="promptItems"
      :selected-prompt-id="selectedProcessingPromptId"
      :save-pending="configActionPending"
      :seed-write-enabled="configSeedWriteEnabled"
      @select="selectedProcessingPromptId = $event"
      @save="savePrompt"
      @restore-default="restorePrompt"
    />
    <ConfigAgentsPanel
      v-else-if="selectedSection === 'prompts-agents'"
      ref="agentsPanelRef"
      key="prompts-agents"
      :agents="agentItems"
      :project-key="selectedProjectKey"
      :selected-agent-id="selectedAgentId"
      :agents-loading="agentsLoading"
      :available-personas="personaPickerItems"
      :personas-loading="personasLoading"
      :global-prompt-options="promptItems"
      :save-pending="configActionPending"
      :seed-write-enabled="configSeedWriteEnabled"
      @select="selectedAgentId = $event"
      @save="saveAgent"
      @restore-default="restoreAgent"
      @create-persona="onCreatePersonaFromAgentsPanel"
    />
    <ConfigModelsPanel
      v-else-if="selectedSection === 'models'"
      ref="modelsPanelRef"
      key="models"
      :discovered-models="discoveredModels"
      :saved-models="savedModels"
      :action-pending="configActionPending"
      :verify-local-pending="localVerifyPending"
      @discover="onDiscoverModels"
      @clear-discovered="clearDiscoveredModels"
      @save-models="saveModels"
      @save-local="saveLocalModel"
      @verify-local="verifyLocalModelEndpoint"
      @delete-model="deleteModel"
      @delete-models="deleteModels"
      @batch-save-inline="batchPatchModelInline"
      @update:inline-dirty="modelsInlineDirty = $event"
    />
    <ConfigPersonasPanel
      v-else-if="selectedSection === 'prompts-personas'"
      ref="personasPanelRef"
      key="prompts-personas"
      :personas="personaItems"
      :selected-persona-id="selectedPersonaId"
      :personas-loading="personasLoading"
      :save-pending="configActionPending"
      :seed-write-enabled="configSeedWriteEnabled"
      @select="selectedPersonaId = $event"
      @save="savePersona"
      @restore-default="restorePersona"
    />
    </div>

    <Teleport v-if="configNavGuardOpen" to="body">
      <div
        class="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-nav-guard-title"
        @click.self="closeConfigNavGuard"
      >
        <div
          class="w-full max-w-md rounded-2xl border border-white/10 bg-[var(--surface-card)] p-5 shadow-2xl"
          @click.stop
        >
          <h3 id="config-nav-guard-title" class="text-base font-semibold text-white mb-2">
            Unsaved model changes
          </h3>
          <p class="text-sm text-gray-400 mb-5">
            Save your edits to the list before leaving this section, or stay here and use the row revert control if you want to undo changes.
          </p>
          <div class="flex flex-col sm:flex-row justify-end gap-2">
            <StyleUiButton type="button" variant="secondary" class="sm:order-1" @click="closeConfigNavGuard">
              Stay
            </StyleUiButton>
            <StyleUiButton
              type="button"
              class="sm:order-2"
              :disabled="configActionPending"
              @click="configNavSaveAndGo"
            >
              Save and continue
            </StyleUiButton>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, reactive, onMounted, onUnmounted, useTemplateRef, nextTick } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { usePrimaryBaseUrl } from '../composables/usePrimaryBaseUrl'
import { useStreamTargetUrl } from '../composables/useStreamTargetUrl'
import { reconcileSelectedProjectKey, useSelectedProjectKey } from '../composables/useSelectedProjectKey'
import { usePlatformToast } from '../composables/usePlatformToast'
import { isConfigPath, configHashFragment, normalizeConfigSectionHash } from '../composables/useConfigRoute'
import { readApiErrorMessage } from '../lib/apiError'
import { mongoIdString } from '../lib/mongoId'
import { slugify } from '../lib/slugify'
import {
  MCP_BUILTIN_TOOL_IDS,
  MCP_BUILTIN_TOOL_SUMMARIES,
  DEFAULT_AGENT_TOOLS_ON_CREATE
} from '../../src/utils/defaultAgentTools'
import ConfigPromptsPanel from '../components/ConfigPromptsPanel.vue'
import ConfigModelsPanel from '../components/ConfigModelsPanel.vue'
import ConfigPersonasPanel from '../components/ConfigPersonasPanel.vue'
import ConfigAgentsPanel from '../components/ConfigAgentsPanel.vue'
import ModelCategoriesInput from '../components/ModelCategoriesInput.vue'


interface AgentItem {
  _id: string
  name: string
  description: string
  system_prompt: string
  tool_name: string
  /** Empty = all saved models; otherwise agent only uses models tagged with any of these. */
  model_categories: string[]
  persona_names: string[]
  /** Optional vault global prompt (Config → Prompts → Global) run before the agent stack. */
  global_prompt_id: string | null
  global_prompt_name?: string | null
  tools: {
    file_watch: boolean
    db_read_write: boolean
    web_search: boolean
    run_shell: boolean
  }
  save_to_seed: boolean
  project_key?: string
}

interface ProjectItem {
  key: string
  name: string
}

const projects = ref<ProjectItem[]>([])
const projectsLoading = ref(true)
const selectedProjectKey = useSelectedProjectKey()

const projectFileProcLoading = ref(false)
const projectFileProc = reactive({
  batch: 30,
  pauseMs: 100,
  concurrency: 3,
  debounceMs: 5000,
  driver: 'prompt' as 'prompt' | 'agent',
  /** SystemPrompt slug, or empty string = vault default file-processor chain. */
  promptSlug: '',
  /** Agent document id when driver is agent. */
  agentId: '',
  modelCategories: [] as string[]
})

const fileProcAgentsLimitToProject = ref(false)

const configLoading = ref(false)
const configText = ref('')
const route = useRoute()
const router = useRouter()

const modelsInlineDirty = ref(false)
const configNavGuardOpen = ref(false)
const pendingConfigNav = ref<string | null>(null)

type ConfigSectionId =
  | 'settings'
  | 'models'
  | 'prompts-global'
  | 'prompts-agents'
  | 'prompts-personas'

function configSectionFromRoute(path: string, hash: string): ConfigSectionId {
  const frag = configHashFragment(path, hash || '')
  return normalizeConfigSectionHash(frag || 'settings') as ConfigSectionId
}

const selectedSection = ref<ConfigSectionId>('settings')

const configBreadcrumbLeaf = computed(() => {
  switch (selectedSection.value) {
    case 'settings':
      return 'Settings'
    case 'models':
      return 'Models'
    case 'prompts-global':
      return 'Prompts'
    case 'prompts-agents':
      return 'Agents'
    case 'prompts-personas':
      return 'Personas'
    default:
      return 'Settings'
  }
})

const configSectionSubtitle = computed(() => {
  switch (selectedSection.value) {
    case 'settings':
      return 'Manage prompts and model providers used by the platform.'
    case 'models':
      return 'Agents are exposed dynamically through the MCP interface (may need to reload to enable)'
    case 'prompts-global':
      return 'Vault prompts: each has a Name and a Type (e.g. file processor, user request). One default per type.'
    case 'prompts-agents':
      return 'Agents are the dynamic command profiles the vault runs (e.g. security audit). Each agent has a Tool name — the MCP tool id the host lists for that agent (after Mongo connects). Optional global prompt from Config → Prompts → Global runs first on the user’s task; then the agent system prompt and personas use that output. Category tags narrow eligible saved models. Profiles are shared across all projects.'
    case 'prompts-personas':
      return 'Style and tone presets linked to agents.'
    default:
      return ''
  }
})

const selectedProcessingPromptId = ref('')
const selectedPersonaId = ref('')
const selectedAgentId = ref('')
const configSeedWriteEnabled = ref(false)

const promptItems = ref<
  Array<{
    _id: string
    name: string
    slug?: string
    prompt: string
    usage_type: string
    prompt_type?: 'processing' | 'agent'
    category: 'fast' | 'blended' | 'thinking'
    is_default: boolean
    save_to_seed: boolean
    structure_mode?: 'unstructured' | 'structured'
    structure_preset?: string
    structure_mime?: 'application/json' | 'application/x-yaml-extended'
  }>
>([])
const personaItems = ref<Array<{ _id: string; name: string; description: string; prompt: string; save_to_seed: boolean }>>([])
const personasLoading = ref(false)
const agentItems = ref<AgentItem[]>([])
const agentsLoading = ref(false)

const mcpBuiltinsList = MCP_BUILTIN_TOOL_IDS.map((id) => ({
  id,
  summary: MCP_BUILTIN_TOOL_SUMMARIES[id]
}))

const agentsForSelectedProject = computed(() => {
  const k = selectedProjectKey.value?.trim()
  if (!k) return []
  return agentItems.value.filter((a) => (a.project_key || '').trim() === k)
})

const addAgentFormOpen = ref(false)
const addAgentPending = ref(false)
const addAgentForm = reactive({
  name: '',
  tool_name: '',
  description: '',
  system_prompt: 'You help the user with tasks for this codebase. Be concise and accurate.'
})

function fillToolNameFromAgentName() {
  const s = slugify(addAgentForm.name)
  if (s) addAgentForm.tool_name = s
}

async function submitAddAgentToProject() {
  const key = selectedProjectKey.value?.trim()
  if (!key || !statsApiBase.value || addAgentPending.value) return
  const name = addAgentForm.name.trim()
  const tool_name = addAgentForm.tool_name.trim()
  const description = addAgentForm.description.trim()
  const system_prompt = addAgentForm.system_prompt.trim()
  if (!name || !tool_name || !description || !system_prompt) {
    toastError('Fill name, tool name, description, and system prompt.')
    return
  }
  addAgentPending.value = true
  try {
    const res = await fetch(`${statsApiBase.value}/config/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectKey: key,
        name,
        tool_name,
        description,
        system_prompt,
        model_categories: [],
        persona_names: [],
        tools: { ...DEFAULT_AGENT_TOOLS_ON_CREATE }
      })
    })
    if (!res.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    toastSuccess('Agent created for this project')
    addAgentForm.name = ''
    addAgentForm.tool_name = ''
    addAgentForm.description = ''
    addAgentForm.system_prompt = 'You help the user with tasks for this codebase. Be concise and accurate.'
    addAgentFormOpen.value = false
    await fetchAgents(undefined, { silent: true })
    await fetchProjectFileProcessing()
  } finally {
    addAgentPending.value = false
  }
}

const fileProcessorPromptOptions = computed(() =>
  promptItems.value.filter((p) => {
    const ut = (p.usage_type || '').trim().toLowerCase()
    if (ut !== 'file processor') return false
    if (p.prompt_type === 'agent') return false
    return true
  })
)

const agentsWithFileWatch = computed(() => agentItems.value.filter((a) => Boolean(a.tools?.file_watch)))

const agentsForFileProcessingPicker = computed(() => {
  const key = selectedProjectKey.value?.trim()
  const base = [...agentsWithFileWatch.value].sort((a, b) => {
    const pk = (a.project_key || '').localeCompare(b.project_key || '')
    if (pk !== 0) return pk
    return a.name.localeCompare(b.name)
  })
  if (!fileProcAgentsLimitToProject.value || !key) return base
  return base.filter((a) => (a.project_key || '').trim() === key)
})

const discoveredModels = ref<
  Array<{
    id: string
    name: string
    label: string
    capabilities: string[]
    description?: string
    suggested_category?: 'fast' | 'blended' | 'thinking'
  }>
>([])
const savedModels = ref<
  Array<{
    _id: string
    provider: string
    name: string
    label: string
    credential_id?: string
    categories?: string[]
    category?: 'fast' | 'blended' | 'thinking'
    priority?: number
    access_key?: string
    api_base_url?: string
    local_api_mode?: 'ollama' | 'openai'
    enabled?: boolean
    capabilities?: string[]
    is_custom?: boolean
  }>
>([])

const localVerifyPending = ref(false)

const modelsPanelRef = useTemplateRef<{
  notifySaveComplete: (ok: boolean) => void
  openRemoteModal: () => void
  openLocalModal: () => void
  flushInlineSave: () => void
  collectDirtyInlineUpdates: () => Array<{
    id: string
    body: { categories: string[]; priority: number; enabled: boolean }
  }>
}>('modelsPanelRef')
const promptsPanelRef = useTemplateRef<{ startNewDraft: () => void; submitDraft: () => void }>(
  'promptsPanelRef'
)
const agentsPanelRef = useTemplateRef<{
  startNewDraft: () => void
  submitDraft: () => void
  onCreatePersonaFinished: (name: string | null, errorMessage?: string) => void
}>('agentsPanelRef')
const personasPanelRef = useTemplateRef<{ startNewDraft: () => void; submitDraft: () => void }>(
  'personasPanelRef'
)

interface SocketLike {
  on(event: string, fn: (...args: unknown[]) => void): void
  disconnect(): void
}
let socket: SocketLike | null = null

const primaryBaseUrl = usePrimaryBaseUrl()
const streamTargetUrl = useStreamTargetUrl()
const configBaseUrl = computed(() => streamTargetUrl.value || primaryBaseUrl.value)
const statsApiBase = computed(() => configBaseUrl.value)
const { success: toastSuccess, error: toastError } = usePlatformToast()

const configActionPending = ref(false)

const personaPickerItems = computed(() =>
  personaItems.value.map((p) => ({ _id: p._id, name: p.name }))
)

async function ensureConfigBaseUrl(): Promise<string> {
  const existing = configBaseUrl.value
  if (existing) return existing
  try {
    const res = await fetch('/api/servers')
    if (!res.ok) return ''
    const payload = (await res.json()) as { servers?: Array<{ port?: number }> }
    let firstPort = payload.servers?.[0]?.port
    if (!firstPort) {
      const docsRes = await fetch('/api/docs-context')
      if (docsRes.ok) {
        const docsPayload = (await docsRes.json()) as { port?: string | number }
        const maybePort = Number(docsPayload.port)
        if (Number.isFinite(maybePort) && maybePort > 0) firstPort = maybePort
      }
    }
    if (!firstPort) return ''
    const host = (window.location.hostname === 'localhost' || window.location.hostname === '::1')
      ? '127.0.0.1'
      : window.location.hostname
    const resolved = `http://${host}:${firstPort}`
    streamTargetUrl.value = resolved
    primaryBaseUrl.value = resolved
    return resolved
  } catch {
    return ''
  }
}

async function fetchProjects() {
  projectsLoading.value = true
  try {
    const res = await fetch(`${statsApiBase.value}/projects`)
    if (res && res.ok) {
      const { projects: list } = (await res.json()) as { projects?: ProjectItem[] }
      projects.value = list ?? []
      reconcileSelectedProjectKey(selectedProjectKey, projects.value)
    }
  } finally {
    projectsLoading.value = false
  }
}

function promptRowSlug(p: { slug?: string; name: string }): string {
  const s = (p.slug ?? '').trim()
  if (s) return s
  return slugify(p.name)
}

async function fetchConfig() {
  const key = selectedProjectKey.value
  if (!key || !statsApiBase.value) {
    if (!key) configText.value = ''
    return
  }
  configLoading.value = true
  try {
    const res = await fetch(`${statsApiBase.value}/config?projectKey=${encodeURIComponent(key)}`)
    if (res && res.ok) {
      const body = (await res.json()) as { config?: string }
      configText.value = body.config ?? ''
    }
  } catch {
    // keep previous state
  } finally {
    configLoading.value = false
  }
}
async function fetchProjectFileProcessing() {
  const key = selectedProjectKey.value
  if (!key || !statsApiBase.value) return
  projectFileProcLoading.value = true
  try {
    await Promise.all([fetchPrompts(), fetchAgents(undefined, { silent: true })])
    const res = await fetch(
      `${statsApiBase.value}/config/project-file-processing?projectKey=${encodeURIComponent(key)}`
    )
    if (!res.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    const body = (await res.json()) as {
      file_processing_batch_size?: number
      file_processing_pause_ms?: number
      file_processing_concurrency?: number
      file_processing_debounce_ms?: number
      file_processing_driver?: 'prompt' | 'agent'
      file_processing_agent_id?: string
      file_processing_prompt_slug?: string
      file_processing_model_categories?: string[]
    }
    projectFileProc.batch = body.file_processing_batch_size ?? 30
    projectFileProc.pauseMs = body.file_processing_pause_ms ?? 100
    projectFileProc.concurrency = body.file_processing_concurrency ?? 3
    projectFileProc.debounceMs = body.file_processing_debounce_ms ?? 5000
    projectFileProc.driver = body.file_processing_driver === 'agent' ? 'agent' : 'prompt'
    projectFileProc.agentId = body.file_processing_agent_id?.trim() ?? ''
    projectFileProc.promptSlug = body.file_processing_prompt_slug ?? ''
    projectFileProc.modelCategories = Array.isArray(body.file_processing_model_categories)
      ? [...body.file_processing_model_categories]
      : []
  } catch {
    toastError('Could not load file processing settings.')
  } finally {
    projectFileProcLoading.value = false
  }
}

async function saveProjectFileProcessing() {
  const key = selectedProjectKey.value
  if (!key || configActionPending.value) return
  if (projectFileProc.driver === 'agent' && !projectFileProc.agentId.trim()) {
    toastError('Select an agent for file processing.')
    return
  }
  configActionPending.value = true
  try {
    const res = await fetch(
      `${statsApiBase.value}/config/project-file-processing?projectKey=${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_processing_batch_size: projectFileProc.batch,
          file_processing_pause_ms: projectFileProc.pauseMs,
          file_processing_concurrency: projectFileProc.concurrency,
          file_processing_debounce_ms: projectFileProc.debounceMs,
          file_processing_driver: projectFileProc.driver,
          file_processing_agent_id:
            projectFileProc.driver === 'agent' && projectFileProc.agentId.trim()
              ? projectFileProc.agentId.trim()
              : '',
          file_processing_prompt_slug: projectFileProc.promptSlug.trim(),
          file_processing_model_categories: projectFileProc.modelCategories
        })
      }
    )
    if (!res.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    toastSuccess('File processing settings saved')
    await fetchProjectFileProcessing()
  } finally {
    configActionPending.value = false
  }
}


watch(
  selectedProjectKey,
  () => {
    if (!configBaseUrl.value) return
    void fetchConfig()
    if (selectedProjectKey.value) void fetchProjectFileProcessing()
  },
  { immediate: true }
)

watch(
  () => projectFileProc.driver,
  (d) => {
    if (d !== 'agent' || !configBaseUrl.value) return
    void fetchAgents(undefined, { silent: true })
  }
)

const CONFIG_HASH_IDS = new Set<string>([
  'settings',
  'models',
  'prompts-global',
  'prompts-agents',
  'prompts-personas',
  'personas',
  'project-config',
  'prompts'
])

function normalizeConfigHash(raw: string): ConfigSectionId {
  if (raw === 'project-config') return 'settings'
  if (raw === 'prompts') return 'prompts-global'
  if (raw === 'personas') return 'prompts-personas'
  if (
    raw === 'settings' ||
    raw === 'models' ||
    raw === 'prompts-global' ||
    raw === 'prompts-agents' ||
    raw === 'prompts-personas'
  ) {
    return raw
  }
  return 'settings'
}

/**
 * Hash is not sent to the server: SSR always sees `route.hash === ''`. Apply hash only on
 * client after mount, then keep watching for in-app navigation.
 * `configHashFragment` also reads `window.location.hash` when `route.hash` lags after a full reload.
 */
function applyRouteHashToSection() {
  if (!isConfigPath(route.path)) return
  const id = configHashFragment(route.path, route.hash)
  if (!id) {
    selectedSection.value = 'settings'
    return
  }
  if (!CONFIG_HASH_IDS.has(id)) {
    selectedSection.value = 'settings'
    return
  }
  selectedSection.value = normalizeConfigHash(id)
}

watch(() => [route.path, route.hash] as const, () => {
  if (typeof window !== 'undefined') applyRouteHashToSection()
})

watch(selectedSection, async (value) => {
  if (!configBaseUrl.value) return
  if (value === 'settings') await fetchProjectFileProcessing()
  if (value === 'prompts-global') await fetchPrompts()
  if (value === 'prompts-personas') await fetchPersonas()
  if (value === 'prompts-agents') {
    await fetchPrompts()
    await fetchSavedModels()
    await fetchPersonas()
    await fetchAgents()
    await refreshDiscoveryForSavedProviders()
  }
  if (value === 'models') {
    await fetchSavedModels()
    await refreshDiscoveryForSavedProviders()
  }
})

onBeforeRouteUpdate((to, from) => {
  if (typeof window === 'undefined') return
  if (!isConfigPath(from.path)) return
  const fromSec = configSectionFromRoute(from.path, from.hash)
  const toSec = configSectionFromRoute(to.path, to.hash)
  if (fromSec === 'models' && toSec !== 'models' && modelsInlineDirty.value) {
    pendingConfigNav.value = to.fullPath
    configNavGuardOpen.value = true
    return false
  }
})

onBeforeRouteLeave((to, from) => {
  if (typeof window === 'undefined') return
  if (!isConfigPath(from.path)) return
  const fromSec = configSectionFromRoute(from.path, from.hash)
  if (fromSec === 'models' && modelsInlineDirty.value) {
    pendingConfigNav.value = to.fullPath
    configNavGuardOpen.value = true
    return false
  }
})

async function fetchPrompts() {
  try {
    const res = await fetch(`${statsApiBase.value}/config/prompts`)
    if (!res?.ok) {
      // 404 = wrong host (e.g. UI port) or route not mounted — not an actionable “error” for an empty prompt list
      if (res.status === 404) {
        promptItems.value = []
        return
      }
      toastError(await readApiErrorMessage(res))
      return
    }
    const payload = (await res.json()) as {
      prompts?: typeof promptItems.value
      seedWriteEnabled?: boolean
    }
    if (typeof payload.seedWriteEnabled === 'boolean') configSeedWriteEnabled.value = payload.seedWriteEnabled
    promptItems.value = payload.prompts ?? []
    if (!selectedProcessingPromptId.value && promptItems.value.length) {
      selectedProcessingPromptId.value = promptItems.value[0]!._id
    }
  } catch {
    toastError('Could not reach the stats server.')
  }
}

async function fetchPersonas() {
  personasLoading.value = true
  try {
    const res = await fetch(`${statsApiBase.value}/config/personas`)
    if (!res?.ok) {
      if (res.status === 404) {
        personaItems.value = []
        return
      }
      toastError(await readApiErrorMessage(res))
      return
    }
    const payload = (await res.json()) as {
      personas?: typeof personaItems.value
      seedWriteEnabled?: boolean
    }
    if (typeof payload.seedWriteEnabled === 'boolean') configSeedWriteEnabled.value = payload.seedWriteEnabled
    personaItems.value = payload.personas ?? []
  } catch {
    toastError('Could not reach the stats server.')
  } finally {
    personasLoading.value = false
  }
}

async function fetchAgents(projectKey?: string | null, opts?: { silent?: boolean }) {
  if (!opts?.silent) agentsLoading.value = true
  try {
    const q = projectKey?.trim() ? `?projectKey=${encodeURIComponent(projectKey.trim())}` : ''
    const res = await fetch(`${statsApiBase.value}/config/agents${q}`)
    if (!res?.ok) {
      if (res.status === 404) {
        agentItems.value = []
        return
      }
      toastError(await readApiErrorMessage(res))
      return
    }
    const payload = (await res.json()) as {
      agents?: AgentItem[]
      seedWriteEnabled?: boolean
    }
    if (typeof payload.seedWriteEnabled === 'boolean') configSeedWriteEnabled.value = payload.seedWriteEnabled
    agentItems.value = payload.agents ?? []
  } catch {
    if (!opts?.silent) toastError('Could not reach the stats server.')
  } finally {
    if (!opts?.silent) agentsLoading.value = false
  }
}

async function savePrompt(payload: {
  _id?: string
  name: string
  prompt: string
  usage_type: string
  category: 'fast' | 'blended' | 'thinking'
  is_default: boolean
  save_to_seed: boolean
  structure_mode?: 'unstructured' | 'structured'
  structure_preset?: string
  structure_mime?: 'application/json' | 'application/x-yaml-extended'
}) {
  if (configActionPending.value) return
  configActionPending.value = true
  try {
    const method = payload._id ? 'PUT' : 'POST'
    const url = payload._id ? `${statsApiBase.value}/config/prompts/${payload._id}` : `${statsApiBase.value}/config/prompts`
    const body = { ...payload }
    delete (body as { _id?: string })._id
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res?.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    toastSuccess('Saved')
    await fetchPrompts()
  } finally {
    configActionPending.value = false
  }
}

async function restorePrompt(id: string) {
  if (configActionPending.value) return
  configActionPending.value = true
  try {
    const res = await fetch(`${statsApiBase.value}/config/prompts/${id}/restore-default`, {
      method: 'POST'
    })
    if (!res?.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    toastSuccess('Restored')
    await fetchPrompts()
  } finally {
    configActionPending.value = false
  }
}

type CreatePersonaFromAgentsResult = { ok: true; name: string } | { ok: false; error: string }

async function createPersonaFromAgentsModal(payload: {
  name: string
  description: string
  prompt: string
  save_to_seed: boolean
}): Promise<CreatePersonaFromAgentsResult> {
  if (configActionPending.value) {
    return { ok: false, error: 'Another save is in progress.' }
  }
  configActionPending.value = true
  try {
    const res = await fetch(`${statsApiBase.value}/config/personas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) {
      const err = await readApiErrorMessage(res)
      toastError(err)
      return { ok: false, error: err }
    }
    const data = (await res.json()) as { persona?: { name?: string } }
    const name = (data.persona?.name ?? payload.name).trim()
    toastSuccess('Persona created')
    await fetchPersonas()
    return { ok: true, name }
  } catch {
    const err = 'Network error'
    toastError(err)
    return { ok: false, error: err }
  } finally {
    configActionPending.value = false
  }
}

async function onCreatePersonaFromAgentsPanel(payload: {
  name: string
  description: string
  prompt: string
  save_to_seed: boolean
}) {
  const result = await createPersonaFromAgentsModal(payload)
  if (result.ok) agentsPanelRef.value?.onCreatePersonaFinished(result.name)
  else agentsPanelRef.value?.onCreatePersonaFinished(null, result.error)
}

async function savePersona(payload: {
  _id?: string
  name: string
  description: string
  prompt: string
  save_to_seed: boolean
}) {
  if (configActionPending.value) return
  configActionPending.value = true
  try {
    const method = payload._id ? 'PUT' : 'POST'
    const url = payload._id ? `${statsApiBase.value}/config/personas/${payload._id}` : `${statsApiBase.value}/config/personas`
    const body = { ...payload }
    delete (body as { _id?: string })._id
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res?.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    toastSuccess('Saved')
    await fetchPersonas()
  } finally {
    configActionPending.value = false
  }
}

async function restorePersona(id: string) {
  if (configActionPending.value) return
  configActionPending.value = true
  try {
    const res = await fetch(`${statsApiBase.value}/config/personas/${id}/restore-default`, { method: 'POST' })
    if (!res?.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    toastSuccess('Restored')
    await fetchPersonas()
  } finally {
    configActionPending.value = false
  }
}

async function saveAgent(
  payload: Omit<AgentItem, '_id' | 'project_key'> & { _id?: string; projectKey?: string }
) {
  if (configActionPending.value) return
  configActionPending.value = true
  try {
    const method = payload._id ? 'PUT' : 'POST'
    const url = payload._id ? `${statsApiBase.value}/config/agents/${payload._id}` : `${statsApiBase.value}/config/agents`
    const { _id, projectKey: _pk, ...rest } = payload
    const pk = selectedProjectKey.value?.trim() || _pk?.trim() || ''
    const body = { ...rest, ...(pk ? { projectKey: pk } : {}) }
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res?.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    toastSuccess('Saved')
    await fetchAgents()
  } finally {
    configActionPending.value = false
  }
}

async function restoreAgent(id: string) {
  if (configActionPending.value) return
  configActionPending.value = true
  try {
    const res = await fetch(`${statsApiBase.value}/config/agents/${id}/restore-default`, { method: 'POST' })
    if (!res?.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    toastSuccess('Restored')
    await fetchAgents()
  } finally {
    configActionPending.value = false
  }
}

async function fetchSavedModels() {
  const base = statsApiBase.value
  if (!base) return
  const res = await fetch(`${base}/config/models`, { cache: 'no-store' })
  if (!res || !res.ok) {
    if (res?.status === 404) savedModels.value = []
    return
  }
  const payload = (await res.json()) as { models?: typeof savedModels.value }
  savedModels.value = payload.models ?? []
}

function clearDiscoveredModels() {
  discoveredModels.value = []
}

function onDiscoverModels(
  payload: { provider: string; access_key: string; base_url?: string },
  options?: { quiet?: boolean }
) {
  void discoverModels(payload, options ?? {})
}

async function discoverModels(
  payload: { provider: string; access_key: string; base_url?: string },
  options: { quiet?: boolean } = {}
) {
  if (configActionPending.value && !options.quiet) return
  if (!options.quiet) configActionPending.value = true
  try {
    const res = await fetch(`${statsApiBase.value}/config/models/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: payload.provider,
        access_key: payload.access_key,
        ...(payload.base_url?.trim() ? { base_url: payload.base_url.trim() } : {})
      })
    })
    if (!res?.ok) {
      if (!options.quiet) toastError(await readApiErrorMessage(res))
      else discoveredModels.value = []
      return
    }
    const body = (await res.json()) as { models?: typeof discoveredModels.value }
    discoveredModels.value = body.models ?? []
    if (!options.quiet) toastSuccess('Found models')
  } finally {
    if (!options.quiet) configActionPending.value = false
  }
}

async function saveModels(payload: {
  provider: string
  access_key: string
  base_url?: string
  selectedIds: string[]
  customName?: string
  categories: string[]
  priority: number
  perModel?: Record<string, { categories: string[]; priority: number }>
  editExistingModelIds?: string[]
}) {
  if (configActionPending.value) return
  const prov = payload.provider.trim()
  const keyInput = payload.access_key.trim()
  const apiBase =
    prov.toLowerCase() === 'openai_compatible' && payload.base_url?.trim()
      ? payload.base_url.trim()
      : undefined

  const editIds = payload.editExistingModelIds?.length
    ? [...new Set(payload.editExistingModelIds.map((x) => String(x).trim()).filter(Boolean))]
    : null

  if (editIds?.length) {
    const groupModels = savedModels.value.filter((m) => editIds.includes(m._id))
    if (!groupModels.length) {
      toastError('Could not find saved models to update.')
      modelsPanelRef.value?.notifySaveComplete(false)
      return
    }
    const rep = groupModels[0]!
    const effectiveKey = keyInput || rep.access_key?.trim() || ''
    const credentialId = rep.credential_id?.toString()
    const existingNames = new Set(groupModels.map((m) => m.name))

    const connectionBody: Record<string, unknown> = {}
    if (keyInput) connectionBody.access_key = keyInput
    if (prov === 'openai_compatible' && apiBase) connectionBody.api_base_url = apiBase

    const discoverList = discoveredModels.value
    const modelsToAdd = discoverList.filter(
      (m) => payload.selectedIds.includes(m.id) && !existingNames.has(m.name)
    )
    const customId = payload.customName?.trim()
    const customToAdd =
      customId && !existingNames.has(customId)
        ? [
            {
              id: customId,
              name: customId,
              label: customId,
              capabilities: [] as string[]
            }
          ]
        : []
    const toCreate = [...modelsToAdd, ...customToAdd]

    if (!Object.keys(connectionBody).length && !toCreate.length) {
      toastError('Nothing to save — change the key or base URL, select new catalog models, or add a custom id.')
      modelsPanelRef.value?.notifySaveComplete(false)
      return
    }

    configActionPending.value = true
    let ok = false
    try {
      if (Object.keys(connectionBody).length) {
        const puts = await Promise.all(
          editIds.map((id) =>
            fetch(`${statsApiBase.value}/config/models/${encodeURIComponent(id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(connectionBody)
            })
          )
        )
        const bad = puts.find((r) => !r.ok)
        if (bad) {
          toastError(await readApiErrorMessage(bad))
          return
        }
      }

      if (toCreate.length) {
        if (!effectiveKey) {
          toastError('API key is required to add models to this account.')
          return
        }
        if (!credentialId) {
          const posts = await Promise.all(
            toCreate.map((m) => {
              const row = payload.perModel?.[m.id]
              const categories = row?.categories ?? payload.categories
              const priority = row?.priority ?? payload.priority
              return fetch(`${statsApiBase.value}/config/models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  provider: prov,
                  access_key: effectiveKey,
                  name: m.name,
                  label: m.label,
                  capabilities: m.capabilities,
                  categories,
                  priority,
                  ...(apiBase ? { api_base_url: apiBase } : {}),
                  is_custom: Boolean(customId && m.name === customId)
                })
              })
            })
          )
          const bad = posts.find((r) => !r.ok)
          if (bad) {
            toastError(await readApiErrorMessage(bad))
            return
          }
        } else {
          const posts = await Promise.all(
            toCreate.map((m) => {
              const row = payload.perModel?.[m.id]
              const categories = row?.categories ?? payload.categories
              const priority = row?.priority ?? payload.priority
              return fetch(`${statsApiBase.value}/config/models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  provider: prov,
                  access_key: effectiveKey,
                  credential_id: credentialId,
                  ...(apiBase ? { api_base_url: apiBase } : {}),
                  name: m.name,
                  label: m.label,
                  capabilities: m.capabilities,
                  categories,
                  priority,
                  is_custom: Boolean(customId && m.name === customId)
                })
              })
            })
          )
          const bad = posts.find((r) => !r.ok)
          if (bad) {
            toastError(await readApiErrorMessage(bad))
            return
          }
        }
      }

      toastSuccess('Saved')
      await fetchSavedModels()
      ok = true
    } finally {
      configActionPending.value = false
      modelsPanelRef.value?.notifySaveComplete(ok)
    }
    return
  }

  if (!prov || !keyInput) {
    toastError('Provider and access key are required.')
    modelsPanelRef.value?.notifySaveComplete(false)
    return
  }
  const modelsToSave = discoveredModels.value.filter((m) => payload.selectedIds.includes(m.id))
  if (payload.customName) {
    modelsToSave.push({
      id: payload.customName,
      name: payload.customName,
      label: payload.customName,
      capabilities: []
    })
  }
  if (!modelsToSave.length) {
    modelsPanelRef.value?.notifySaveComplete(false)
    return
  }

  configActionPending.value = true
  let ok = false
  try {
    const credRes = await fetch(`${statsApiBase.value}/config/models/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: prov,
        access_key: keyInput,
        ...(apiBase ? { api_base_url: apiBase } : {})
      })
    })
    if (!credRes.ok) {
      toastError(await readApiErrorMessage(credRes))
      return
    }
    const credJson = (await credRes.json()) as { credential?: { _id?: string } }
    const credentialId = credJson.credential?._id?.toString?.()
    if (!credentialId) {
      toastError('Could not create provider credentials.')
      return
    }

    const responses = await Promise.all(
      modelsToSave.map((m) => {
        const row = payload.perModel?.[m.id]
        const categories = row?.categories ?? payload.categories
        const priority = row?.priority ?? payload.priority
        return fetch(`${statsApiBase.value}/config/models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: prov,
            access_key: keyInput,
            credential_id: credentialId,
            ...(apiBase ? { api_base_url: apiBase } : {}),
            name: m.name,
            label: m.label,
            capabilities: m.capabilities,
            categories,
            priority,
            is_custom: Boolean(payload.customName && m.name === payload.customName)
          })
        })
      })
    )
    const failed = responses.filter((r) => !r.ok)
    if (failed.length) {
      toastError(await readApiErrorMessage(failed[0]!))
      return
    }
    toastSuccess('Saved')
    await fetchSavedModels()
    ok = true
  } finally {
    configActionPending.value = false
    modelsPanelRef.value?.notifySaveComplete(ok)
  }
}

async function saveLocalModel(payload: {
  name: string
  label: string
  categories: string[]
  priority: number
  api_base_url: string
  local_api_mode: 'ollama' | 'openai'
  access_key?: string
  editExistingModelIds?: string[]
  /** When true, only `api_base_url`, `local_api_mode`, and optional `access_key` are applied to every id. */
  connectionOnly?: boolean
}) {
  if (configActionPending.value) return
  const editIds = payload.editExistingModelIds?.length
    ? [...new Set(payload.editExistingModelIds.map((x) => String(x).trim()).filter(Boolean))]
    : null

  if (editIds?.length) {
    configActionPending.value = true
    let ok = false
    try {
      const api = payload.api_base_url.trim()
      if (!api) {
        toastError('Base URL is required.')
        return
      }
      if (!/^https?:\/\//i.test(api)) {
        toastError('Base URL must start with http:// or https://.')
        return
      }
      if (payload.connectionOnly || editIds.length > 1) {
        const body: Record<string, unknown> = {
          api_base_url: api,
          local_api_mode: payload.local_api_mode
        }
        const ak = payload.access_key?.trim()
        if (ak) body.access_key = ak
        const results = await Promise.all(
          editIds.map((id) =>
            fetch(`${statsApiBase.value}/config/models/${encodeURIComponent(id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            })
          )
        )
        const bad = results.find((r) => !r.ok)
        if (bad) {
          toastError(await readApiErrorMessage(bad))
          return
        }
        toastSuccess(editIds.length === 1 ? 'Saved' : `Saved (${editIds.length} models)`)
      } else {
        const id = editIds[0]!
        const name = payload.name.trim()
        if (!name) {
          toastError('Model id / tag is required.')
          return
        }
        const body: Record<string, unknown> = {
          name,
          label: payload.label.trim() || name,
          categories: payload.categories,
          priority: Math.min(999999, Math.floor(Number(payload.priority) || 0)),
          api_base_url: api,
          local_api_mode: payload.local_api_mode
        }
        const ak = payload.access_key?.trim()
        if (ak) body.access_key = ak
        const res = await fetch(`${statsApiBase.value}/config/models/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        if (!res.ok) {
          toastError(await readApiErrorMessage(res))
          return
        }
        toastSuccess('Saved')
      }
      await fetchSavedModels()
      ok = true
    } finally {
      configActionPending.value = false
      modelsPanelRef.value?.notifySaveComplete(ok)
    }
    return
  }

  configActionPending.value = true
  try {
    const credRes = await fetch(`${statsApiBase.value}/config/models/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'local',
        access_key: payload.access_key?.trim() || undefined,
        api_base_url: payload.api_base_url,
        local_api_mode: payload.local_api_mode
      })
    })
    if (!credRes.ok) {
      toastError(await readApiErrorMessage(credRes))
      return
    }
    const credJson = (await credRes.json()) as { credential?: { _id?: string } }
    const credentialId = credJson.credential?._id?.toString?.()
    if (!credentialId) {
      toastError('Could not create local credentials.')
      return
    }

    const res = await fetch(`${statsApiBase.value}/config/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'local',
        name: payload.name,
        label: payload.label,
        credential_id: credentialId,
        categories: payload.categories,
        priority: payload.priority,
        api_base_url: payload.api_base_url,
        local_api_mode: payload.local_api_mode,
        access_key: payload.access_key?.trim() || undefined,
        capabilities: [],
        enabled: true,
        is_custom: true
      })
    })
    if (!res.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    toastSuccess('Local model added')
    await fetchSavedModels()
  } finally {
    configActionPending.value = false
  }
}

async function verifyLocalModelEndpoint(payload: {
  api_base_url: string
  local_api_mode: 'ollama' | 'openai'
  access_key?: string
  model_name?: string
}) {
  localVerifyPending.value = true
  try {
    const res = await fetch(`${statsApiBase.value}/config/models/verify-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_base_url: payload.api_base_url,
        local_api_mode: payload.local_api_mode,
        access_key: payload.access_key,
        model_name: payload.model_name
      })
    })
    if (!res.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    const body = (await res.json()) as { modelsSample?: string[] }
    const n = body.modelsSample?.length ?? 0
    toastSuccess(
      n > 0
        ? `Reachable — ${n} model(s) seen (showing up to 24).`
        : 'Reachable — server responded (no models in sample).'
    )
  } catch {
    toastError('Verify request failed.')
  } finally {
    localVerifyPending.value = false
  }
}

async function deleteModel(id: unknown) {
  const sid = mongoIdString(id)
  if (!sid) {
    toastError('Invalid model id.')
    return
  }
  await ensureConfigBaseUrl()
  const base = statsApiBase.value
  if (!base) {
    toastError('Could not resolve the stats server URL. Open the home page or wait for discovery, then try again.')
    return
  }
  configActionPending.value = true
  try {
    const res = await fetch(`${base}/config/models/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
      cache: 'no-store'
    })
    if (!res.ok) {
      toastError(await readApiErrorMessage(res))
      return
    }
    toastSuccess('Removed')
    await fetchSavedModels()
  } catch {
    toastError('Delete request failed (network error).')
  } finally {
    configActionPending.value = false
  }
}

async function deleteModels(ids: unknown[]) {
  const list = [...new Set(ids.map((x) => mongoIdString(x)).filter(Boolean))]
  if (!list.length) {
    toastError('Nothing to remove.')
    return
  }
  await ensureConfigBaseUrl()
  const base = statsApiBase.value
  if (!base) {
    toastError('Could not resolve the stats server URL. Open the home page or wait for discovery, then try again.')
    return
  }
  configActionPending.value = true
  try {
    for (const id of list) {
      const res = await fetch(`${base}/config/models/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        cache: 'no-store'
      })
      if (!res.ok) {
        toastError(await readApiErrorMessage(res))
        return
      }
    }
    toastSuccess(list.length === 1 ? 'Removed' : `Removed ${list.length} models`)
    await fetchSavedModels()
  } catch {
    toastError('Delete request failed (network error).')
  } finally {
    configActionPending.value = false
  }
}

async function batchPatchModelInline(
  updates: Array<{ id: string; body: { categories: string[]; priority: number; enabled: boolean } }>
): Promise<boolean> {
  if (!updates.length || configActionPending.value) return true
  configActionPending.value = true
  try {
    const results = await Promise.all(
      updates.map((u) =>
        fetch(`${statsApiBase.value}/config/models/${u.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(u.body)
        })
      )
    )
    const failed = results.find((r) => !r.ok)
    if (failed) {
      toastError(await readApiErrorMessage(failed))
      return false
    }
    toastSuccess(updates.length === 1 ? 'Saved changes' : `Saved ${updates.length} models`)
    await fetchSavedModels()
    return true
  } finally {
    configActionPending.value = false
  }
}

function closeConfigNavGuard() {
  configNavGuardOpen.value = false
  pendingConfigNav.value = null
}

async function configNavSaveAndGo() {
  const updates = modelsPanelRef.value?.collectDirtyInlineUpdates() ?? []
  let ok = true
  if (updates.length) ok = await batchPatchModelInline(updates)
  if (!ok) return
  const dest = pendingConfigNav.value
  configNavGuardOpen.value = false
  pendingConfigNav.value = null
  modelsInlineDirty.value = false
  if (dest) await router.push(dest)
}

async function refreshDiscoveryForSavedProviders() {
  const providers = new Map<string, string>()
  for (const model of savedModels.value) {
    const p = model.provider?.toLowerCase() ?? ''
    if (p === 'local' || !model.access_key?.trim()) continue
    if (model.provider && model.access_key) providers.set(model.provider, model.access_key)
  }
  for (const [provider, access_key] of providers.entries()) {
    await discoverModels({ provider, access_key }, { quiet: true })
  }
}

async function onProjectInit() {
  await fetchProjects()
}

/**
 * Reactive entry point: fires immediately on setup (handles URL already known from index.vue)
 * and again whenever the primary URL changes. All data loading and socket lifecycle live here.
 */
watch(
  configBaseUrl,
  async (url, prevUrl) => {
    if (prevUrl && url !== prevUrl && socket) {
      socket.disconnect()
      socket = null
    }
    if (!url) return

    await fetchProjects()
    if (selectedProjectKey.value) await fetchConfig()

    const sec = selectedSection.value
    if (sec === 'prompts-global') await fetchPrompts()
    else if (sec === 'prompts-personas') await fetchPersonas()
    else if (sec === 'prompts-agents') {
      await fetchSavedModels()
      await fetchPersonas()
      await fetchAgents()
      await refreshDiscoveryForSavedProviders()
    } else if (sec === 'models') {
      await fetchSavedModels()
      await refreshDiscoveryForSavedProviders()
    } else if (sec === 'settings' && selectedProjectKey.value) {
      await fetchProjectFileProcessing()
    }

    if (!socket) {
      const { io } = await import('../lib/socketIoClient')
      socket = io(url, { autoConnect: true, reconnection: true })
      primaryBaseUrl.value = url
      socket.on('connect', () => {
        void fetchProjects()
        if (selectedSection.value === 'prompts-personas') void fetchPersonas()
        if (selectedSection.value === 'prompts-agents') {
          void fetchSavedModels()
          void fetchPersonas()
          void fetchAgents()
        }
        if (selectedSection.value === 'settings' && selectedProjectKey.value) void fetchProjectFileProcessing()
      })
      socket.on('project', (data: unknown) => {
        try {
          const str = typeof data === 'string' ? data : JSON.stringify(data)
          const payload = JSON.parse(str) as { action?: string }
          if (payload.action === 'unchanged') return
        } catch {
          // Refresh for safety if payload shape is unexpected.
        }
        void onProjectInit()
      })
    }
  },
  { immediate: true }
)

onMounted(async () => {
  await nextTick()
  // Apply hash-driven section first so the configBaseUrl watcher fetches the right section data.
  applyRouteHashToSection()
  // Discover the primary URL if not already known; setting it triggers the watcher above.
  await ensureConfigBaseUrl()
})

onUnmounted(() => {
  if (socket) socket.disconnect()
  socket = null
})
</script>

