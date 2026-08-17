jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn()
}));

import * as fs from 'fs';
import {
  readAgentSeedRows,
  readPersonaSeedRows,
  writeAgentSeedRows,
  writePersonaSeedRows,
  type AgentSeedRow,
  type PersonaSeedRow
} from '../src/stats/configSeedJson';

const existsSync = fs.existsSync as jest.Mock;
const readFileSync = fs.readFileSync as jest.Mock;
const writeFileSync = fs.writeFileSync as jest.Mock;
const mkdirSync = fs.mkdirSync as jest.Mock;

describe('configSeedJson', () => {
  beforeEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
    writeFileSync.mockReset();
    mkdirSync.mockReset();
  });

  describe('readPersonaSeedRows', () => {
    it('returns [] when file missing', () => {
      existsSync.mockReturnValue(false);
      expect(readPersonaSeedRows()).toEqual([]);
    });

    it('parses persona array', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('[{"name":"p","description":"d","prompt":"x"}]');
      expect(readPersonaSeedRows()).toEqual([{ name: 'p', description: 'd', prompt: 'x' }]);
    });

    it('returns [] on parse error', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('not-json');
      expect(readPersonaSeedRows()).toEqual([]);
    });

    it('returns [] when JSON is not an array', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('{"a":1}');
      expect(readPersonaSeedRows()).toEqual([]);
    });
  });

  describe('readAgentSeedRows', () => {
    it('returns [] when file missing', () => {
      existsSync.mockReturnValue(false);
      expect(readAgentSeedRows()).toEqual([]);
    });

    it('parses agent array', () => {
      existsSync.mockReturnValue(true);
      const row: AgentSeedRow = {
        name: 'A',
        description: 'd',
        system_prompt: 's',
        tool_name: 'f',
        project_key: 'default',
        model_categories: ['fast'],
        persona_names: [],
        tools: { file_watch: true }
      };
      readFileSync.mockReturnValue(JSON.stringify([row]));
      expect(readAgentSeedRows()).toEqual([row]);
    });

    it('returns [] on parse error', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('{');
      expect(readAgentSeedRows()).toEqual([]);
    });

    it('returns [] when JSON is not an array', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('{}');
      expect(readAgentSeedRows()).toEqual([]);
    });
  });

  describe('writePersonaSeedRows / writeAgentSeedRows', () => {
    it('writes personas and creates seed dir when missing', () => {
      existsSync.mockReturnValue(false);
      const rows: PersonaSeedRow[] = [{ name: 'n', description: 'd', prompt: 'p' }];
      writePersonaSeedRows(rows);
      expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), JSON.stringify(rows, null, 2), 'utf-8');
    });

    it('writes agents when seed dir exists', () => {
      existsSync.mockReturnValue(true);
      const rows: AgentSeedRow[] = [
        {
          name: 'B',
          description: 'd',
          system_prompt: 's',
          tool_name: 'f',
          project_key: 'default',
          persona_names: [],
          tools: {}
        }
      ];
      writeAgentSeedRows(rows);
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), JSON.stringify(rows, null, 2), 'utf-8');
    });
  });
});
