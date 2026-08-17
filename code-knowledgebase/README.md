# code-knowledgebase

## Overview

A local-first Model Context Protocol (MCP) server that indexes local codebases into a MongoDB instance, providing a knowledge graph of code structures for AI agents. This is based on learnings from develop-it.ai.

## Setup

### Environment Variables

To run the server, you need to set up an environment file. Create an `.env` file in the root `mcp-code-vault` directory.

You can use a local or remote MongoDB instance.

```
# Port for the main stats and UI server to run on
PORT=3000

# MongoDB connection string (note the database name is mcp_code_vault)
MONGO_URI=mongodb://localhost:27017/mcp_code_vault
```

### Installation

Install the dependencies for both the server and the UI.

From the project root:

```bash
# Install server dependencies
cd mcp-code-vault
npm install

# Install UI dependencies
cd platform-ui
npm install
```

## Startup

You will need two terminals to run the project in development mode.

**Terminal 1: Start the MCP Server & UI Backend**

From the `mcp-code-vault` directory:

```bash
# Build the project
npm run build

# Start the server
npm start
```

The MCP server will start on the port defined in your `.env` file (e.g., `3000`).

**Terminal 2: Start the UI Frontend (for development)**

From the `mcp-code-vault/platform-ui` directory:

```bash
npm run dev
```

The UI development server will start on port `3001` and will proxy API requests to the main server running on `PORT`.

## UI End-points

Once running, you can access the UI at `http://localhost:3001` (in development).

*   **/ (Home):** Dashboard with an overview of the indexed project.
*   **/docs:** Documentation on how to use the MCP server and connect it to clients.
*   **/config:** View and manage the server configuration.
