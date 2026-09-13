import test from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { createVisualizerServer, startVisualizer } from "../visualizer.mjs"
import { EventEmitter } from "node:events"

function simulateRequest(server, url, method = "GET") {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.url = url
    req.method = method
    req.headers = { host: "127.0.0.1:7331" }
    
    let statusCode = 200
    const headers = {}
    let body = ""

    const res = new EventEmitter()
    res.setHeader = (key, val) => { headers[key.toLowerCase()] = val }
    res.writeHead = (code, h = {}) => { statusCode = code; Object.assign(headers, h) }
    Object.defineProperty(res, "statusCode", {
      get() { return statusCode },
      set(c) { statusCode = c }
    })
    res.end = (chunk) => {
      if (chunk) body += chunk
      resolve({ statusCode, headers, body })
    }

    server.emit("request", req, res)
  })
}

test("E2E: visualizer server serves Layered Call Flow UI HTML and valid client script", async () => {
  const server = createVisualizerServer("/test/root")
  const res = await simulateRequest(server, "/")

  assert.equal(res.statusCode, 200)
  assert.ok(res.headers["content-type"].includes("text/html"))
  assert.ok(res.body.includes("FRONTEND"), "Contains FRONTEND section")
  assert.ok(res.body.includes("BACKEND"), "Contains BACKEND section")
  assert.ok(res.body.includes('id="viewport"'), "Contains SVG viewport")
  assert.ok(res.body.includes("🔥 Most Called"), "Contains Most Called button")
  assert.ok(res.body.includes("👻 Orphans"), "Contains Orphans button")
  assert.ok(res.body.includes("⚠️ Upward Violations"), "Contains Violations button")
  assert.ok(res.body.includes('data-view="calltree"'), "Contains Call Tree view")
  assert.ok(res.body.includes('data-view="complexity"'), "Contains Complexity view")

  // Extract embedded <script> tags and parse with vm.Script to ensure zero syntax errors
  const scriptMatch = res.body.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(scriptMatch, "Expected embedded client <script>")
  assert.doesNotThrow(() => {
    new vm.Script(scriptMatch[1])
  }, "Client JavaScript inside <script> must have valid syntax without errors")
})

test("E2E: generated visualizer HTML defines the spin keyframes used by the loading spinner", async () => {
  const server = createVisualizerServer("/test/root")
  const res = await simulateRequest(server, "/")

  // Equivalence partition: a referenced CSS animation name must have a matching keyframes definition.
  assert.match(res.body, /@keyframes\s+spin\s*\{/)
})

test('E2E: complexity heatmap batches equal cells into color paths and resolves hover plus pinned click by grid coordinates', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const renderer = res.body.slice(res.body.indexOf('function renderComplexity()'), res.body.indexOf('function loadSunburst'))

  assert.deepEqual({
    createsBatchedPaths: /createElementNS\([^\n]+"path"\)/.test(renderer) && /(?:new Map|Map\()/.test(renderer),
    createsPerFunctionRects: /createElementNS\([^\n]+"rect"\)/.test(renderer),
    createsTextElements: /createElementNS\([^\n]+"text"\)/.test(renderer),
    resolvesGridCoordinates: /getBoundingClientRect/.test(renderer) && /Math\.floor/.test(renderer),
    previewsOnHover: /(?:pointermove|mousemove|mouseover)/.test(renderer) && /selection-details/.test(renderer),
    restoresAfterHover: /(?:pointerleave|mouseleave|mouseout)/.test(renderer),
    pinsAndLoadsInternalsOnClick: /click/.test(renderer) && /selectSummaryItem/.test(renderer),
  }, {
    createsBatchedPaths: true,
    createsPerFunctionRects: false,
    createsTextElements: false,
    resolvesGridCoordinates: true,
    previewsOnHover: true,
    restoresAfterHover: true,
    pinsAndLoadsInternalsOnClick: true,
  })
})

test('E2E: generated complexity client contains no histogram bar and counts the returned functions without sorting their complexities', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const loader = res.body.slice(res.body.indexOf('function loadComplexity('), res.body.indexOf('function renderSummaryCards('))

  assert.deepEqual({
    containsHistogramMarkup: /histogram|1-5|6-10|11-20|21\+/.test(res.body),
    mapsComplexities: /\.map\([^\n]*complexity/.test(loader),
    sortsValues: /\.sort\(/.test(loader),
    countsFunctionsDirectly: /data\.functions[^\n]*\.length/.test(loader),
  }, {
    containsHistogramMarkup: false,
    mapsComplexities: false,
    sortsValues: false,
    countsFunctionsDirectly: true,
  })
})

test('E2E: complexity client requests viewport dimensions and uses returned grid metadata for O(1) hit-testing', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const loader = res.body.slice(res.body.indexOf('function loadComplexity('), res.body.indexOf('function renderSummaryCards('))
  const renderer = res.body.slice(res.body.indexOf('function renderComplexity()'), res.body.indexOf('function loadSunburst'))
  const cellAt = renderer.slice(renderer.indexOf('const cellAt'), renderer.indexOf('canvas.onpointermove'))
  assert.deepEqual({
    readsViewport: /svg\.clientWidth/.test(loader) && /svg\.clientHeight/.test(loader),
    boundsToIntegers: /Math\.(?:floor|round|trunc)/.test(loader) && /Math\.(?:min|max)/.test(loader),
    sendsDimensions: /[?&]width=[^\n]+&height=/.test(loader),
    usesReturnedGrid: /complexityData\?*\.columns|complexityData\.columns/.test(cellAt) && /complexityData\?*\.rows|complexityData\.rows/.test(cellAt),
    scansFunctions: /findIndex/.test(cellAt),
  }, { readsViewport: true, boundsToIntegers: true, sendsDimensions: true, usesReturnedGrid: true, scansFunctions: false })
})

test("E2E: visualizer server processes graph query and outputs enriched layered JSON", async () => {
  const mockGraph = {
    symbols: [
      { id: "s1", name: "renderApp", file: "src/ui/App.tsx", line: 1 },
      { id: "s2", name: "fetchUsers", file: "src/services/user.ts", line: 10 },
      { id: "s3", name: "queryDb", file: "src/db/client.ts", line: 20 },
      { id: "s4", name: "deadCode", file: "src/util/orphan.ts", line: 5 },
    ],
    edges: [
      { from: "s1", to: "s2", call: true },
      { from: "s2", to: "s3", call: true },
      { from: "s3", to: "s1", call: true }, // Layer violation!
    ]
  }

  const mockStreamQuery = async function* () {
    yield mockGraph
  }

  const server = createVisualizerServer("/test/root", { streamQuery: mockStreamQuery })
  const res = await simulateRequest(server, "/graph")

  assert.equal(res.statusCode, 200)
  assert.ok(res.headers["content-type"].includes("application/json"))

  const data = JSON.parse(res.body)
  assert.ok(Array.isArray(data.nodes))
  assert.ok(Array.isArray(data.edges))
  assert.equal(data.nodes.length, 4)
  assert.equal(data.edges.length, 3)
  assert.equal(data.project.name, "root")
  assert.equal(data.project.root, "/test/root")

  const nodeMap = new Map(data.nodes.map(n => [n.id, n]))
  assert.ok(nodeMap.get("s1").layer < nodeMap.get("s2").layer)
  assert.ok(nodeMap.get("s2").layer < nodeMap.get("s3").layer)
  assert.equal(nodeMap.get("s4").isOrphan, true)

  // Verify HSV prime stride colors (no black, no white)
  for (const node of data.nodes) {
    assert.match(node.color, /^#[0-9a-f]{6}$/i)
    assert.notEqual(node.color.toLowerCase(), "#000000")
    assert.notEqual(node.color.toLowerCase(), "#ffffff")
  }

  // Verify upward layer violation detection
  const violation = data.edges.find(e => e.from === "s3" && e.to === "s1")
  assert.ok(violation)
  assert.equal(violation.isViolation, true)
})

test("E2E: visualizer server serves heatmap data on /heatmap", async () => {
  const mockGraph = {
    symbols: [
      { id: "s1", name: "renderApp", file: "src/ui/App.tsx", line: 1 },
      { id: "s2", name: "fetchUsers", file: "src/services/user.ts", line: 10 },
      { id: "s3", name: "queryDb", file: "src/db/client.ts", line: 20 },
    ],
    edges: [
      { from: "s1", to: "s2", call: true },
      { from: "s2", to: "s3", call: true },
    ]
  }

  const mockStreamQuery = async function* () {
    yield mockGraph
  }

  const server = createVisualizerServer("/test/root", { streamQuery: mockStreamQuery })
  const res = await simulateRequest(server, "/heatmap")

  assert.equal(res.statusCode, 200)
  assert.ok(res.headers["content-type"].includes("application/json"))

  const data = JSON.parse(res.body)
  assert.ok(Array.isArray(data.files))
  assert.ok(Array.isArray(data.modules))
  assert.equal(data.files.length, 3)
  assert.equal(data.project.name, "root")
  assert.equal(data.project.root, "/test/root")
})

test("E2E: visualizer server serves sunburst data on /sunburst", async () => {
  const mockGraph = {
    symbols: [
      { id: "s1", name: "renderApp", file: "src/ui/App.tsx", line: 1 },
      { id: "s2", name: "fetchUsers", file: "src/services/user.ts", line: 10 },
      { id: "s3", name: "queryDb", file: "src/db/client.ts", line: 20 },
    ],
    edges: [
      { from: "s1", to: "s2", call: true },
      { from: "s2", to: "s3", call: true },
    ]
  }

  const mockStreamQuery = async function* () {
    yield mockGraph
  }

  const server = createVisualizerServer("/test/root", { streamQuery: mockStreamQuery })
  const res = await simulateRequest(server, "/sunburst")

  assert.equal(res.statusCode, 200)
  assert.ok(res.headers["content-type"].includes("application/json"))

  const data = JSON.parse(res.body)
  assert.ok(Array.isArray(data.nodes))
  assert.ok(data.nodes.length >= 3)
  assert.equal(data.project.name, "root")
  assert.equal(data.project.root, "/test/root")
})

test("E2E: visualizer server serves chord data on /chord", async () => {
  const mockGraph = {
    symbols: [
      { id: "s1", name: "renderApp", file: "src/ui/App.tsx", line: 1 },
      { id: "s2", name: "fetchUsers", file: "src/services/user.ts", line: 10 },
      { id: "s3", name: "queryDb", file: "src/db/client.ts", line: 20 },
    ],
    edges: [
      { from: "s1", to: "s2", call: true },
      { from: "s2", to: "s3", call: true },
    ]
  }

  const mockStreamQuery = async function* () {
    yield mockGraph
  }

  const server = createVisualizerServer("/test/root", { streamQuery: mockStreamQuery })
  const res = await simulateRequest(server, "/chord")

  assert.equal(res.statusCode, 200)
  assert.ok(res.headers["content-type"].includes("application/json"))

  const data = JSON.parse(res.body)
  assert.ok(Array.isArray(data.modules))
  assert.ok(Array.isArray(data.chords))
  assert.equal(data.project.name, "root")
  assert.equal(data.project.root, "/test/root")
})

test("E2E: visualizer server serves /events SSE stream with connected status", async () => {
  const server = createVisualizerServer("/test/root")
  const p = new Promise((resolve) => {
    const req = new EventEmitter()
    req.url = "/events"
    req.method = "GET"
    req.headers = { host: "127.0.0.1:7331" }

    const res = new EventEmitter()
    let statusCode = 0
    const headers = {}
    let initialChunk = ""

    res.writeHead = (code, h = {}) => {
      statusCode = code
      Object.assign(headers, h)
    }
    res.write = (chunk) => {
      initialChunk += chunk
      req.emit("close")
      resolve({ statusCode, headers, initialChunk })
    }
    res.end = () => {}

    server.emit("request", req, res)
  })

  const res = await p
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers["content-type"], "text/event-stream")
  assert.ok(res.initialChunk.includes('data: {"status":"connected"}'))
})

test("E2E: visualizer detects file change, logs debounce, and dispatches ready event over SSE", async () => {
  const os = await import("node:os")
  const fs = await import("node:fs")
  const path = await import("node:path")

  const rawTmp = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-test-"))
  const tmpRoot = fs.realpathSync(rawTmp)
  const codegraphDir = path.join(tmpRoot, ".codegraph")
  fs.mkdirSync(codegraphDir, { recursive: true })

  try {
    const server = createVisualizerServer(tmpRoot, { debounceMs: 150, usePolling: true })
    const receivedEvents = []

    const req = new EventEmitter()
    req.url = "/events"
    req.method = "GET"
    req.headers = { host: "127.0.0.1:7331" }

    const res = new EventEmitter()
    res.writeHead = () => {}
    res.write = (chunk) => {
      const lines = chunk.toString().split("\n")
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            receivedEvents.push(JSON.parse(line.slice(6)))
          } catch {}
        }
      }
    }
    res.end = () => {}

    server.emit("request", req, res)
    assert.equal(receivedEvents[0]?.status, "connected")

    // Wait for chokidar watcher to be fully ready
    if (server.watcher) {
      await new Promise((r) => server.watcher.on("ready", r))
    }

    // Simulate CodeGraph daemon updating .codegraph/CURRENT
    fs.writeFileSync(path.join(codegraphDir, "CURRENT"), "gen-test-12345\n")

    // Wait for the 150ms quiet-window debounce to complete and broadcast
    await new Promise((r) => setTimeout(r, 450))

    // Confirm that the server detected the file and broadcasted indexing then ready
    const statuses = receivedEvents.map((e) => e.status)
    assert.ok(statuses.includes("indexing"), "Server must broadcast indexing status when file changes")
    assert.ok(statuses.includes("ready"), "Server must broadcast ready status after debounce quiet period")

    req.emit("close")
    await server.watcher?.close()
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test("E2E: visualizer server returns 404 on unknown routes", async () => {
  const server = createVisualizerServer("/test/root")
  const res = await simulateRequest(server, "/non-existent-route")
  assert.equal(res.statusCode, 404)
  assert.equal(res.body, "not found")
})

test('E2E: visualizer server serves bounded call tree summary data', async () => {
  const mockStreamQuery = async function* (_root, query) { if (query.type === 'internal-summaries') yield { owners: [], edges: [], generation: 'generation-a' } }
  const server = createVisualizerServer('/test/root', { streamQuery: mockStreamQuery })
  const res = await simulateRequest(server, '/calltree?depth=3&includeTests=0')
  assert.deepEqual({ statusCode: res.statusCode, body: JSON.parse(res.body) }, { statusCode: 200, body: { project: { name: 'root', root: '/test/root' }, generation: 'generation-a', roots: [], nodes: [], edges: [], depth: 3, truncated: false } })
})

test('E2E: visualizer server serves complexity summaries without requesting CFG records', async () => {
  const queries = []
  const mockStreamQuery = async function* (_root, query) {
    queries.push(query)
    yield { generation: 'generation-a', owners: [{ ownerId: 1, symbolId: 'a', name: 'run', file: 'src/a.ts', cyclomatic: 6, nodeCount: 9 }], edges: [] }
  }
  const server = createVisualizerServer('/test/root', { streamQuery: mockStreamQuery })
  const res = await simulateRequest(server, '/complexity')
  assert.deepEqual({ statusCode: res.statusCode, hasHistogram: Object.hasOwn(JSON.parse(res.body), 'histogram'), functionCount: JSON.parse(res.body).functions.length, queries }, { statusCode: 200, hasHistogram: false, functionCount: 1, queries: [{ type: 'internal-summaries', metricsOnly: true, includeTests: false, generation: undefined }] })
})

test('E2E: complexity endpoint passes requested viewport dimensions into the responsive grid', async () => {
  const mockStreamQuery = async function* () { yield { generation: 'generation-a', owners: Array.from({ length: 200 }, (_, index) => ({ ownerId: index, symbolId: `function-${index}`, name: `function${index}`, file: 'src/dense.ts', start: index, cyclomatic: 2 })), edges: [] } }
  const server = createVisualizerServer('/test/root', { streamQuery: mockStreamQuery })
  const res = await simulateRequest(server, '/complexity?width=1200&height=600')
  const invalid = await simulateRequest(server, '/complexity?width=1200.5&height=600')
  const data = JSON.parse(res.body)
  const last = data.functions[199]
  assert.deepEqual({ statusCode: res.statusCode, rows: data.rows, columns: data.columns, gridHeight: last.y + last.height, fractionalStatus: invalid.statusCode }, { statusCode: 200, rows: 10, columns: 20, gridHeight: 598, fractionalStatus: 400 })
})

test('E2E: visualizer server scopes internal detail to one file and owner', async () => {
  const queries = []
  const mockStreamQuery = async function* (_root, query) { queries.push(query); yield { record: 'owner', owner: { id: 2 } } }
  const server = createVisualizerServer('/test/root', { streamQuery: mockStreamQuery })
  const res = await simulateRequest(server, '/internals?file=src/a.ts&ownerId=2&generation=g1')
  assert.deepEqual({ statusCode: res.statusCode, records: JSON.parse(res.body).records.length, query: queries[0] }, { statusCode: 200, records: 1, query: { type: 'internals', operation: 'map', file: 'src/a.ts', owner: { id: 2 }, generation: 'g1', view: 'combined', limit: 2000 } })
})

test("E2E: complexity inspector presents the requested fields in drill-down reading order", async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const inspector = res.body.slice(res.body.indexOf('function selectSummaryItem('), res.body.indexOf('canvas.addEventListener("click"'))
  const labels = [...inspector.matchAll(/textContent\s*=\s*["'](Filename|Function name:line|Cyclomatic|Nesting|Branching|What's in there|For loops|Function calls)["']/g)].map(([, label]) => label)
  assert.deepEqual(labels, ['Filename', 'Function name:line', 'Cyclomatic', 'Nesting', 'Branching', "What's in there", 'For loops', 'Function calls'])
})

test('E2E: complexity inspector counts only flagged for-family nodes and semantic call relations', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const inspector = res.body.slice(res.body.indexOf('function selectSummaryItem('), res.body.indexOf('canvas.addEventListener("click"'))
  assert.deepEqual({
    flaggedForLoops: /record\.record\s*===\s*["']node["'][\s\S]*?record\.node\.flags\s*&\s*1/.test(inspector),
    callRelations: /record\.record\s*===\s*["']relation["'][\s\S]*?record\.relation\.kind\s*===\s*["']call["']/.test(inspector),
  }, { flaggedForLoops: true, callRelations: true })
})

test('E2E: complexity inspector does not render the miniature control-flow graph', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const inspector = res.body.slice(res.body.indexOf('function selectSummaryItem('), res.body.indexOf('canvas.addEventListener("click"'))
  assert.doesNotMatch(inspector, /Control flow graph|createElementNS\([^\n]+["'](?:line|circle)["']\)/)
})

test('E2E: 320-pixel Complexity inspector contains its ordered metric and contents grids', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const inspector = res.body.slice(res.body.indexOf('function selectSummaryItem('), res.body.indexOf('canvas.addEventListener("click"'))
  assert.deepEqual({
    fixedSidebar: /\.sidebar\s*\{[^}]*flex:\s*0\s+0\s+320px[^}]*overflow-x:\s*hidden/.test(res.body),
    containedDetails: /#selection-details\s*\{[^}]*flex-direction:\s*column[^}]*gap:\s*[^;]+;[^}]*min-width:\s*0/.test(res.body),
    fixedTextControl: /className\s*=\s*["']ctrl-btn["']/.test(inspector),
    scalarMetricGrid: /grid-template-columns:\s*repeat\(3,\s*1fr\)/.test(res.body) && /append\([^)]*cyclomatic[^)]*nesting[^)]*branching/.test(inspector),
    contentsGrid: /grid-template-columns:\s*repeat\(2,\s*1fr\)/.test(res.body) && /append\([^)]*loopCount[^)]*callCount/.test(inspector),
    calledFunctionsHeading: /Called functions[^\n]*calls\.length|calls\.length[^\n]*Called functions/.test(inspector),
    safeValueWrapping: /\.node-detail-val\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*normal/.test(res.body),
  }, { fixedSidebar: true, containedDetails: true, fixedTextControl: false, scalarMetricGrid: true, contentsGrid: true, calledFunctionsHeading: true, safeValueWrapping: true })
})

test('E2E: Complexity inspector call navigation handles long resolved unavailable and empty states', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const inspector = res.body.slice(res.body.indexOf('function selectSummaryItem('), res.body.indexOf('canvas.addEventListener("click"'))
  assert.deepEqual({
    contextualBack: /back\.textContent[^\n]*(?:previous|selectionHistory)[^\n]*(?:\.name|name)[^\n]*(?:\.line|line)/.test(inspector),
    resolvedLongNames: /button\.className\s*=\s*["'][^"']*sidebar-item-link[^"']+[^"']*["']/.test(inspector) && /\.sidebar-item-link\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*(?:overflow-wrap|white-space)/.test(res.body),
    stackedCallButton: /\.[\w-]*call[\w-]*\s*\{[^}]*flex-direction:\s*column[^}]*align-items:\s*flex-start/.test(res.body),
    keyboardFocus: /\.sidebar-item-link:focus-visible\s*\{/.test(res.body),
    unavailableTarget: /createElement\(["']span["']\)[\s\S]*className\s*=\s*["'][^"']*(?:muted|unavailable)[^"']*["'][\s\S]*\.title\s*=/.test(inspector) && /text-overflow:\s*ellipsis/.test(res.body),
    emptyCalls: /No internal function calls/.test(inspector),
    navigationOrder: /appendChild\(back\)[\s\S]*appendChild\(calledHeading\)[\s\S]*for\s*\(const call of calls\)/.test(inspector),
  }, { contextualBack: true, resolvedLongNames: true, stackedCallButton: true, keyboardFocus: true, unavailableTarget: true, emptyCalls: true, navigationOrder: true })
})

test('E2E: complexity inspector call targets drill down and Back drills up through selection history', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const inspector = res.body.slice(res.body.indexOf('function selectSummaryItem('), res.body.indexOf('canvas.addEventListener("click"'))
  assert.deepEqual({
    keepsHistory: /(?:inspection|selection)(?:History|Stack)/.test(res.body),
    rendersContextualBack: /back\.textContent[^\n]*← Back to[^\n]*previous\.name[^\n]*previous\.line/.test(inspector),
    popsHistory: /back\.onclick[^\n]*selectionHistory\.pop\(\)/.test(inspector),
    reloadsPrevious: /selectSummaryItem\(previous\.item,\s*previous\.mode,\s*false\)/.test(inspector),
    resolvesCallTarget: /targetSymbolId/.test(inspector) && /symbolId/.test(inspector),
    drillsToTarget: /selectSummaryItem\([^)]*(?:target|callee)/.test(inspector),
  }, { keepsHistory: true, rendersContextualBack: true, popsHistory: true, reloadsPrevious: true, resolvesCallTarget: true, drillsToTarget: true })
})

test('E2E: a fresh heatmap click resets drill history before selecting the new function', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const renderer = res.body.slice(res.body.indexOf('function renderComplexity()'), res.body.indexOf('function loadSunburst'))
  assert.match(renderer, /click[\s\S]*?(?:inspection|selection)(?:History|Stack)\.length\s*=\s*0[\s\S]*?selectSummaryItem/)
})

test('error guessing: a late internal-map response cannot replace a newer inspector selection', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const inspector = res.body.slice(res.body.indexOf('function selectSummaryItem('), res.body.indexOf('canvas.addEventListener("click"'))
  assert.deepEqual({
    advancesRequestIdentity: /(?:request|selection)(?:Id|Token|Version)\s*\+\+/.test(inspector),
    rejectsStaleResponse: /if\s*\([^)]*(?:request|selection)(?:Id|Token|Version)[^)]*(?:!==|!=)[^)]*\)\s*return/.test(inspector),
  }, { advancesRequestIdentity: true, rejectsStaleResponse: true })
})

test('E2E: Sunburst does not render the project root label inside its SVG', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const renderer = res.body.slice(res.body.indexOf('function renderSunburst()'), res.body.indexOf('function selectSunburstNode('))
  assert.doesNotMatch(renderer, /rootText|sunburstData\.project\?\.name/)
})

test('E2E: selecting a Sunburst zone activates every matching descendant and keeps the active branch clickable', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const selection = res.body.slice(res.body.indexOf('function selectSunburstNode('), res.body.indexOf('function renderChord()'))
  assert.deepEqual({
    activatesMatchingNodes: /nodes(?:\.filter\([^)]*isNodeInSelectedZone|[\s\S]*for\s*\([^)]*nodes[^)]*\)[\s\S]*isNodeInSelectedZone)[\s\S]*active-branch/.test(selection),
    activeBranchIsClickable: /\.sunburst-arc\.active-branch\s*\{[^}]*pointer-events:\s*auto\s*!important/.test(res.body),
  }, { activatesMatchingNodes: true, activeBranchIsClickable: true })
})

test('E2E: Sunburst selection overlay follows the selected inner radius and widest in-zone descendant', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const selection = res.body.slice(res.body.indexOf('function selectSunburstNode('), res.body.indexOf('function renderChord()'))
  assert.deepEqual({
    selectedInnerRadius: /\br0\s*=\s*node\.r0\b/.test(selection),
    widestInZoneRadius: /isNodeInSelectedZone\(node\s*,\s*\w+\)[\s\S]*Math\.max[\s\S]*\.r1|Math\.max[\s\S]*isNodeInSelectedZone\(node\s*,\s*\w+\)[\s\S]*\.r1/.test(selection),
    usesSelectedAnglesWithHelper: /describeArc\([^;]*\br0\b[^;]*\br1\b[^;]*node\.a0[^;]*node\.a1/.test(selection),
    hardCodedRadii: /\br0\s*=\s*\([^;]*95\)|\br1\s*=\s*425\b/.test(selection),
    duplicatesArcMath: /Math\.(?:cos|sin)|\blargeArc\b/.test(selection),
  }, { selectedInnerRadius: true, widestInZoneRadius: true, usesSelectedAnglesWithHelper: true, hardCodedRadii: false, duplicatesArcMath: false })
})

test('E2E: Call Tree and Complexity loaders publish project identity in the shared header and document title', async () => {
  const server = createVisualizerServer('/test/root')
  const res = await simulateRequest(server, '/')
  const helper = res.body.slice(res.body.indexOf('function showProject('), res.body.indexOf('function loadCalltree('))
  const calltree = res.body.slice(res.body.indexOf('function loadCalltree('), res.body.indexOf('function loadComplexity('))
  const complexity = res.body.slice(res.body.indexOf('function loadComplexity('), res.body.indexOf('function renderSummaryCards('))
  assert.deepEqual({
    helper: /project-name[\s\S]*project-path[\s\S]*project-pill[\s\S]*document\.title/.test(helper),
    calltree: /showProject\(data\.project\s*,/.test(calltree),
    complexity: /showProject\(data\.project\s*,/.test(complexity),
  }, { helper: true, calltree: true, complexity: true })
})

for (const depth of ['0', '7', 'many', '1.5', 'null']) test(`boundary analysis: calltree rejects depth ${depth}`, async () => {
  const server = createVisualizerServer('/test/root', { streamQuery: async function* () {} })
  const res = await simulateRequest(server, `/calltree?depth=${depth}`)
  assert.deepEqual({ statusCode: res.statusCode, mentionsDepth: /depth/i.test(res.body) }, { statusCode: 400, mentionsDepth: true })
})

test('error guessing: internals rejects a path outside the canonical repository root', async () => {
  const server = createVisualizerServer('/test/root', { streamQuery: async function* () {} })
  const res = await simulateRequest(server, '/internals?file=../outside.ts&ownerId=0&generation=g1')
  assert.deepEqual({ statusCode: res.statusCode, mentionsPath: /path|root|outside/i.test(res.body) }, { statusCode: 400, mentionsPath: true })
})

test('coverage: visualizer summary routes preserve flattened rows and report query failures', async () => {
  const flattened = async function* (_root, query) {
    if (query.type === 'internal-summaries') {
      yield { record: 'summary', summary: { ownerId: 1, symbolId: 'a', name: 'run', file: 'src/a.ts', cyclomatic: 2 }, validatedGeneration: 'g1', roots: ['a'], truncated: true }
      yield { record: 'edge', edge: { from: 'a', to: 'a' } }
    }
  }
  const working = createVisualizerServer('/test/root', { streamQuery: flattened })
  const calltree = await simulateRequest(working, '/calltree?root=a&depth=1&includeTests=1&generation=g1')
  assert.deepEqual({ statusCode: calltree.statusCode, generation: JSON.parse(calltree.body).generation, truncated: JSON.parse(calltree.body).truncated }, { statusCode: 200, generation: 'g1', truncated: true })

  const failing = createVisualizerServer('/test/root', { streamQuery: async function* () { throw new Error('query failed') } })
  for (const route of ['/graph', '/heatmap', '/sunburst', '/chord', '/calltree', '/complexity', '/internals?file=src/a.ts&ownerId=1']) {
    const response = await simulateRequest(failing, route)
    assert.deepEqual({ route, statusCode: response.statusCode, error: JSON.parse(response.body).error }, { route, statusCode: 500, error: 'query failed' })
  }
})

for (const route of ['/internals', '/internals?file=src/a.ts', '/internals?file=/absolute.ts&ownerId=1', '/internals?file=src/a.ts&ownerId=-1']) test(`boundary analysis: rejects malformed scoped detail ${route}`, async () => {
  const server = createVisualizerServer('/test/root', { streamQuery: async function* () {} })
  const response = await simulateRequest(server, route)
  assert.equal(response.statusCode, 400)
})

test('coverage: injected watcher drives filtering, debounce, broadcast, and SSE cleanup without OS file descriptors', async () => {
  let onWatch = null
  const watcher = new EventEmitter()
  watcher.close = async () => {}
  const server = createVisualizerServer('/repo', { watch: (_root, _options, callback) => { onWatch = callback; return watcher }, debounceMs: 1, ssePingMs: 1 })
  const req = new EventEmitter()
  req.url = '/events'; req.method = 'GET'; req.headers = { host: '127.0.0.1' }
  const writes = []
  const res = new EventEmitter()
  res.writableEnded = false
  res.writeHead = () => {}
  res.write = (chunk) => { writes.push(chunk); return true }
  server.emit('request', req, res)
  for (const ignored of [null, 'node_modules/a.ts', '.git/a.ts', 'dist/a.ts', 'build/a.ts', 'coverage/a.ts', '.codegraph/generations/a', '.codegraph/partitions/a', '.codegraph/overlays/a', 'a.tmp', 'a.tmp.1', 'query-view-cache-v2.bin', 'README.md']) onWatch('change', ignored)
  onWatch('change', 'src/a.ts')
  onWatch('change', '.codegraph/CURRENT')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(writes.some(chunk => chunk.includes('indexing')))
  assert.ok(writes.some(chunk => chunk.includes('ready')))
  assert.ok(writes.some(chunk => chunk.includes('ping')))
  res.write = () => { throw new Error('closed') }
  onWatch('change', 'src/b.mjs')
  req.emit('close')
  await watcher.close()
})

test('coverage: exported visualizer main wires the server to its listener', async () => {
  const watcher = new EventEmitter(); watcher.close = async () => {}
  const server = startVisualizer('/repo', 0, { watch: () => watcher, listen: (target, requestedPort, host, ready) => { assert.deepEqual({ requestedPort, host }, { requestedPort: 0, host: '127.0.0.1' }); target.address = () => ({ port: 7331 }); ready(); return target } })
  assert.equal(server.address().port, 7331)
  await watcher.close()
})
