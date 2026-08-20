import test from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { createVisualizerServer } from "../visualizer.mjs"
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

  // Extract embedded <script> tags and parse with vm.Script to ensure zero syntax errors
  const scriptMatch = res.body.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(scriptMatch, "Expected embedded client <script>")
  assert.doesNotThrow(() => {
    new vm.Script(scriptMatch[1])
  }, "Client JavaScript inside <script> must have valid syntax without errors")
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

