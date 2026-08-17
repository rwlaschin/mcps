# MCP Code Vault

A local-first Model Context Protocol (MCP) server that indexes local codebases into a MongoDB instance, providing a knowledge graph of code structures for AI agents.

## Features
- Incremental codebase sync
- Symbol extraction (interfaces, classes, functions)
- MCP protocol tools
- Efficient file watching and ignore logic

## LLM Integration
- Supports both locally hosted and remote (cloud) LLMs for code analysis
- Uses LangChain for unified LLM interface
- Compatible with OpenAI, Anthropic, Ollama, LocalAI, LM Studio, and more
- Switch between local and remote models via configuration (API endpoint, model name, API key)

## How to start the server

1. Install dependencies: `npm install`
2. Set `PORT` in `.env` (e.g. `PORT=3000`)
3. Build and run: `npm run build` then `npm start`

See the **Docs** page in the platform UI for setup, MCP in Cursor, configuration (projects, models, personas, agents), and running the Platform UI.

## Scripts
- `build`: Compile TypeScript
- `start`: Run compiled server
- `dev`: Run in development mode
- `test`: Run tests

## License
MIT
