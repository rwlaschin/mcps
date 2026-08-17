import fs from 'fs';
const p = '/Users/mac/Documents/Projects/mcps/code-knowledgebase/mcp-code-vault/platform-ui/pages/config.vue';
let t = fs.readFileSync(p, 'utf8');

t = t.replace(
  `import ConfigAgentsPanel from '../components/ConfigAgentsPanel.vue'`,
  `import ConfigAgentsPanel from '../components/ConfigAgentsPanel.vue'
import ModelCategoriesInput from '../components/ModelCategoriesInput.vue'`
);

t = t.replace(
`    case 'prompts-global':
      return 'Processing prompts used when indexing and summarizing code chunks.'`,
`    case 'prompts-global':
      return 'Vault prompts: each has a Name and a Type (e.g. file processor, user request). One default per type.'`
);

const oldPromptRef = `const promptItems = ref<
  Array<{
    _id: string
    name: string
    prompt: string
    prompt_type: 'processing' | 'agent'
    category: 'fast' | 'blended' | 'thinking'
    is_default: boolean
    save_to_seed: boolean
    structure_mode?: 'unstructured' | 'structured'
    structure_preset?: string
    structure_mime?: 'application/json' | 'application/x-yaml-extended'
  }>
>([])
const processingPromptItems = computed(() => promptItems.value.filter((p) => p.prompt_type === 'processing'))`;

const newPromptRef = `const promptItems = ref<
  Array<{
    _id: string
    name: string
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
>([])`;

if (!t.includes('processingPromptItems = computed')) throw new Error('expected processingPromptItems');
t = t.replace(oldPromptRef, newPromptRef);

if (!t.includes('projectFileProcLoading')) {
  t = t.replace(
    `const configActionPending = ref(false)\n`,
    `const configActionPending = ref(false)
const projectFileProcLoading = ref(false)
const projectFileProc = reactive({
  batch: 30,
  pauseMs: 100,
  concurrency: 3,
  debounceMs: 5000,
  promptSlug: '',
  modelCategories: [] as string[]
})

`
  );
}

t = t.replace(
`import { ref, computed, watch, onMounted, onUnmounted, useTemplateRef, nextTick } from 'vue'`,
`import { ref, computed, watch, reactive, onMounted, onUnmounted, useTemplateRef, nextTick } from 'vue'`
);

t = t.replace(
`    const processing = promptItems.value.filter((p) => p.prompt_type === 'processing')
    if (!selectedProcessingPromptId.value && processing.length) {
      selectedProcessingPromptId.value = processing[0]!._id
    }`,
`    if (!selectedProcessingPromptId.value && promptItems.value.length) {
      selectedProcessingPromptId.value = promptItems.value[0]!._id
    }`
);

t = t.replace(
`  prompt_type: 'processing' | 'agent'
  category: 'fast' | 'blended' | 'thinking'
  is_default: boolean
  save_to_seed: boolean
  structure_mode?: 'unstructured' | 'structured'
  structure_preset?: string
  structure_mime?: 'application/json' | 'application/x-yaml-extended'
}) {
  if (configActionPending.value) return`,
`  usage_type: string
  category: 'fast' | 'blended' | 'thinking'
  is_default: boolean
  save_to_seed: boolean
  structure_mode?: 'unstructured' | 'structured'
  structure_preset?: string
  structure_mime?: 'application/json' | 'application/x-yaml-extended'
}) {
  if (configActionPending.value) return`
);

// Add fetch + save after fetchConfig
const anchor = `watch(selectedProjectKey, () => {
  if (configBaseUrl.value) void fetchConfig()
})`;
const extra = `watch(selectedProjectKey, () => {
  if (configBaseUrl.value) void fetchConfig()
  if (configBaseUrl.value && selectedProjectKey.value) void fetchProjectFileProcessing()
})`;

if (t.includes('void fetchProjectFileProcessing')) {
  // already
} else {
  t = t.replace(anchor, extra);
}

const fetchConfigBlock = `async function fetchConfig() {
  const key = selectedProjectKey.value
  if (!key) {
    configText.value = ''
    return
  }
  configLoading.value = true
  try {
    const res = await fetch(\`\${statsApiBase.value}/config?projectKey=\${encodeURIComponent(key)}\`)
    if (res && res.ok) {
      const body = (await res.json()) as { config?: string }
      configText.value = body.config ?? ''
    }
  } catch {
    // keep previous state
  } finally {
    configLoading.value = false
  }
}`;

const fetchFp = `
async function fetchProjectFileProcessing() {
  const key = selectedProjectKey.value
  if (!key || !statsApiBase.value) return
  projectFileProcLoading.value = true
  try {
    const res = await fetch(
      \`\${statsApiBase.value}/config/project-file-processing?projectKey=\${encodeURIComponent(key)}\`
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
      file_processing_prompt_slug?: string
      file_processing_model_categories?: string[]
    }
    projectFileProc.batch = body.file_processing_batch_size ?? 30
    projectFileProc.pauseMs = body.file_processing_pause_ms ?? 100
    projectFileProc.concurrency = body.file_processing_concurrency ?? 3
    projectFileProc.debounceMs = body.file_processing_debounce_ms ?? 5000
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
  configActionPending.value = true
  try {
    const res = await fetch(
      \`\${statsApiBase.value}/config/project-file-processing?projectKey=\${encodeURIComponent(key)}\`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_processing_batch_size: projectFileProc.batch,
          file_processing_pause_ms: projectFileProc.pauseMs,
          file_processing_concurrency: projectFileProc.concurrency,
          file_processing_debounce_ms: projectFileProc.debounceMs,
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
`;

if (!t.includes('async function fetchProjectFileProcessing')) {
  t = t.replace(fetchConfigBlock, fetchConfigBlock + fetchFp);
}

fs.writeFileSync(p, t);
console.log('patch-config-vue done');
