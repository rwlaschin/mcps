// Framework-convention exports, shared by the CLI and MCP dead-export paths.
//
// Called by the framework, never by code — static resolution cannot see these, and a text
// search "confirms" they are unused. Withheld from dead-export listings so nothing downstream
// can mistake them for deletable.
//
// Lived in cli.mjs only, which meant the MCP tool advertised withholding it never performed.
// Both paths import from here so the two can never drift again.

const FRAMEWORK_EXPORTS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'default', 'middleware',
  'generateMetadata', 'generateStaticParams', 'generateViewport', 'metadata', 'viewport',
  'revalidate', 'dynamic', 'dynamicParams', 'runtime', 'fetchCache', 'preferredRegion', 'maxDuration',
])

// Next.js file conventions: the framework imports these by PATH, and a default export keeps its
// function name (`export default function ApprovalsPage`), so a name check alone misses them.
const FRAMEWORK_FILES =
  /(^|\/)(page|layout|route|template|default|error|global-error|loading|not-found|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image|instrumentation|middleware)\.(ts|tsx|js|jsx)$/

// Both arguments are required: a name check alone misses path-convention files, and a path
// check alone misses route handlers in non-convention files.
export function isFrameworkExport(name, file) {
  return FRAMEWORK_EXPORTS.has(name) || FRAMEWORK_FILES.test(file)
}

export { FRAMEWORK_EXPORTS, FRAMEWORK_FILES }
