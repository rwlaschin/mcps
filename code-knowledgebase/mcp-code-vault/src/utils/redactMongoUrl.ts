import { ConnectionString } from 'mongodb-connection-string-url';

/** Env value that is only `mongodb://***` / `mongodb+srv://***` — not a usable connection string. */
const PLACEHOLDER_ONLY = /^(mongodb(?:\+srv)?:\/\/)\*+$/i;

export type MongoUrlSettingsFormat = {
  /** URI with hosts, path, and query only — userinfo never included. */
  urlForDisplay: string;
  /** True when the original URI had a username or password (omitted from urlForDisplay). */
  hadCredentials: boolean;
};

/**
 * Format MONGO_URL for Settings / Config UI: real hosts, ports, path, and query — never user/password.
 * Not a copy-paste connection string when {@link MongoUrlSettingsFormat.hadCredentials} is true.
 */
export function formatMongoUrlForSettings(url: string | undefined | null): MongoUrlSettingsFormat {
  if (url == null || String(url).trim() === '') {
    return { urlForDisplay: '(not set)', hadCredentials: false };
  }
  const s = String(url).trim();

  if (PLACEHOLDER_ONLY.test(s)) {
    return {
      urlForDisplay:
        '(MONGO_URL is not a full connection string — set e.g. mongodb://localhost:27017/yourdb ' +
        'or mongodb://user:pass@host:27017/yourdb in .env)',
      hadCredentials: false
    };
  }

  try {
    const conn = new ConnectionString(s);
    const hadCredentials = Boolean(conn.username || conn.password);
    if (!hadCredentials) {
      return { urlForDisplay: s, hadCredentials: false };
    }
    const proto = conn.protocol;
    const hostList = conn.hosts.join(',');
    const pathPart = conn.pathname || '/';
    return {
      urlForDisplay: `${proto}//${hostList}${pathPart}${conn.search}${conn.hash}`,
      hadCredentials: true
    };
  } catch {
    return stripMongoAuthLegacy(s);
  }
}

/** Lines for the Code-vault config block (HTTP Config page + MCP settings tool). */
export function mongoUrlLinesForSettingsContent(url: string | undefined | null): string {
  const m = formatMongoUrlForSettings(url);
  if (m.hadCredentials) {
    return (
      `mongoUrl: ${m.urlForDisplay}\n` +
      'mongoAuth: present in MONGO_URL (user/password not shown — use .env or MCP env)'
    );
  }
  return `mongoUrl: ${m.urlForDisplay}`;
}

/** Best-effort when {@link ConnectionString} rejects the string. */
function stripMongoAuthLegacy(s: string): MongoUrlSettingsFormat {
  const m = s.match(/^(mongodb(?:\+srv)?:\/\/)(.*)$/i);
  if (!m) return { urlForDisplay: s, hadCredentials: false };
  const rest = m[2] ?? '';
  const at = rest.indexOf('@');
  if (at === -1) return { urlForDisplay: s, hadCredentials: false };
  const tail = rest.slice(at + 1);
  return { urlForDisplay: `${m[1]}${tail}`, hadCredentials: true };
}
