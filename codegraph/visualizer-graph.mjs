// Precomputed 360-color HSV palette for instant O(1) lookup
const COLOR_PALETTE = (() => {
  const palette = new Array(360)
  const sat = 0.72
  const val = 0.85
  const c = val * sat
  const m = val - c
  for (let hue = 0; hue < 360; hue++) {
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
    let r = 0, g = 0, b = 0
    if (hue < 60) { r = c; g = x }
    else if (hue < 120) { r = x; g = c }
    else if (hue < 180) { g = c; b = x }
    else if (hue < 240) { g = x; b = c }
    else if (hue < 300) { r = x; b = c }
    else { r = c; b = x }
    const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0")
    palette[hue] = "#" + toHex(r) + toHex(g) + toHex(b)
  }
  return palette
})()

export const colorFor = (index) => {
  const hue = ((index * 47) % 360 + 360) % 360
  return COLOR_PALETTE[hue]
}

export const heatColorFor = (heatRatio = 0) => {
  const clamped = Math.max(0, Math.min(1, heatRatio))
  if (clamped === 0) return "#1e293b"

  const t = Math.pow(clamped, 0.75)
  const hue = Math.round(200 - t * 195)
  const sat = 0.58 + t * 0.12
  const val = 0.48 + t * 0.22
  const c = val * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = val - c
  let r = 0, g = 0, b = 0
  if (hue < 60) { r = c; g = x }
  else if (hue < 120) { r = x; g = c }
  else if (hue < 180) { g = c; b = x }
  else if (hue < 240) { g = x; b = c }
  else if (hue < 300) { r = x; b = c }
  else { r = c; b = x }
  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0")
  return "#" + toHex(r) + toHex(g) + toHex(b)
}

export const getContrastText = (hexColor = "#1e293b") => {
  const hex = hexColor.replace("#", "")
  const r = parseInt(hex.substring(0, 2), 16) || 0
  const g = parseInt(hex.substring(2, 4), 16) || 0
  const b = parseInt(hex.substring(4, 6), 16) || 0
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  return lum > 135 ? "#090d16" : "#f8fafc"
}

export const formatLocation = (file = "", line = 0) => {
  const parts = file.split("/")
  const base = parts[parts.length - 1] || file
  return `${base}:${line}`
}

export const isTestFile = (filePath = "") => {
  const lower = filePath.toLowerCase()
  return (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.startsWith("test/") ||
    lower.includes("/test/") ||
    lower.startsWith("__tests__/") ||
    lower.includes("/__tests__/")
  )
}

const EXCLUDED_KINDS = new Set(["enum", "interface", "type"])

export const filterSymbols = (symbols, options = {}) => {
  const includeTests = options.includeTests ?? false
  if (!Array.isArray(symbols)) return []
  const res = []
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]
    if (!s || !s.name || typeof s.name !== "string") continue

    // 1. Exclude Enums, Interfaces, Types
    if (s.kind && EXCLUDED_KINDS.has(s.kind)) continue

    const name = s.name.trim()
    if (!name) continue

    // 2. Exclude Destructuring, Objects, Arrays, Array types (e.g. { a, b }, [x, y], Object[], Array[])
    if (
      name.startsWith("{") ||
      name.startsWith("[") ||
      name.endsWith("[]") ||
      name.includes("{") ||
      name.includes("}") ||
      name.includes("[]") ||
      name.startsWith("Object[") ||
      name.startsWith("Array[")
    ) {
      continue
    }

    // 3. Exclude Constants and uppercase enum values
    if (/^[A-Z0-9_]{2,}$/.test(name)) continue

    // 4. Exclude Test files unless requested
    if (!includeTests && s.file && isTestFile(s.file)) continue

    res.push(s)
  }
  return res
}

export const classifyRegion = (filePath = "", symbolName = "") => {
  const p = (filePath || "").toLowerCase().replace(/\\/g, "/")
  const name = (symbolName || "").toLowerCase()
  if (
    p.endsWith(".tsx") ||
    p.endsWith(".jsx") ||
    p.endsWith(".vue") ||
    p.endsWith(".svelte") ||
    p.includes("/components/") ||
    p.includes("/pages/") ||
    p.includes("/views/") ||
    p.includes("/ui/") ||
    p.includes("/screens/") ||
    p.includes("/hooks/") ||
    p.includes("/context/") ||
    p.includes("/contexts/") ||
    p.includes("/styles/") ||
    p.includes("/theme/") ||
    p.includes("/frontend/") ||
    p.includes("/client/") ||
    name.startsWith("use") ||
    name.endsWith("hook") ||
    name.endsWith("component") ||
    name.endsWith("screen") ||
    name.endsWith("view")
  ) {
    return "frontend"
  }
  return "backend"
}

export const classifyArchitecturalTier = (filePath = "", symbolName = "") => {
  if (!filePath && !symbolName) return "service"
  const p = filePath.toLowerCase().replace(/\\/g, "/")
  const name = (symbolName || "").toLowerCase()

  // 1. Hooks & Client State (use[A-Z]*, /hooks/, /context/, /contexts/, state stores)
  const isHookName = /^use[A-Z0-9_]/.test(symbolName || "") || name.endsWith("hook") || name.endsWith("context")
  if (
    isHookName ||
    p.includes("/hooks/") ||
    p.includes("/context/") ||
    p.includes("/contexts/") ||
    p.includes("/client/hooks") ||
    p.includes("/stores/") ||
    p.endsWith(".hook.ts") ||
    p.endsWith(".hook.js")
  ) {
    return "hook"
  }

  // 2. Pure UI Presentation Surface (Components, Pages, Screens, Views, Layouts)
  if (
    p.endsWith(".tsx") ||
    p.endsWith(".jsx") ||
    p.endsWith(".vue") ||
    p.endsWith(".svelte") ||
    p.includes("/components/") ||
    p.includes("/pages/") ||
    p.includes("/views/") ||
    p.includes("/ui/") ||
    p.includes("/screens/") ||
    p.includes("/layouts/") ||
    p.includes("/frontend/") ||
    p.includes("/client/components") ||
    p.includes("/client/ui") ||
    name.endsWith("component") ||
    name.endsWith("screen") ||
    name.endsWith("view") ||
    name.endsWith("page")
  ) {
    if (p.includes("/client/api") || p.includes("/requests/") || p.includes("/queries/")) {
      return "request"
    }
    return "ui"
  }

  // 3. Request / Client Network Boundary (Data fetching from client to backend)
  if (
    p.includes("/client/api") ||
    p.includes("/requests/") ||
    p.includes("/queries/") ||
    p.includes("/mutations/") ||
    p.includes("/fetchers/") ||
    p.endsWith(".client.ts") ||
    name.endsWith("query") ||
    name.endsWith("mutation") ||
    name.startsWith("fetch")
  ) {
    return "request"
  }

  // 4. API & Controllers / Backend Entry (Route handlers, REST/RPC endpoints, HTTP controllers)
  if (
    p.includes("/routes/") ||
    p.includes("/controllers/") ||
    p.includes("/api/") ||
    p.includes("/handlers/") ||
    p.includes("/endpoints/") ||
    p.endsWith(".route.ts") ||
    p.endsWith(".controller.ts")
  ) {
    return "api"
  }

  // 5. Persistence & Database / Store Layer
  if (
    p.includes("/db/") ||
    p.includes("/store/") ||
    p.includes("/repository/") ||
    p.includes("/repositories/") ||
    p.includes("/models/") ||
    p.includes("/prisma/") ||
    p.includes("/schemas/") ||
    p.endsWith(".model.ts") ||
    p.endsWith(".repo.ts") ||
    p.endsWith(".repository.ts")
  ) {
    return "db"
  }

  // 6. Domain & Business Services
  return "service"
}

export const TIER_LAYER_OFFSET = {
  ui: 0,
  hook: 1,
  request: 2,
  api: 3,
  service: 4,
  db: 5,
}

export const buildLayeredGraph = (rawGraph, options = {}) => {
  const rawSymbols = Array.isArray(rawGraph?.symbols) ? rawGraph.symbols : []
  const rawEdges = Array.isArray(rawGraph?.edges) ? rawGraph.edges : []

  const validSymbols = filterSymbols(rawSymbols, options)
  const count = validSymbols.length
  if (count === 0) return { nodes: [], edges: [] }

  const idToIdx = new Map()
  const tierArr = new Array(count)
  const regionArr = new Array(count)
  for (let i = 0; i < count; i++) {
    const s = validSymbols[i]
    idToIdx.set(s.id, i)
    tierArr[i] = classifyArchitecturalTier(s.file, s.name)
    regionArr[i] = classifyRegion(s.file, s.name)
  }

  const inDegArr = new Int32Array(count)
  const outDegArr = new Int32Array(count)
  const layerArr = new Int32Array(count)
  const visitedArr = new Uint8Array(count)
  const adj = Array.from({ length: count }, () => [])

  const validEdges = []
  const edgeSet = new Set()
  for (let i = 0; i < rawEdges.length; i++) {
    const e = rawEdges[i]
    if (e && idToIdx.has(e.from) && idToIdx.has(e.to)) {
      const u = idToIdx.get(e.from)
      const v = idToIdx.get(e.to)
      const edgeKey = u * 1000000 + v
      if (edgeSet.has(edgeKey)) continue
      edgeSet.add(edgeKey)

      validEdges.push(e)
      outDegArr[u]++
      inDegArr[v]++
      adj[u].push(v)
    }
  }

  // Linear O(V + E) Topological Longest Path Layering
  const remainingInDeg = new Int32Array(inDegArr)
  const queue = new Int32Array(count)
  let head = 0
  let tail = 0

  for (let i = 0; i < count; i++) {
    if (remainingInDeg[i] === 0) {
      visitedArr[i] = 1
      queue[tail++] = i
    }
  }

  let unvisitedIdx = 0
  let visitedCount = tail
  while (visitedCount < count) {
    if (head >= tail) {
      while (unvisitedIdx < count && visitedArr[unvisitedIdx] === 1) {
        unvisitedIdx++
      }
      if (unvisitedIdx < count) {
        visitedArr[unvisitedIdx] = 1
        visitedCount++
        queue[tail++] = unvisitedIdx
      } else {
        break
      }
    }

    const u = queue[head++]
    const currLayer = layerArr[u]
    const neighbors = adj[u]
    const len = neighbors.length
    for (let i = 0; i < len; i++) {
      const v = neighbors[i]
      if (currLayer + 1 > layerArr[v]) {
        layerArr[v] = currLayer + 1
      }
      remainingInDeg[v]--
      if (remainingInDeg[v] <= 0 && visitedArr[v] === 0) {
        visitedArr[v] = 1
        visitedCount++
        queue[tail++] = v
      }
    }
  }

  const inDegreeValues = []
  for (let i = 0; i < count; i++) {
    if (inDegArr[i] > 0) inDegreeValues.push(inDegArr[i])
  }
  inDegreeValues.sort((a, b) => b - a)
  const top10Threshold = inDegreeValues.length > 0 ? inDegreeValues[Math.max(0, Math.floor(inDegreeValues.length * 0.1))] : 2

  const nodes = new Array(count)
  for (let i = 0; i < count; i++) {
    const sym = validSymbols[i]
    const inDeg = inDegArr[i]
    const outDeg = outDegArr[i]
    nodes[i] = {
      ...sym,
      region: regionArr[i],
      layer: layerArr[i],
      tier: tierArr[i],
      inDegree: inDeg,
      outDegree: outDeg,
      connections: inDeg + outDeg,
      isOrphan: inDeg === 0 && outDeg === 0,
      isMostCalled: inDeg > 0 && inDeg >= top10Threshold,
      color: COLOR_PALETTE[((i * 47) % 360 + 360) % 360],
    }
  }

  const edges = new Array(validEdges.length)
  for (let i = 0; i < validEdges.length; i++) {
    const edge = validEdges[i]
    const u = idToIdx.get(edge.from)
    const v = idToIdx.get(edge.to)
    const fromLayer = nodes[u].layer
    const toLayer = nodes[v].layer
    edges[i] = {
      ...edge,
      fromLayer,
      toLayer,
      isViolation: toLayer <= fromLayer,
    }
  }

  return { nodes, edges }
}

export const buildHeatmapData = (rawGraph, options = {}) => {
  const width = options.width || 1400
  const padding = 16

  const rawSymbols = Array.isArray(rawGraph?.symbols) ? rawGraph.symbols : []
  const rawEdges = Array.isArray(rawGraph?.edges) ? rawGraph.edges : []

  const validSymbols = filterSymbols(rawSymbols, options)
  const validIds = new Set(validSymbols.map((s) => s.id))
  const validEdges = rawEdges.filter((e) => e && validIds.has(e.from) && validIds.has(e.to))

  // Detect architectural violations
  const TIER_ORDER_VAL = {
    ui: 1,
    hook: 2,
    request: 3,
    api: 4,
    service: 5,
    db: 6,
    backend: 5,
  }

  const symMap = new Map()
  const symTiers = new Map()
  for (let i = 0; i < validSymbols.length; i++) {
    const s = validSymbols[i]
    symMap.set(s.id, s)
    symTiers.set(s.id, TIER_ORDER_VAL[classifyArchitecturalTier(s.file, s.name)] ?? 3)
  }

  const violationFiles = new Set()
  const violationModules = new Set()
  for (let i = 0; i < validEdges.length; i++) {
    const e = validEdges[i]
    if (e && symTiers.has(e.from) && symTiers.has(e.to)) {
      const fromTier = symTiers.get(e.from)
      const toTier = symTiers.get(e.to)
      if (fromTier > toTier) {
        const sFrom = symMap.get(e.from)
        const sTo = symMap.get(e.to)
        if (sFrom?.file) {
          violationFiles.add(sFrom.file)
          const mod = sFrom.file.split("/").slice(0, -1).join("/") || "root"
          violationModules.add(mod)
        }
        if (sTo?.file) {
          violationFiles.add(sTo.file)
          const mod = sTo.file.split("/").slice(0, -1).join("/") || "root"
          violationModules.add(mod)
        }
      }
    }
  }

  // Calculate in/out degrees per symbol
  const symbolInDegree = new Map()
  const symbolOutDegree = new Map()
  for (let i = 0; i < validSymbols.length; i++) {
    symbolInDegree.set(validSymbols[i].id, 0)
    symbolOutDegree.set(validSymbols[i].id, 0)
  }
  for (let i = 0; i < validEdges.length; i++) {
    const e = validEdges[i]
    symbolInDegree.set(e.to, (symbolInDegree.get(e.to) || 0) + 1)
    symbolOutDegree.set(e.from, (symbolOutDegree.get(e.from) || 0) + 1)
  }

  // Aggregate symbols by file
  const fileMap = new Map()
  for (let i = 0; i < validSymbols.length; i++) {
    const s = validSymbols[i]
    const filePath = s.file || "unknown"
    if (!fileMap.has(filePath)) {
      fileMap.set(filePath, {
        file: filePath,
        symbols: [],
        totalInCalls: 0,
        totalOutCalls: 0,
      })
    }
    const fileEntry = fileMap.get(filePath)
    const inDeg = symbolInDegree.get(s.id) || 0
    const outDeg = symbolOutDegree.get(s.id) || 0
    fileEntry.symbols.push({ ...s, inDegree: inDeg, outDegree: outDeg })
    fileEntry.totalInCalls += inDeg
    fileEntry.totalOutCalls += outDeg
  }

  const fileList = [...fileMap.values()]
  if (fileList.length === 0) return { modules: [], files: [] }

  // Group files by directory module
  const moduleMap = new Map()
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i]
    const parts = f.file.split("/")
    const modName = parts.length > 1 ? parts.slice(0, parts.length - 1).join("/") : "root"
    if (!moduleMap.has(modName)) {
      moduleMap.set(modName, {
        name: modName,
        files: [],
        totalInCalls: 0,
        symbolCount: 0,
      })
    }
    const mod = moduleMap.get(modName)
    mod.files.push(f)
    mod.totalInCalls += f.totalInCalls
    mod.symbolCount += f.symbols.length
  }

  const moduleList = [...moduleMap.values()]

  // Sort modules alphabetically
  moduleList.sort((a, b) => a.name.localeCompare(b.name))

  // Sort files and symbols within each file by line number
  for (let i = 0; i < moduleList.length; i++) {
    const mod = moduleList[i]
    mod.files.sort((a, b) => a.file.localeCompare(b.file))
    for (let j = 0; j < mod.files.length; j++) {
      mod.files[j].symbols.sort((a, b) => (a.line || 0) - (b.line || 0))
    }
  }

  // Normalize heat score based on max calls
  let maxFileCalls = 1
  for (let i = 0; i < fileList.length; i++) {
    if (fileList[i].totalInCalls > maxFileCalls) {
      maxFileCalls = fileList[i].totalInCalls
    }
  }

  const allCalls = fileList.map(f => f.totalInCalls).filter(c => c > 0).sort((a, b) => b - a)
  const top15Threshold = allCalls.length > 0 ? allCalls[Math.max(0, Math.floor(allCalls.length * 0.15))] : 2

  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i]
    const heat = maxFileCalls > 0 ? (f.totalInCalls / maxFileCalls) : 0
    f.heat = heat
    f.color = heatColorFor(heat)
    f.isMostCalled = heat >= 0.4 || (f.totalInCalls >= top15Threshold && f.totalInCalls > 0)
    f.isOrphan = f.totalInCalls === 0
    f.hasViolation = violationFiles.has(f.file)
  }

  for (let i = 0; i < moduleList.length; i++) {
    const mod = moduleList[i]
    mod.hasViolation = violationModules.has(mod.name) || mod.files.some(f => f.hasViolation)
    mod.isMostCalled = mod.files.some(f => f.isMostCalled)
    mod.isOrphan = mod.files.every(f => f.isOrphan)
  }

  // Continuous Flow Layout (nearly square, zero gaps, zero empty voids)
  const totalFiles = Math.max(1, fileList.length)
  const targetCols = options.maxCols || Math.max(8, Math.min(50, Math.ceil(Math.sqrt(totalFiles) * 1.3)))

  const cardSize = 50
  const gap = 5
  const startX = 24
  const startY = 24

  const MODULE_BORDER_COLORS = [
    "#38bdf8", // Sky Blue
    "#34d399", // Emerald
    "#a78bfa", // Violet
    "#fbbf24", // Amber
    "#f472b6", // Rose Pink
    "#22d3ee", // Cyan
    "#fb923c", // Orange
    "#c084fc", // Purple
    "#4ade80", // Light Green
    "#818cf8", // Indigo
  ]

  const modules = []
  const files = []

  let fileIndex = 0

  for (let mIdx = 0; mIdx < moduleList.length; mIdx++) {
    const mod = moduleList[mIdx]
    const modFiles = mod.files
    const borderColor = MODULE_BORDER_COLORS[mIdx % MODULE_BORDER_COLORS.length]
    const modFileObjs = []

    for (let fIdx = 0; fIdx < modFiles.length; fIdx++) {
      const f = modFiles[fIdx]
      const row = Math.floor(fileIndex / targetCols)
      const isReversedRow = (row % 2 === 1)
      const col = isReversedRow ? (targetCols - 1 - (fileIndex % targetCols)) : (fileIndex % targetCols)
      const fx = startX + col * (cardSize + gap)
      const fy = startY + row * (cardSize + gap)

      const fileObj = {
        ...f,
        module: mod.name,
        borderColor,
        x: fx,
        y: fy,
        width: cardSize,
        height: cardSize,
      }

      files.push(fileObj)
      modFileObjs.push(fileObj)
      fileIndex++
    }

    modules.push({
      name: mod.name,
      borderColor,
      fileCount: modFiles.length,
      symbolCount: mod.symbolCount,
      totalInCalls: mod.totalInCalls,
      files: modFileObjs,
    })
  }

  return { modules, files }
}

export function moduleOf(filePath = "") {
  const parts = String(filePath || "").replace(/\\/g, "/").split("/")
  return parts.length > 1 ? parts.slice(0, parts.length - 1).join("/") : "root"
}

export function describeArc(cx, cy, r0, r1, a0, a1) {
  const isFull = Math.abs(a1 - a0) >= 2 * Math.PI - 0.0001
  if (isFull) a1 = a0 + 2 * Math.PI - 0.0001

  const x0a = cx + r1 * Math.cos(a0)
  const y0a = cy + r1 * Math.sin(a0)
  const x1a = cx + r1 * Math.cos(a1)
  const y1a = cy + r1 * Math.sin(a1)

  const largeArc = a1 - a0 > Math.PI ? 1 : 0

  if (r0 <= 0.001) {
    return `M ${cx} ${cy} L ${x0a} ${y0a} A ${r1} ${r1} 0 ${largeArc} 1 ${x1a} ${y1a} Z`
  }

  const x0b = cx + r0 * Math.cos(a1)
  const y0b = cy + r0 * Math.sin(a1)
  const x1b = cx + r0 * Math.cos(a0)
  const y1b = cy + r0 * Math.sin(a0)

  return `M ${x0a} ${y0a} A ${r1} ${r1} 0 ${largeArc} 1 ${x1a} ${y1a} L ${x0b} ${y0b} A ${r0} ${r0} 0 ${largeArc} 0 ${x1b} ${y1b} Z`
}

export function describeRibbon(cx, cy, r, sa0, sa1, ta0, ta1) {
  const sx0 = cx + r * Math.cos(sa0)
  const sy0 = cy + r * Math.sin(sa0)
  const sx1 = cx + r * Math.cos(sa1)
  const sy1 = cy + r * Math.sin(sa1)

  const tx0 = cx + r * Math.cos(ta0)
  const ty0 = cy + r * Math.sin(ta0)
  const tx1 = cx + r * Math.cos(ta1)
  const ty1 = cy + r * Math.sin(ta1)

  const sLarge = sa1 - sa0 > Math.PI ? 1 : 0
  const tLarge = ta1 - ta0 > Math.PI ? 1 : 0

  return `M ${sx0} ${sy0} A ${r} ${r} 0 ${sLarge} 1 ${sx1} ${sy1} Q ${cx} ${cy} ${tx0} ${ty0} A ${r} ${r} 0 ${tLarge} 1 ${tx1} ${ty1} Q ${cx} ${cy} ${sx0} ${sy0} Z`
}

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360
  s = Math.max(0, Math.min(100, s)) / 100
  l = Math.max(0, Math.min(100, l)) / 100

  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2

  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }

  const toHex = (n) => {
    const hex = Math.round((n + m) * 255).toString(16)
    return hex.length === 1 ? "0" + hex : hex
  }

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export const buildSunburstData = (rawGraph, options = {}) => {
  const radius = options.radius || 450
  const cx = options.cx || 500
  const cy = options.cy || 500

  const rawSymbols = Array.isArray(rawGraph?.symbols) ? rawGraph.symbols : []
  const rawEdges = Array.isArray(rawGraph?.edges) ? rawGraph.edges : []
  const symbols = filterSymbols(rawSymbols, options)

  if (symbols.length === 0) {
    return { nodes: [], root: null, maxDepth: 0 }
  }

  // Count incoming calls per symbol
  const callCountMap = new Map()
  for (let i = 0; i < rawEdges.length; i++) {
    const e = rawEdges[i]
    if (e && e.to) {
      callCountMap.set(e.to, (callCountMap.get(e.to) || 0) + 1)
    }
  }

  // Detect architectural violations (calls from lower layers to higher layers, e.g. Service -> UI, DB -> Hook)
  const TIER_ORDER_VAL = {
    ui: 1,
    hook: 2,
    request: 3,
    api: 4,
    service: 5,
    db: 6,
    backend: 5,
  }

  const symMap = new Map()
  const symTiers = new Map()
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]
    symMap.set(s.id, s)
    symTiers.set(s.id, TIER_ORDER_VAL[classifyArchitecturalTier(s.file, s.name)] ?? 3)
  }

  const violationSymbolIds = new Set()
  const violationFiles = new Set()
  const violationModules = new Set()

  for (let i = 0; i < rawEdges.length; i++) {
    const e = rawEdges[i]
    if (e && symTiers.has(e.from) && symTiers.has(e.to)) {
      const fromTier = symTiers.get(e.from)
      const toTier = symTiers.get(e.to)
      if (fromTier > toTier) {
        violationSymbolIds.add(e.from)
        violationSymbolIds.add(e.to)
        const sFrom = symMap.get(e.from)
        const sTo = symMap.get(e.to)
        if (sFrom?.file) {
          violationFiles.add(sFrom.file)
          violationModules.add(moduleOf(sFrom.file))
        }
        if (sTo?.file) {
          violationFiles.add(sTo.file)
          violationModules.add(moduleOf(sTo.file))
        }
      }
    }
  }

  // Build recursive directory tree: Root -> Dir1 -> Dir2 -> ... -> File -> Symbol
  const rootNode = {
    id: "root",
    name: "Codebase Root",
    type: "root",
    children: new Map(),
    files: new Map(),
    symbols: [],
    value: 0,
    calls: 0,
  }

  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]
    const calls = callCountMap.get(s.id) || 0
    const symObj = {
      ...s,
      calls,
      value: 1 + calls,
    }

    const rawPath = String(s.file || "").replace(/\\/g, "/")
    const parts = rawPath.split("/").filter(Boolean)
    const fileName = parts.pop() || "unknown"

    let curr = rootNode
    let accumulatedPath = ""
    for (const part of parts) {
      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part
      if (!curr.children.has(part)) {
        curr.children.set(part, {
          id: "dir:" + accumulatedPath,
          name: part,
          fullPath: accumulatedPath,
          type: "directory",
          children: new Map(),
          files: new Map(),
          symbols: [],
          value: 0,
          calls: 0,
        })
      }
      curr = curr.children.get(part)
    }

    if (!curr.files.has(fileName)) {
      curr.files.set(fileName, {
        id: "file:" + s.file,
        name: fileName,
        fullPath: s.file,
        type: "file",
        symbols: [],
        value: 0,
        calls: 0,
      })
    }
    curr.files.get(fileName).symbols.push(symObj)
  }

  // Calculate bottom-up values and maximum depth
  function computeTotalsAndDepth(node, currentDepth = 0) {
    let val = 0
    let calls = 0
    let maxD = currentDepth

    for (const file of node.files.values()) {
      let fVal = 0
      let fCalls = 0
      for (const sym of file.symbols) {
        fVal += sym.value
        fCalls += sym.calls
      }
      file.value = fVal
      file.calls = fCalls
      val += fVal
      calls += fCalls
      maxD = Math.max(maxD, currentDepth + 2) // +1 for file ring, +1 for symbol ring
    }

    for (const child of node.children.values()) {
      const childD = computeTotalsAndDepth(child, currentDepth + 1)
      val += child.value
      calls += child.calls
      maxD = Math.max(maxD, childD)
    }

    node.value = val
    node.calls = calls
    return maxD
  }

  const maxTreeDepth = Math.max(3, computeTotalsAndDepth(rootNode, 0))
  const rootValue = rootNode.value || 1

  // Ring geometry
  const centerRadius = 70
  const availableRadial = radius - centerRadius
  const ringWidth = Math.max(28, Math.min(80, availableRadial / maxTreeDepth))

  const THEME_PALETTES = [
    { h: 210, s: 75, l: 45 }, // Azure
    { h: 160, s: 70, l: 42 }, // Emerald Teal
    { h: 265, s: 70, l: 50 }, // Violet
    { h: 32,  s: 85, l: 48 }, // Amber
    { h: 340, s: 75, l: 48 }, // Crimson
    { h: 185, s: 75, l: 42 }, // Cyan
    { h: 285, s: 65, l: 52 }, // Purple
    { h: 140, s: 65, l: 40 }, // Jade
    { h: 20,  s: 80, l: 48 }, // Tangerine
    { h: 235, s: 70, l: 52 }, // Indigo
  ]

  const nodes = []

  // Root node
  nodes.push({
    id: "root",
    name: "Codebase Root",
    type: "root",
    depth: 0,
    r0: 0,
    r1: centerRadius,
    a0: 0,
    a1: 2 * Math.PI,
    value: rootValue,
    color: "#0f172a",
    calls: rootNode.calls,
    isMostCalled: true,
    isOrphan: false,
    hasViolation: false,
    d: describeArc(cx, cy, 0, centerRadius, 0, 2 * Math.PI),
  })

  // Traverse and layout arcs recursively
  function layoutNode(node, depth, a0, a1, pal, branchLight = 45) {
    const span = a1 - a0
    if (span <= 0.0001) return

    let currentAngle = a0

    // 1. Layout child directories
    const childEntries = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (let i = 0; i < childEntries.length; i++) {
      const child = childEntries[i]
      const childSpan = (child.value / node.value) * span
      const ca0 = currentAngle
      const ca1 = currentAngle + childSpan
      currentAngle = ca1

      const childPal = depth === 0 ? THEME_PALETTES[i % THEME_PALETTES.length] : pal
      const childLight = depth === 0 ? childPal.l : Math.min(65, branchLight + 4)
      const childColor = hslToHex(childPal.h, childPal.s, childLight)

      const r0 = centerRadius + depth * ringWidth + 3
      const r1 = centerRadius + (depth + 1) * ringWidth

      nodes.push({
        id: child.id,
        name: child.name,
        fullPath: child.fullPath,
        type: "directory",
        module: child.fullPath,
        depth: depth + 1,
        r0,
        r1,
        a0: ca0,
        a1: ca1,
        value: child.value,
        calls: child.calls,
        color: childColor,
        isMostCalled: child.calls > 5,
        isOrphan: child.calls === 0,
        hasViolation: false,
        d: describeArc(cx, cy, r0, r1, ca0, ca1),
      })

      layoutNode(child, depth + 1, ca0, ca1, childPal, childLight)
    }

    // 2. Layout files in this directory
    const fileEntries = [...node.files.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (let fIdx = 0; fIdx < fileEntries.length; fIdx++) {
      const file = fileEntries[fIdx]
      const fileSpan = (file.value / node.value) * span
      const fa0 = currentAngle
      const fa1 = currentAngle + fileSpan
      currentAngle = fa1

      const filePal = depth === 0 ? THEME_PALETTES[fIdx % THEME_PALETTES.length] : pal
      const fileLight = Math.min(72, branchLight + 6 + ((fIdx % 3) * 3))
      const fileColor = hslToHex(filePal.h, Math.max(45, filePal.s - 6), fileLight)

      const fileDepth = depth + 1
      const r0 = centerRadius + (fileDepth - 1) * ringWidth + 3
      const r1 = centerRadius + fileDepth * ringWidth

      nodes.push({
        id: file.id,
        name: file.name,
        fullPath: file.fullPath,
        type: "file",
        module: node.fullPath || "root",
        depth: fileDepth,
        r0,
        r1,
        a0: fa0,
        a1: fa1,
        value: file.value,
        calls: file.calls,
        color: fileColor,
        symbolsCount: file.symbols.length,
        isMostCalled: file.calls > 5,
        isOrphan: file.calls === 0,
        hasViolation: false,
        d: describeArc(cx, cy, r0, r1, fa0, fa1),
      })

      // 3. Layout symbols within file
      const symDepth = fileDepth + 1
      const symR0 = centerRadius + (symDepth - 1) * ringWidth + 3
      const symR1 = Math.min(radius, centerRadius + symDepth * ringWidth)

      let symCurrentAngle = fa0
      const syms = [...file.symbols].sort((a, b) => b.value - a.value || (a.line || 0) - (b.line || 0))

      for (let sIdx = 0; sIdx < syms.length; sIdx++) {
        const sym = syms[sIdx]
        const symSpan = (sym.value / file.value) * fileSpan
        if (symSpan < 0.0008 && sIdx < syms.length - 1 && sIdx > 10) {
          const remaining = syms.slice(sIdx)
          const remVal = remaining.reduce((acc, s) => acc + s.value, 0)
          const remCalls = remaining.reduce((acc, s) => acc + s.calls, 0)
          const remColor = hslToHex(filePal.h, Math.max(30, filePal.s - 20), Math.min(80, fileLight + 8))
          nodes.push({
            id: "agg:" + file.fullPath + ":" + sIdx,
            name: `+${remaining.length} more in ${file.name}`,
            file: file.fullPath,
            type: "group",
            module: node.fullPath || "root",
            depth: symDepth,
            r0: symR0,
            r1: symR1,
            a0: symCurrentAngle,
            a1: fa1,
            value: remVal,
            calls: remCalls,
            color: remColor,
            isMostCalled: remCalls > 5,
            isOrphan: remCalls === 0,
            hasViolation: false,
            d: describeArc(cx, cy, symR0, symR1, symCurrentAngle, fa1),
          })
          break
        }

        const sa0 = symCurrentAngle
        const sa1 = symCurrentAngle + symSpan
        symCurrentAngle = sa1

        const symLight = Math.min(80, fileLight + 4 + ((sIdx % 3) * 3))
        const symColor = hslToHex(filePal.h, filePal.s, symLight)

        nodes.push({
          id: sym.id,
          name: sym.name,
          file: sym.file,
          line: sym.line,
          type: "symbol",
          module: node.fullPath || "root",
          depth: symDepth,
          r0: symR0,
          r1: symR1,
          a0: sa0,
          a1: sa1,
          calls: sym.calls,
          value: sym.value,
          color: symColor,
          isMostCalled: sym.calls > 5,
          isOrphan: sym.calls === 0,
          hasViolation: false,
          d: describeArc(cx, cy, symR0, symR1, sa0, sa1),
        })
      }
    }
  }

  layoutNode(rootNode, 0, 0, 2 * Math.PI, THEME_PALETTES[0], 45)

  return { nodes, maxDepth: maxTreeDepth, cx, cy, radius }
}

export const buildChordData = (rawGraph, options = {}) => {
  const radius = options.radius || 360
  const innerRadius = radius - 28
  const cx = options.cx || 500
  const cy = options.cy || 500

  const rawSymbols = Array.isArray(rawGraph?.symbols) ? rawGraph.symbols : []
  const rawEdges = Array.isArray(rawGraph?.edges) ? rawGraph.edges : []
  const symbols = filterSymbols(rawSymbols, options)

  const symToModule = new Map()
  const moduleSet = new Set()
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]
    const mod = moduleOf(s.file)
    symToModule.set(s.id, mod)
    moduleSet.add(mod)
  }

  const moduleNames = [...moduleSet].sort()
  const modCount = moduleNames.length
  if (modCount === 0) {
    return { modules: [], chords: [], totalCalls: 0, cx, cy, radius }
  }

  const modToIdx = new Map(moduleNames.map((m, i) => [m, i]))
  const matrix = Array.from({ length: modCount }, () => new Float64Array(modCount))
  let totalCalls = 0

  for (let i = 0; i < rawEdges.length; i++) {
    const e = rawEdges[i]
    if (!e) continue
    const uMod = symToModule.get(e.from)
    const vMod = symToModule.get(e.to)
    if (uMod && vMod) {
      const u = modToIdx.get(uMod)
      const v = modToIdx.get(vMod)
      matrix[u][v] += 1
      totalCalls += 1
    }
  }

  // Calculate flow per module (in + out + base)
  const modFlow = new Float64Array(modCount)
  for (let i = 0; i < modCount; i++) {
    let sum = 0
    for (let j = 0; j < modCount; j++) {
      sum += matrix[i][j] + matrix[j][i]
    }
    modFlow[i] = Math.max(1, sum)
  }

  const totalFlow = modFlow.reduce((acc, v) => acc + v, 0)
  const padAngle = modCount > 1 ? Math.min(0.04, (Math.PI * 0.25) / modCount) : 0
  const availableAngle = 2 * Math.PI - padAngle * modCount

  const TIER_ORDER_VAL = { ui: 0, hook: 1, request: 2, api: 3, service: 4, db: 5, util: 6 }
  const modTiers = moduleNames.map(m => TIER_ORDER_VAL[classifyArchitecturalTier(m)] ?? 3)
  const avgFlow = totalCalls > 0 ? (totalCalls / modCount) : 0

  const modules = []
  const modAngles = new Array(modCount)
  let currentAngle = 0

  for (let i = 0; i < modCount; i++) {
    const span = (modFlow[i] / totalFlow) * availableAngle
    const a0 = currentAngle
    const a1 = currentAngle + span
    currentAngle = a1 + padAngle

    const modName = moduleNames[i]
    const color = COLOR_PALETTE[((i * 47) % 360 + 360) % 360]
    modAngles[i] = { a0, a1, span, cursor: a0 }

    let rawSum = 0
    for (let j = 0; j < modCount; j++) rawSum += matrix[i][j] + matrix[j][i]
    const isOrphan = rawSum === 0
    const isMostCalled = modFlow[i] >= avgFlow && rawSum > 0

    modules.push({
      id: "mod:" + modName,
      name: modName,
      tier: classifyArchitecturalTier(modName),
      a0,
      a1,
      r0: innerRadius,
      r1: radius,
      color,
      totalCalls: Math.round(modFlow[i]),
      isOrphan,
      isMostCalled,
      hasViolation: false,
      d: describeArc(cx, cy, innerRadius, radius, a0, a1),
    })
  }

  const chords = []
  for (let i = 0; i < modCount; i++) {
    for (let j = i; j < modCount; j++) {
      const calls = matrix[i][j] + (i !== j ? matrix[j][i] : 0)
      if (calls === 0) continue

      const sSpan = (calls / modFlow[i]) * modAngles[i].span
      const tSpan = (calls / modFlow[j]) * modAngles[j].span

      const sa0 = modAngles[i].cursor
      const sa1 = sa0 + sSpan
      modAngles[i].cursor = sa1

      const ta0 = modAngles[j].cursor
      const ta1 = ta0 + tSpan
      modAngles[j].cursor = ta1

      const isViolation = (matrix[i][j] > 0 && modTiers[i] > modTiers[j]) || (matrix[j][i] > 0 && modTiers[j] > modTiers[i])
      if (isViolation) {
        modules[i].hasViolation = true
        modules[j].hasViolation = true
      }

      const color = isViolation ? "#ef4444" : COLOR_PALETTE[((i * 47 + j * 31) % 360 + 360) % 360]
      const d = describeRibbon(cx, cy, innerRadius - 2, sa0, sa1, ta0, ta1)

      chords.push({
        source: moduleNames[i],
        target: moduleNames[j],
        sourceCalls: matrix[i][j],
        targetCalls: matrix[j][i],
        calls,
        color,
        d,
        isViolation,
      })
    }
  }

  return { modules, chords, totalCalls, cx, cy, radius }
}
