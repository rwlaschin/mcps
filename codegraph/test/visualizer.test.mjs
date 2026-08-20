import test from "node:test"
import assert from "node:assert/strict"
import { colorFor, heatColorFor, filterSymbols, buildLayeredGraph, buildHeatmapData, buildSunburstData, buildChordData, formatLocation, classifyArchitecturalTier } from "../visualizer-graph.mjs"

test("colorFor: rotates colors using HSV + prime stride, avoids black and white", () => {
  const generated = new Set()
  for (let i = 0; i < 50; i += 1) {
    const color = colorFor(i)
    assert.match(color, /^#[0-9a-f]{6}$/i)
    assert.notEqual(color.toLowerCase(), "#000000")
    assert.notEqual(color.toLowerCase(), "#ffffff")
    generated.add(color)
  }
  assert.ok(generated.size >= 45, "Expected at least 45 unique colors out of 50")
})

test("filterSymbols: strictly filters to callable functions, methods, classes, and components while excluding enums, interfaces, types, and constants", () => {
  const rawSymbols = [
    { id: "1", name: "getUserById", kind: "function", file: "src/api/user.ts", line: 10 },
    { id: "2", name: "{ id }", file: "src/api/user.ts", line: 10 },
    { id: "3", name: "[cmd, name]", file: "src/cli.ts", line: 15 },
    { id: "4", name: "{ data: plans = [] }", file: "src/plan.ts", line: 20 },
    { id: "5", name: "UserStore", kind: "class", file: "src/db/store.ts", line: 1 },
    { id: "6", name: "UserRole", kind: "enum", file: "src/types.ts", line: 5 },
    { id: "7", name: "IUserData", kind: "interface", file: "src/types.ts", line: 15 },
    { id: "8", name: "UserPayload", kind: "type", file: "src/types.ts", line: 25 },
    { id: "9", name: "MAX_RETRIES", file: "src/config.ts", line: 2 },
    { id: "10", name: "UserItem[]", file: "src/types.ts", line: 30 },
  ]
  const filtered = filterSymbols(rawSymbols)
  assert.equal(filtered.length, 2)
  assert.deepEqual(filtered.map((s) => s.name), ["getUserById", "UserStore"])
})

test("buildLayeredGraph: computes top-down execution layers and marks most called and orphans", () => {
  const rawGraph = {
    symbols: [
      { id: "controller", name: "handleRequest", file: "src/controller.ts", line: 1 },
      { id: "service", name: "processOrder", file: "src/service.ts", line: 1 },
      { id: "db", name: "saveToDatabase", file: "src/db.ts", line: 1 },
      { id: "orphan", name: "unusedHelper", file: "src/orphan.ts", line: 1 },
    ],
    edges: [
      { from: "controller", to: "service", call: true },
      { from: "service", to: "db", call: true },
    ],
  }

  const result = buildLayeredGraph(rawGraph)
  const nodeMap = new Map(result.nodes.map((n) => [n.id, n]))

  assert.ok(nodeMap.get("controller").layer < nodeMap.get("service").layer)
  assert.ok(nodeMap.get("service").layer < nodeMap.get("db").layer)
  assert.equal(nodeMap.get("orphan").isOrphan, true)
  assert.equal(nodeMap.get("controller").isOrphan, false)
  assert.equal(nodeMap.get("service").inDegree, 1)
  assert.equal(nodeMap.get("db").inDegree, 1)
  assert.equal(nodeMap.get("controller").inDegree, 0)
})

test("buildLayeredGraph: deduplicates multiple call edges between the same caller and callee", () => {
  const rawGraph = {
    symbols: [
      { id: "ui", name: "useDashboardSelection", file: "src/context/DashboardContext.tsx", line: 28 },
      { id: "hook", name: "useSelector", file: "src/hooks/useSelector.ts", line: 10 },
    ],
    edges: [
      { from: "ui", to: "hook", call: true, line: 30 },
      { from: "ui", to: "hook", call: true, line: 45 },
    ],
  }

  const result = buildLayeredGraph(rawGraph)
  assert.equal(result.edges.length, 1, "Duplicate call edges between identical nodes must be deduplicated to 1 edge")
  assert.equal(result.nodes.find((n) => n.id === "ui").outDegree, 1)
  assert.equal(result.nodes.find((n) => n.id === "hook").inDegree, 1)
})

test("formatLocation: cleanly truncates long file paths to fit card bounds", () => {
  const short = formatLocation("src/api/user.ts", 10)
  assert.equal(short, "user.ts:10")

  const long = formatLocation("scripts/clean-recipe-component-cut-prep.test.ts", 75)
  assert.equal(long, "clean-recipe-component-cut-prep.test.ts:75")
  assert.ok(long.length <= 45)
})

test("classifyArchitecturalTier: correctly categorizes Front End UI, UI Hooks, Client Requests, Backend API, Domain Services, and Persistence", () => {
  assert.equal(classifyArchitecturalTier("src/components/UserCard.tsx", "UserCard"), "ui")
  assert.equal(classifyArchitecturalTier("src/pages/dashboard.tsx", "DashboardPage"), "ui")
  assert.equal(classifyArchitecturalTier("src/hooks/useAuth.ts", "useAuth"), "hook")
  assert.equal(classifyArchitecturalTier("src/client/api/userRequest.ts", "fetchUser"), "request")
  assert.equal(classifyArchitecturalTier("src/routes/api/users.ts", "handleGetUsers"), "api")
  assert.equal(classifyArchitecturalTier("src/services/userService.ts", "processUser"), "service")
  assert.equal(classifyArchitecturalTier("src/db/userStore.ts", "saveUser"), "db")
})

test("buildLayeredGraph: assigns stratified architectural layers (UI -> Hook -> Request -> API -> Service -> DB)", () => {
  const rawGraph = {
    symbols: [
      { id: "ui", name: "UserPage", file: "src/pages/UserPage.tsx", line: 1 },
      { id: "hk", name: "useUserData", file: "src/hooks/useUser.ts", line: 5 },
      { id: "req", name: "fetchUserData", file: "src/client/api.ts", line: 10 },
      { id: "api", name: "getUserRoute", file: "src/routes/api/users.ts", line: 5 },
      { id: "srv", name: "getUserService", file: "src/services/user.ts", line: 12 },
      { id: "db", name: "findUserInDb", file: "src/db/repo.ts", line: 20 },
    ],
    edges: [
      { from: "ui", to: "hk", call: true },
      { from: "hk", to: "req", call: true },
      { from: "req", to: "api", call: true },
      { from: "api", to: "srv", call: true },
      { from: "srv", to: "db", call: true },
    ],
  }

  const result = buildLayeredGraph(rawGraph)
  const map = new Map(result.nodes.map(n => [n.id, n]))

  assert.equal(map.get("ui").tier, "ui")
  assert.equal(map.get("hk").tier, "hook")
  assert.equal(map.get("req").tier, "request")
  assert.equal(map.get("api").tier, "api")
  assert.equal(map.get("db").tier, "db")

  // Layer ordering: UI (0) -> Hook (1) -> Request (2) -> API (3) -> Service (4) -> DB (5)
  assert.ok(map.get("ui").layer < map.get("hk").layer)
  assert.ok(map.get("hk").layer < map.get("req").layer)
  assert.ok(map.get("req").layer < map.get("api").layer)
  assert.ok(map.get("api").layer < map.get("srv").layer)
  assert.ok(map.get("srv").layer < map.get("db").layer)
})

test("buildLayeredGraph: executes efficiently for large graphs (1000 nodes with cycles) - O(V+E)", () => {
  const symbols = []
  const edges = []
  const count = 1000

  for (let i = 0; i < count; i++) {
    symbols.push({
      id: `sym-${i}`,
      name: `func_${i}`,
      file: i % 5 === 0 ? `src/components/Comp${i}.tsx` :
            i % 5 === 1 ? `src/client/api_${i}.ts` :
            i % 5 === 2 ? `src/routes/api_${i}.ts` :
            i % 5 === 3 ? `src/services/srv_${i}.ts` : `src/db/store_${i}.ts`,
      line: i + 1,
    })
    if (i > 0) {
      edges.push({ from: `sym-${i - 1}`, to: `sym-${i}`, call: true })
    }
    // Add periodic cycle edges
    if (i % 20 === 0 && i > 20) {
      edges.push({ from: `sym-${i}`, to: `sym-${i - 20}`, call: true })
    }
  }

  // Warm up V8 JIT
  buildLayeredGraph({ symbols: symbols.slice(0, 50), edges: edges.slice(0, 50) })

  const start = performance.now()
  const result = buildLayeredGraph({ symbols, edges })
  const elapsed = performance.now() - start

  assert.equal(result.nodes.length, count)
  assert.ok(elapsed < 2000, `buildLayeredGraph took ${elapsed.toFixed(2)}ms, expected < 2000ms`)
})

test("heatColorFor: generates HSV heat spectrum from cool cyan to hot red without black or white", () => {
  const cool = heatColorFor(0.0)
  const warm = heatColorFor(0.5)
  const hot = heatColorFor(1.0)

  assert.match(cool, /^#[0-9a-f]{6}$/i)
  assert.match(warm, /^#[0-9a-f]{6}$/i)
  assert.match(hot, /^#[0-9a-f]{6}$/i)

  assert.notEqual(cool, "#000000")
  assert.notEqual(cool, "#ffffff")
  assert.notEqual(hot, "#000000")
  assert.notEqual(hot, "#ffffff")
  assert.notEqual(cool, hot)
})

test("buildHeatmapData: aggregates modules and files with call density metrics and layout bounds", () => {
  const rawGraph = {
    symbols: [
      { id: "s1", name: "renderApp", file: "src/ui/App.tsx", line: 1 },
      { id: "s2", name: "Button", file: "src/ui/Button.tsx", line: 5 },
      { id: "s3", name: "fetchUsers", file: "src/api/users.ts", line: 10 },
      { id: "s4", name: "dbQuery", file: "src/db/client.ts", line: 20 },
      { id: "s5", name: "orphanFunc", file: "src/util/orphan.ts", line: 1 },
    ],
    edges: [
      { from: "s1", to: "s3", call: true },
      { from: "s2", to: "s3", call: true },
      { from: "s3", to: "s4", call: true },
      { from: "s1", to: "s4", call: true },
    ]
  }

  const result = buildHeatmapData(rawGraph, { width: 1000, height: 600 })
  assert.ok(Array.isArray(result.modules))
  assert.ok(result.modules.length > 0)
  assert.ok(Array.isArray(result.files))
  assert.equal(result.files.length, 5)

  const usersFile = result.files.find(f => f.file === "src/api/users.ts")
  const orphanFile = result.files.find(f => f.file === "src/util/orphan.ts")

  assert.ok(usersFile)
  assert.ok(orphanFile)
  assert.equal(usersFile.totalInCalls, 2) // Called by s1 and s2
  assert.equal(orphanFile.totalInCalls, 0)
  assert.ok(usersFile.heat > orphanFile.heat)

  // Verify bounding boxes
  for (const f of result.files) {
    assert.ok(typeof f.x === "number" && f.x >= 0)
    assert.ok(typeof f.y === "number" && f.y >= 0)
    assert.ok(typeof f.width === "number" && f.width > 0)
    assert.ok(typeof f.height === "number" && f.height > 0)
    assert.match(f.color, /^#[0-9a-f]{6}$/i)
  }
})

test("buildSunburstData: builds hierarchical radial multi-tier partition arcs with valid geometry and colors", () => {
  const rawGraph = {
    symbols: [
      { id: "s1", name: "renderApp", file: "src/ui/App.tsx", line: 1 },
      { id: "s2", name: "Button", file: "src/ui/Button.tsx", line: 5 },
      { id: "s3", name: "fetchUsers", file: "src/api/users.ts", line: 10 },
      { id: "s4", name: "dbQuery", file: "src/db/client.ts", line: 20 },
    ],
    edges: [
      { from: "s1", to: "s3", call: true },
      { from: "s2", to: "s3", call: true },
      { from: "s3", to: "s4", call: true },
    ]
  }

  const data = buildSunburstData(rawGraph, { radius: 400 })
  assert.ok(Array.isArray(data.nodes))
  assert.ok(data.nodes.length >= 4)
  assert.ok(data.maxDepth >= 2)

  for (const node of data.nodes) {
    assert.ok(typeof node.name === "string")
    assert.ok(typeof node.depth === "number")
    assert.ok(node.r0 >= 0 && node.r1 > node.r0)
    assert.ok(node.a0 >= 0 && node.a1 >= node.a0)
    assert.ok(typeof node.d === "string" && node.d.startsWith("M"))
    assert.match(node.color, /^#[0-9a-f]{6}$/i)
  }
})

test("buildChordData: builds circular interconnect matrix with outer arcs and inner flow ribbons", () => {
  const rawGraph = {
    symbols: [
      { id: "s1", name: "renderApp", file: "src/ui/App.tsx", line: 1 },
      { id: "s2", name: "Button", file: "src/ui/Button.tsx", line: 5 },
      { id: "s3", name: "fetchUsers", file: "src/api/users.ts", line: 10 },
      { id: "s4", name: "dbQuery", file: "src/db/client.ts", line: 20 },
    ],
    edges: [
      { from: "s1", to: "s3", call: true },
      { from: "s2", to: "s3", call: true },
      { from: "s3", to: "s4", call: true },
    ]
  }

  const data = buildChordData(rawGraph, { radius: 350 })
  assert.ok(Array.isArray(data.modules))
  assert.ok(data.modules.length >= 3)
  assert.ok(Array.isArray(data.chords))
  assert.ok(data.chords.length >= 2)

  for (const mod of data.modules) {
    assert.ok(typeof mod.name === "string")
    assert.ok(mod.a0 >= 0 && mod.a1 > mod.a0)
    assert.ok(typeof mod.d === "string" && mod.d.startsWith("M"))
    assert.match(mod.color, /^#[0-9a-f]{6}$/i)
  }

  for (const chord of data.chords) {
    assert.ok(chord.source && chord.target)
    assert.ok(chord.calls >= 1)
    assert.ok(typeof chord.d === "string" && chord.d.startsWith("M"))
    assert.match(chord.color, /^#[0-9a-f]{6}$/i)
  }
})
