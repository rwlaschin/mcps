const mockAgentLean = jest.fn();
const mockSystemPromptLean = jest.fn();

jest.mock('../src/db/models/Agent', () => ({
  Agent: {
    findById: jest.fn(() => ({ lean: () => mockAgentLean() })),
    findOne: jest.fn(() => ({ lean: () => mockAgentLean() }))
  }
}));

jest.mock('../src/db/models/SystemPrompt', () => ({
  SystemPrompt: {
    findById: jest.fn(() => ({ lean: () => mockSystemPromptLean() }))
  }
}));

import { Agent } from '../src/db/models/Agent';
import { SystemPrompt } from '../src/db/models/SystemPrompt';
import { loadAgentExecutionBundleById, loadAgentExecutionBundleByName } from '../src/agent/loadAgentExecutionBundle';

describe('loadAgentExecutionBundle', () => {
  beforeEach(() => {
    mockAgentLean.mockReset();
    mockSystemPromptLean.mockReset();
  });

  it('loadAgentExecutionBundleById returns null when agent missing', async () => {
    mockAgentLean.mockResolvedValue(null);
    const b = await loadAgentExecutionBundleById('507f1f77bcf86cd799439012');
    expect(b).toBeNull();
  });

  it('maps tool_name and tools onto bundle.agent', async () => {
    mockAgentLean.mockResolvedValue({
      name: 'N',
      description: 'D',
      system_prompt: 'S',
      tool_name: 'code_review',
      model_categories: ['fast'],
      persona_ids: [],
      tools: {
        file_watch: true,
        db_read_write: false,
        web_search: false,
        run_shell: false
      },
      global_prompt_id: null
    });
    const b = await loadAgentExecutionBundleById('507f1f77bcf86cd799439012');
    expect(b?.agent.tool_name).toBe('code_review');
    expect(b?.agent.tools.file_watch).toBe(true);
    expect(b?.personas).toEqual([]);
  });

  it('includes structure metadata on globalPrompt when linked', async () => {
    mockSystemPromptLean.mockResolvedValue({
      slug: 'user-request',
      name: 'User Request',
      prompt: 'p',
      category: 'blended',
      prompt_type: 'processing',
      structure_mode: 'structured',
      structure_preset: 'agent_pipeline_steps',
      structure_mime: 'application/json'
    });
    mockAgentLean.mockResolvedValue({
      name: 'N',
      description: 'D',
      system_prompt: 'S',
      tool_name: 't',
      model_categories: ['fast'],
      persona_ids: [],
      tools: {
        file_watch: false,
        db_read_write: false,
        web_search: false,
        run_shell: false
      },
      global_prompt_id: '507f1f77bcf86cd799439011'
    });
    const b = await loadAgentExecutionBundleById('507f1f77bcf86cd799439012');
    expect(SystemPrompt.findById).toHaveBeenCalled();
    expect(b?.globalPrompt?.structure_mode).toBe('structured');
    expect(b?.globalPrompt?.structure_preset).toBe('agent_pipeline_steps');
    expect(b?.globalPrompt?.structure_mime).toBe('application/json');
  });

  it('loadAgentExecutionBundleByName delegates to id path', async () => {
    mockAgentLean
      .mockResolvedValueOnce({
        _id: '507f1f77bcf86cd799439099',
        name: 'N',
        description: 'D',
        system_prompt: 'S',
        tool_name: 't',
        persona_ids: [],
        tools: {
          file_watch: false,
          db_read_write: false,
          web_search: false,
          run_shell: false
        },
        global_prompt_id: null
      })
      .mockResolvedValueOnce({
        name: 'N',
        description: 'D',
        system_prompt: 'S',
        tool_name: 't',
        persona_ids: [],
        tools: {
          file_watch: false,
          db_read_write: false,
          web_search: false,
          run_shell: false
        },
        global_prompt_id: null
      });
    const b = await loadAgentExecutionBundleByName('N');
    expect(Agent.findOne).toHaveBeenCalled();
    expect(b?.agent.name).toBe('N');
  });
});
