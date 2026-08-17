# Agent Development Rules

This document outlines the rules and guidelines for developing agents within this repository.

## MCP Protocol

All agents must adhere to the Model Context Protocol (MCP). The MCP server indexes the codebase into a MongoDB instance, providing a knowledge graph of code structures for AI agents.

## Which interfaces MUST use MCP

Interfaces that deal with the following MUST use the MCP protocol:
- Symbol extraction (interfaces, classes, functions)
- Code analysis and knowledge graph interactions

## Unit Tests

- **Test-Driven Development (TDD):** Write tests *before* writing implementation code. Follow the Red-Green-Refactor cycle. No production code should be added without a failing test that justifies it.
- **Coverage:** 100% branch coverage is required. The build will fail if coverage thresholds are not met.

## UI

The platform UI is built using Vue.js and Nuxt. All UI development should follow established best practices for these frameworks.

## Logging Requirements

- All agents must implement structured logging.
- Logs should be clear, concise, and provide enough context to debug issues without revealing sensitive information.

## Coding Style

- Follow a consistent coding style throughout the codebase.
- Use a linter to enforce style guidelines.

## DO NOTS

- **Minimal changes for Bug Fixes:** When fixing bugs, make the smallest possible change to fix the issue. Avoid large refactors in bug fix commits.
- **100% path testing is not required:** Focus on testing critical paths and edge cases.
- **No handle leaks:** Ensure that all file handles, network connections, and other resources are properly closed.
- **No memory leaks:** Profile and test for memory leaks.
- **Algorithmic Complexity:** Use efficient algorithms. Aim for O(1), O(log n), or O(n log n) complexity for lookups and other operations. Avoid O(n^2) or greater complexity.
