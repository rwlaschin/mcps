import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { runShutdown, getShutdownOnTransportClose } from '../shutdown';
import { appendRequestLog } from './requestLog';
import { disconnectFromPrimary } from '../primaryClient';

function getMethod(message: JSONRPCMessage): string {
  if (message && typeof message === 'object' && 'method' in message && typeof (message as { method?: unknown }).method === 'string') {
    return (message as { method: string }).method;
  }
  return 'unknown';
}

type MessageHandler = (message: JSONRPCMessage, extra?: unknown) => void;

/**
 * Wraps StdioServerTransport to log each incoming request method to logs/mcp-requests.log
 * (even in stdio mode). Metrics for user-initiated tool calls (ping, config, etc.) are
 * recorded by withMetrics(operation) in the tool handlers, not here.
 */
export function createLoggingStdioTransport(): Transport {
  const inner = new StdioServerTransport();

  return {
    get onclose() {
      return inner.onclose;
    },
    set onclose(handler) {
      inner.onclose = () => {
        if (getShutdownOnTransportClose()) {
          disconnectFromPrimary();
          if (handler) handler();
          runShutdown().then(() => {});
        } else {
          if (handler) handler();
        }
      };
    },
    get onerror() {
      return inner.onerror;
    },
    set onerror(handler) {
      inner.onerror = handler;
    },
    get onmessage() {
      return inner.onmessage as MessageHandler | undefined;
    },
    set onmessage(handler: MessageHandler | undefined) {
      inner.onmessage = handler
        ? (message: JSONRPCMessage) => {
            appendRequestLog(getMethod(message));
            handler(message);
          }
        : undefined;
    },
    start: () => inner.start(),
    send: (message: JSONRPCMessage) => inner.send(message),
    close: () => inner.close()
  };
}
