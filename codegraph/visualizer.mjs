#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import chokidar from 'chokidar'
import { streamQuery } from './query-client.mjs'
import { buildLayeredGraph, buildHeatmapData, buildSunburstData, buildChordData } from './visualizer-graph.mjs'

const args = process.argv.slice(2)
const rootAt = args.indexOf('--root')
const portAt = args.indexOf('--port')
const positionalPath = args.find((a, i) => !a.startsWith('-') && (i === 0 || !args[i - 1].startsWith('--')))
const root = path.resolve(rootAt >= 0 ? args[rootAt + 1] : (positionalPath ?? process.env.CODEGRAPH_ROOT ?? process.cwd()))
const port = Number(portAt >= 0 ? args[portAt + 1] : 7331)

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>CodeGraph — Layered Call Flow</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --danger: #f43f5e;
      --warning: #fbbf24;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
      user-select: none;
      -webkit-user-select: none;
    }
    input, .node-detail-val { user-select: text; -webkit-user-select: text; }
    svg text, #viewport, #canvas, .node-card { user-select: none; -webkit-user-select: none; }
    header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 10px 20px;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 16px;
      z-index: 10;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 16px;
      color: var(--accent);
      justify-self: start;
      min-width: 0;
      white-space: nowrap;
    }
    .brand-logo {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .brand-bolt {
      font-size: 16px;
      line-height: 1;
      display: inline-block;
    }
    .brand-cg {
      display: none;
    }
    .brand-text {
      color: var(--accent);
      font-weight: 700;
      font-size: 15px;
      letter-spacing: -0.2px;
    }
    .project-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #0b1120;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 11px;
      color: var(--muted);
      margin-left: 8px;
      max-width: 450px;
    }
    .project-name { font-weight: 700; color: var(--accent); }
    .project-path { color: #64748b; font-family: monospace; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    @media (max-width: 1250px) {
      .brand-text {
        display: none;
      }
      .brand-logo {
        width: 34px;
        height: 28px;
        background: rgba(56, 189, 248, 0.08);
        border: 1px solid rgba(56, 189, 248, 0.25);
        border-radius: 6px;
      }
      .brand-bolt {
        font-size: 20px;
        opacity: 0.35;
        filter: drop-shadow(0 0 4px rgba(245, 158, 11, 0.5));
      }
      .brand-cg {
        display: block;
        position: absolute;
        font-size: 11px;
        font-weight: 900;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        color: #38bdf8;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95);
        letter-spacing: -0.5px;
      }
      .project-pill {
        max-width: 260px;
      }
    }

    @media (max-width: 950px) {
      header {
        padding: 8px 12px;
        gap: 8px;
      }
      .project-pill {
        max-width: 160px;
      }
    }
    .tabs {
      display: flex;
      background: #0b1120;
      border-radius: 8px;
      padding: 3px;
      gap: 4px;
      justify-self: center;
      width: max-content;
    }
    .tab {
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      color: var(--muted);
      border: none;
      background: transparent;
      transition: all 0.15s ease;
    }
    .tab.active {
      background: var(--card-bg);
      color: var(--text);
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .tab.disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .stats-wrapper {
      justify-self: end;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      min-width: 0;
    }
    .stats {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      flex-wrap: nowrap;
    }
    .badge {
      background: #0b1120;
      border: 1px solid var(--border);
      padding: 4px 8px;
      border-radius: 6px;
      color: var(--muted);
    }
    .badge strong { color: var(--accent); }
    .badge.warn strong { color: var(--warning); }
    .badge.danger strong { color: var(--danger); }
    .toolbar {
      background: #151e2e;
      border-bottom: 1px solid var(--border);
      padding: 8px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      font-size: 12px;
    }
    .search-box input {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      outline: none;
      width: 240px;
    }
    .filter-group { display: flex; align-items: center; gap: 8px; }
    .filter-btn {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--muted);
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .filter-btn:hover { color: var(--text); }
    .filter-btn.active {
      background: #1e3a5f;
      color: var(--accent);
      border-color: var(--accent);
    }
    .toggle-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
      cursor: pointer;
      margin-left: 12px;
      border-left: 1px solid var(--border);
      padding-left: 12px;
    }
    .main-area {
      position: relative;
      flex: 1;
      overflow: hidden;
      display: flex;
      contain: paint layout size;
    }
    #viewport {
      flex: 1;
      width: 100%;
      height: 100%;
      cursor: grab;
      contain: strict;
      shape-rendering: geometricPrecision;
    }
    #viewport:active { cursor: grabbing; }
    #canvas {
      will-change: transform;
    }
    .sidebar {
      width: 320px;
      background: var(--card-bg);
      border-left: 1px solid var(--border);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow-y: auto;
      font-size: 13px;
    }
    .sidebar-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text);
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .node-detail-field { display: flex; flex-direction: column; gap: 4px; }
    .node-detail-label { font-size: 11px; text-transform: uppercase; color: var(--muted); }
    .node-detail-val {
      font-family: monospace;
      background: #0b1120;
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
      word-break: break-all;
    }
    .explanation-banner {
      background: rgba(56, 189, 248, 0.08);
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      line-height: 1.5;
      color: #cbd5e1;
    }
    .explanation-banner strong { color: var(--accent); }
    .progress-overlay {
      position: absolute;
      inset: 0;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(4px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      z-index: 50;
    }
    .spinner {
      width: 36px;
      height: 36px;
      border: 3px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .ctrl-group {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
    }
    .ctrl-btn {
      width: 28px;
      height: 28px;
      background: #0f172a;
      border: 1px solid #334155;
      color: #f8fafc;
      border-radius: 5px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }
    .ctrl-btn:hover {
      background: #334155;
      color: var(--accent);
      border-color: var(--accent);
    }
    .ctrl-btn:active {
      transform: scale(0.95);
    }
    .node-card { cursor: pointer; }
    .node-card rect { rx: 5; stroke-width: 1.2; }
    .edge-path { opacity: 0; pointer-events: none; fill: none; stroke: var(--accent); stroke-width: 1.5; marker-end: url(#arrow); cursor: pointer; }
    .edge-path.highlighted { opacity: 1 !important; pointer-events: auto !important; stroke: var(--accent) !important; stroke-width: 1.5 !important; }
    .edge-path.violation { stroke: #f43f5e !important; stroke-dasharray: 4, 3; stroke-width: 1.5 !important; marker-end: url(#arrow-danger); }
    .edge-hitbox { display: none; fill: none; stroke: transparent; stroke-width: 12; cursor: pointer; }
    .edge-hitbox.highlighted { display: block !important; }
    #viewport.has-selection .node-card { opacity: 0.15; }
    #viewport.has-selection .node-card.highlighted { opacity: 1 !important; }
    #viewport.has-selection .node-card.highlighted rect { stroke: #38bdf8 !important; stroke-width: 1.8 !important; filter: drop-shadow(0 0 5px rgba(56,189,248,0.45)); }
    .sidebar-item-link {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 8px;
      margin: 3px 0;
      border-radius: 5px;
      cursor: pointer;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #f8fafc;
      transition: all 0.15s ease;
    }
    .sidebar-item-link:hover {
      background: #334155;
      color: var(--accent);
      border-color: var(--accent);
      transform: translateX(2px);
    }
    .edge-path.violation { stroke: var(--danger) !important; stroke-dasharray: 4, 3; stroke-width: 2; marker-end: url(#arrow-danger); }
    .layer-band { fill: rgba(30, 41, 59, 0.4); stroke: var(--border); stroke-dasharray: 2, 2; }
    .layer-badge-bg { fill: #0b1120; stroke: #334155; rx: 6; }
    .layer-label { fill: var(--accent); font-size: 11px; font-weight: 800; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .heatmap-module {
      fill: rgba(15, 23, 42, 0.25);
      stroke-width: 2px;
      rx: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .heatmap-module:hover {
      fill: rgba(30, 41, 59, 0.45);
      filter: brightness(1.2);
    }
    .heatmap-module.highlighted {
      fill: rgba(30, 41, 59, 0.6) !important;
      stroke: #ffffff !important;
      stroke-width: 3px !important;
      filter: brightness(1.3) drop-shadow(0 0 8px rgba(255, 255, 255, 0.3));
    }
    .heatmap-card {
      cursor: pointer;
      rx: 5px;
      stroke-width: 2px;
      stroke-linecap: round;
      stroke-linejoin: round;
      transition: all 0.12s ease;
    }
    .heatmap-card:hover {
      stroke: #ffffff !important;
      stroke-width: 3px !important;
      filter: brightness(1.35) drop-shadow(0 0 6px rgba(255, 255, 255, 0.7));
    }
    .heatmap-card.highlighted {
      stroke: #ffffff !important;
      stroke-width: 3.5px !important;
      filter: brightness(1.4) drop-shadow(0 0 8px #38bdf8);
    }
    .heatmap-legend { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
    .sunburst-arc {
      cursor: pointer;
      stroke: none !important;
      stroke-width: 0 !important;
    }
    .sunburst-arc:hover, .sunburst-arc.hovered {
      filter: brightness(1.25);
    }
    .chord-arc {
      cursor: pointer;
      stroke: none !important;
      stroke-width: 0 !important;
    }
    .chord-arc:hover {
      filter: brightness(1.3);
    }
    .chord-arc.highlighted {
      filter: brightness(1.4);
    }
    .chord-ribbon {
      fill-opacity: 0.45;
      stroke: none !important;
      stroke-width: 0 !important;
      cursor: pointer;
    }
    .chord-ribbon:hover, .chord-ribbon.hovered {
      fill-opacity: 0.85;
      filter: brightness(1.2);
    }
    .chord-ribbon.highlighted {
      fill-opacity: 0.9 !important;
      filter: brightness(1.3) !important;
    }
    .chord-label {
      opacity: 0;
      pointer-events: none;
      font-size: 11px;
      font-weight: 700;
      paint-order: stroke fill;
      stroke: #090d16;
      stroke-width: 3.5px;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .chord-label.hovered, .chord-label.highlighted {
      opacity: 1 !important;
      font-size: 12px !important;
      font-weight: 800 !important;
      stroke-width: 4px !important;
    }
    #viewport.has-selection .sunburst-arc {
      opacity: 0.12 !important;
      filter: grayscale(0.5) !important;
      pointer-events: none !important;
    }
    #viewport.has-selection .sunburst-arc.active-branch {
      opacity: 1 !important;
      filter: none !important;
      stroke: none !important;
      stroke-width: 0 !important;
      pointer-events: auto !important;
    }
    #viewport.has-selection .chord-arc { opacity: 0.25; }
    #viewport.has-selection .chord-arc.highlighted { opacity: 1 !important; }
    #viewport.has-selection .chord-ribbon { opacity: 0.08; }
    #viewport.has-selection .chord-ribbon.highlighted { opacity: 1 !important; fill-opacity: 0.95 !important; }
    #viewport.has-selection .chord-label { opacity: 0 !important; }
    #viewport.has-selection .chord-label.highlighted { opacity: 1 !important; }
    .toast-bottom-left {
      position: absolute;
      bottom: 12px;
      left: 12px;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 5px;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(56, 189, 248, 0.4);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      color: #f8fafc;
      pointer-events: auto;
    }
    .toast-refresh-btn {
      background: #0284c7;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 2px 7px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .toast-refresh-btn:hover {
      background: #38bdf8;
      color: #0f172a;
    }
    .toast-close-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 10px;
      cursor: pointer;
      padding: 0 2px;
    }
    .toast-close-btn:hover {
      color: #f8fafc;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo" title="CodeGraph">
        <span class="brand-bolt">⚡</span>
        <span class="brand-cg">(CG)</span>
      </div>
      <span class="brand-text">CodeGraph</span>
      <div class="project-pill" id="project-pill" style="display: none;">
        <span class="project-name" id="project-name"></span>
        <span class="project-path" id="project-path"></span>
      </div>
    </div>
    <div class="tabs">
      <button class="tab active" data-view="layered">Layered Flow</button>
      <button class="tab" data-view="heatmap">Heat Map</button>
      <button class="tab" data-view="sunburst">Sunburst</button>
      <button class="tab" data-view="chord">Chord</button>
    </div>
    <div class="stats-wrapper">
      <div class="stats" id="stats-layered">
        <div class="badge">Symbols: <strong id="stat-symbols">0</strong></div>
        <div class="badge">Calls: <strong id="stat-calls">0</strong></div>
        <div class="badge">Layers: <strong id="stat-layers">0</strong></div>
        <div class="badge warn">Most Called: <strong id="stat-most-called">0</strong></div>
        <div class="badge">Orphans: <strong id="stat-orphans">0</strong></div>
        <div class="badge danger">Violations: <strong id="stat-violations">0</strong></div>
      </div>
      <div class="stats" id="stats-heatmap" style="display: none;">
        <div class="badge">Modules: <strong id="stat-hm-modules">0</strong></div>
        <div class="badge">Files: <strong id="stat-hm-files">0</strong></div>
        <div class="badge">Symbols: <strong id="stat-hm-symbols">0</strong></div>
        <div class="badge warn">Top Heat: <strong id="stat-hm-max-calls">0</strong> calls</div>
        <div class="heatmap-legend">
          <span>Cool</span>
          <div class="legend-bar"></div>
          <span>Hot</span>
        </div>
      </div>
      <div class="stats" id="stats-sunburst" style="display: none;">
        <div class="badge">Modules: <strong id="stat-sb-modules">0</strong></div>
        <div class="badge">Files: <strong id="stat-sb-files">0</strong></div>
        <div class="badge">Symbols: <strong id="stat-sb-symbols">0</strong></div>
        <div class="badge warn">Tiers: <strong id="stat-sb-depth">4</strong></div>
      </div>
      <div class="stats" id="stats-chord" style="display: none;">
        <div class="badge">Modules: <strong id="stat-ch-modules">0</strong></div>
        <div class="badge">Interactions: <strong id="stat-ch-chords">0</strong></div>
        <div class="badge warn">Cross Calls: <strong id="stat-ch-calls">0</strong></div>
      </div>
    </div>
  </header>

  <div class="toolbar">
    <div class="search-box">
      <input type="text" id="search-input" placeholder="Filter symbols or files...">
    </div>
    <div class="filter-group">
      <button class="filter-btn active" data-filter="all">All</button>
      <button class="filter-btn" data-filter="most-called">🔥 Most Called</button>
      <button class="filter-btn" data-filter="orphans">👻 Orphans</button>
      <button class="filter-btn" data-filter="violations">⚠️ Upward Violations</button>
      <label class="toggle-label">
        <input type="checkbox" id="toggle-tests"> Include Tests
      </label>
    </div>
    <div class="ctrl-group">
      <button class="ctrl-btn" id="btn-top" title="Center View (Home)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="8"></circle>
          <line x1="12" y1="2" x2="12" y2="6"></line>
          <line x1="12" y1="18" x2="12" y2="22"></line>
          <line x1="2" y1="12" x2="6" y2="12"></line>
          <line x1="18" y1="12" x2="22" y2="12"></line>
          <circle cx="12" cy="12" r="2" fill="currentColor"></circle>
        </svg>
      </button>
      <button class="ctrl-btn" id="btn-zoom-in" title="Zoom In">+</button>
      <button class="ctrl-btn" id="btn-zoom-out" title="Zoom Out">−</button>
      <button class="ctrl-btn" id="btn-reset" title="Reset View">⟲</button>
    </div>
  </div>

  <div class="main-area">
    <div id="toast" class="toast-bottom-left" style="display: none;">
      <span id="toast-text">⚡ Updating...</span>
      <button id="toast-refresh" class="toast-refresh-btn" style="display: none;" onclick="window.applyPendingUpdate()">⟳ Refresh</button>
      <button class="toast-close-btn" onclick="window.dismissToast()" title="Dismiss">✕</button>
    </div>

    <div id="progress" class="progress-overlay">
      <div class="spinner"></div>
      <div class="progress-text" id="progress-msg">Computing topological execution layers...</div>
    </div>

    <svg id="viewport">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
          <path d="M 0 2 L 7 5 L 0 8 z" fill="#38bdf8" />
        </marker>
        <marker id="arrow-danger" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
          <path d="M 0 2 L 7 5 L 0 8 z" fill="#f43f5e" />
        </marker>
      </defs>
      <g id="canvas"></g>
    </svg>

    <aside class="sidebar">
      <div class="sidebar-title">Inspector</div>
      <div class="explanation-banner">
        <strong id="explanation-title">Layered Call Flow:</strong><br>
        <span id="explanation-body">This graph shows how a request travels through our system from top to bottom. At the very top, we have components closest to the user (like UI and controller methods). As execution moves downward through the graph, calls descend into deeper layers (like domain logic, API handlers, and data persistence). Sorting the graph this way ensures dependencies only flow downward, keeping our system decoupled and easy to debug.</span>
      </div>
      <div id="selection-details">
        <div style="color: var(--muted); font-size: 12px; margin-top: 10px;">Click any card in the graph to inspect its callers, callees, and layer level.</div>
      </div>
    </aside>
  </div>

  <script>
    let currentView = "layered";
    let graphData = null;
    let heatmapData = null;
    let currentFilter = "all";
    let transform = { x: 40, y: 40, k: 0.85 };
    let isMouseDown = false;
    let hasDragged = false;
    let startPan = { x: 0, y: 0 };
    let startMouse = { x: 0, y: 0 };
    let rafPending = false;

    const svg = document.getElementById("viewport");
    const canvas = document.getElementById("canvas");
    const progress = document.getElementById("progress");

    // Fast indexed maps for O(1) lookups
    let activeSelectedId = null;
    let posMap = new Map();
    let panAnimId = null;
    const nodeMap = new Map();
    const nodeElements = new Map();
    const edgeElements = new Map();
    const hitboxElements = new Map();
    const incomingEdgeMap = new Map();
    const outgoingEdgeMap = new Map();
    const violationNodeIds = new Set();
    let activeHighlighted = [];
    const NODE_WIDTH = 200;
    const NODE_HEIGHT = 44;
    const NODE_SPACING_X = 216;
    const PADDING_X = 120;

    function scheduleTransform() {
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          canvas.setAttribute("transform", "translate(" + transform.x + ", " + transform.y + ") scale(" + transform.k + ")");
          rafPending = false;
        });
      }
    }

    function animatePanTo(targetX, targetY) {
      if (panAnimId) cancelAnimationFrame(panAnimId);
      const startX = transform.x;
      const startY = transform.y;
      const startTime = performance.now();
      const duration = 280;

      function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        transform.x = startX + (targetX - startX) * ease;
        transform.y = startY + (targetY - startY) * ease;
        scheduleTransform();
        if (t < 1) {
          panAnimId = requestAnimationFrame(step);
        } else {
          panAnimId = null;
        }
      }
      panAnimId = requestAnimationFrame(step);
    }

    function focusNode(node) {
      if (!node) return;
      selectNode(node);
      const pos = posMap.get(node.id);
      if (!pos) return;
      const viewW = svg.clientWidth || window.innerWidth;
      const viewH = svg.clientHeight || window.innerHeight;
      const targetX = (viewW / 2) - (pos.x + 115) * transform.k;
      const targetY = (viewH / 2) - (pos.y + 29) * transform.k;
      animatePanTo(targetX, targetY);
    }

    function centerView(viewName = currentView) {
      const vw = svg.clientWidth || (window.innerWidth - 320);
      const vh = svg.clientHeight || (window.innerHeight - 80);

      if (viewName === "sunburst") {
        const diameter = 900;
        const pad = 24;
        const k = Math.min((vw - pad * 2) / diameter, (vh - pad * 2) / diameter);
        const x = (vw / 2) - 500 * k;
        const y = (vh / 2) - 500 * k;
        transform = { x, y, k };
      } else if (viewName === "chord") {
        const diameter = 980;
        const pad = 24;
        const k = Math.min((vw - pad * 2) / diameter, (vh - pad * 2) / diameter);
        const x = (vw / 2) - 500 * k;
        const y = (vh / 2) - 500 * k;
        transform = { x, y, k };
      } else if (viewName === "heatmap") {
        const modules = heatmapData?.modules || [];
        const files = heatmapData?.files || [];
        if (modules.length === 0 && files.length === 0) {
          transform = { x: 40, y: 40, k: 0.85 };
        } else {
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          modules.forEach(m => {
            if (m.x < minX) minX = m.x;
            if (m.x + m.width > maxX) maxX = m.x + m.width;
            if (m.y < minY) minY = m.y;
            if (m.y + m.height > maxY) maxY = m.y + m.height;
          });
          files.forEach(f => {
            if (f.x < minX) minX = f.x;
            if (f.x + f.width > maxX) maxX = f.x + f.width;
            if (f.y < minY) minY = f.y;
            if (f.y + f.height > maxY) maxY = f.y + f.height;
          });
          const totalW = maxX - minX || 1000;
          const totalH = maxY - minY || 800;
          const pad = 24;
          const k = Math.min((vw - pad * 2) / totalW, (vh - pad * 2) / totalH);
          const x = (vw / 2) - (minX + totalW / 2) * k;
          const y = (vh / 2) - (minY + totalH / 2) * k;
          transform = { x, y, k: Math.max(0.12, k) };
        }
      } else {
        transform = { x: 40, y: 30, k: 0.85 };
      }
      scheduleTransform();
    }

    window.focusNodeById = (id) => {
      const n = nodeMap.get(id);
      if (n) focusNode(n);
    };

    svg.addEventListener("mousedown", (e) => {
      isMouseDown = true;
      hasDragged = false;
      startMouse = { x: e.clientX, y: e.clientY };
      startPan = { x: e.clientX - transform.x, y: e.clientY - transform.y };
    });

    window.addEventListener("mousemove", (e) => {
      if (!isMouseDown) return;
      const dx = Math.abs(e.clientX - startMouse.x);
      const dy = Math.abs(e.clientY - startMouse.y);
      if (dx > 3 || dy > 3) {
        hasDragged = true;
        svg.classList.add("is-panning");
      }
      transform.x = e.clientX - startPan.x;
      transform.y = e.clientY - startPan.y;
      scheduleTransform();
    });

    window.addEventListener("mouseup", () => {
      isMouseDown = false;
      svg.classList.remove("is-panning");
    });

    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      if (e.ctrlKey || e.metaKey || !e.shiftKey) {
        // Zoom: softened and dampened exponential scaling
        const factor = Math.max(0.94, Math.min(1.06, Math.pow(0.9992, e.deltaY)));
        const newK = Math.max(0.05, Math.min(4, transform.k * factor));
        transform.x = mouseX - (mouseX - transform.x) * (newK / transform.k);
        transform.y = mouseY - (mouseY - transform.y) * (newK / transform.k);
        transform.k = newK;
      } else {
        // Pan: direct 1:1 translation with NO dampening
        transform.x -= (e.deltaX || 0);
        transform.y -= (e.deltaY || 0);
      }
      scheduleTransform();
    }, { passive: false });

    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        transform.k = Math.min(4, transform.k * 1.12);
        scheduleTransform();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        transform.k = Math.max(0.05, transform.k / 1.12);
        scheduleTransform();
      } else if (e.key === "0") {
        e.preventDefault();
        centerView(currentView);
      } else if (e.key === "Home" || e.key === "h" || e.key === "H") {
        e.preventDefault();
        centerView(currentView);
      }
    });

    document.getElementById("btn-top").onclick = () => {
      centerView(currentView);
    };
    document.getElementById("btn-zoom-in").onclick = () => { transform.k = Math.min(4, transform.k * 1.12); scheduleTransform(); };
    document.getElementById("btn-zoom-out").onclick = () => { transform.k = Math.max(0.05, transform.k / 1.12); scheduleTransform(); };
    document.getElementById("btn-reset").onclick = () => { centerView(currentView); };

    document.querySelectorAll(".tab").forEach(tab => {
      tab.onclick = () => {
        if (tab.classList.contains("disabled")) return;
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        currentView = tab.dataset.view;
        try {
          localStorage.setItem("codegraph_active_tab", currentView);
          history.replaceState(null, "", "#" + currentView);
        } catch(e) {}
        switchView();
      };
    });

    let sunburstData = null;
    let chordData = null;
    let activeSelectedSunburstId = null;
    let activeSelectedChordModule = null;

    let hasPendingUpdate = false;
    const toastEl = document.getElementById("toast");
    const toastText = document.getElementById("toast-text");
    const toastRefreshBtn = document.getElementById("toast-refresh");

    function showToast(text, showRefresh = false) {
      if (!toastEl) return;
      toastText.textContent = text;
      toastRefreshBtn.style.display = showRefresh ? "inline-block" : "none";
      toastEl.style.display = "flex";
    }

    function hideToast() {
      if (toastEl) toastEl.style.display = "none";
    }

    window.applyPendingUpdate = function() {
      console.log("[CodeGraph UI] User clicked 'Refresh' — reloading active view in-place");
      hasPendingUpdate = false;
      hideToast();
      switchView(true);
    };

    window.dismissToast = function() {
      console.log("[CodeGraph UI] User dismissed update toast");
      hideToast();
    };

    if (window.EventSource) {
      console.log("[CodeGraph UI] Initializing EventSource connection to /events");
      const es = new EventSource("/events");
      es.onopen = () => {
        console.log("[CodeGraph UI] Connected to live update stream (/events)");
      };
      es.onmessage = (evt) => {
        try {
          const payload = JSON.parse(evt.data);
          if (payload.status === "connected") {
            console.log("[CodeGraph UI] Live update watcher confirmed ready");
          } else if (payload.status === "indexing") {
            console.log("[CodeGraph UI] Event: indexing — update detected on disk, displaying '⚡ Updating...'");
            showToast("⚡ Updating...", false);
          } else if (payload.status === "ready") {
            console.log("[CodeGraph UI] Event: ready — changes settled, displaying '⚡ [⟳ Refresh]'");
            hasPendingUpdate = true;
            showToast("⚡", true);
          }
        } catch (err) {
          console.error("[CodeGraph UI] Error parsing SSE payload:", err);
        }
      };
      es.onerror = (err) => {
        console.warn("[CodeGraph UI] SSE connection warning:", err);
      };
    }

    function switchView(forceFresh = false) {
      if (hasPendingUpdate) {
        console.log("[CodeGraph UI] Tab switched with pending update — auto-refreshing fresh generation for:", currentView);
        hasPendingUpdate = false;
        hideToast();
        forceFresh = true;
      }
      if (forceFresh) {
        graphData = null;
        heatmapData = null;
        sunburstData = null;
        chordData = null;
      }

      const isLayered = currentView === "layered";
      const isHeatmap = currentView === "heatmap";
      const isSunburst = currentView === "sunburst";
      const isChord = currentView === "chord";

      document.getElementById("stats-layered").style.display = isLayered ? "flex" : "none";
      document.getElementById("stats-heatmap").style.display = isHeatmap ? "flex" : "none";
      document.getElementById("stats-sunburst").style.display = isSunburst ? "flex" : "none";
      document.getElementById("stats-chord").style.display = isChord ? "flex" : "none";

      const titles = {
        layered: "Layered Call Flow",
        heatmap: "Codebase Heat Map",
        sunburst: "Sunburst Hierarchy",
        chord: "Module Coupling Chord"
      };
      const explanations = {
        layered: {
          title: "Layered Call Flow:",
          body: "This graph shows how a request travels through our system from top to bottom. At the very top, we have components closest to the user (like UI and controller methods). As execution moves downward through the graph, calls descend into deeper layers (like domain logic, API handlers, and data persistence). Sorting the graph this way ensures dependencies only flow downward, keeping our system decoupled and easy to debug."
        },
        heatmap: {
          title: "Codebase Heat Map:",
          body: "Visualizes symbol density and caller centrality across modules. Warmer colors (hot red and amber) represent high-traffic core modules and frequently invoked files. Cooler colors (cyan and emerald) represent specialized leaf utilities or lower-churn components."
        },
        sunburst: {
          title: "Sunburst Partition:",
          body: "Multi-tier radial partition diagram breaking down codebase packages from center to perimeter (Root ➔ Modules ➔ Files ➔ Functions/Methods). The angular arc width of each segment is proportional to code density and incoming calls."
        },
        chord: {
          title: "Module Coupling Chord:",
          body: "Radial dependency diagram visualizing cross-module caller and callee coupling. Outer perimeter arcs represent modules, and internal flow ribbons represent call volume and bidirectional interactions between packages."
        }
      };

      document.getElementById("explanation-title").textContent = explanations[currentView]?.title || "";
      document.getElementById("explanation-body").innerHTML = explanations[currentView]?.body || "";

      const includeTests = document.getElementById("toggle-tests").checked;

      if (isHeatmap) {
        if (!heatmapData) loadHeatmap(includeTests);
        else renderHeatmap();
      } else if (isSunburst) {
        if (!sunburstData) loadSunburst(includeTests);
        else renderSunburst();
      } else if (isChord) {
        if (!chordData) loadChord(includeTests);
        else renderChord();
      } else {
        if (!graphData) loadGraph(includeTests);
        else renderGraph();
      }
    }

    const inFlightFetches = new Map();
    async function fetchViewData(url) {
      if (inFlightFetches.has(url)) return inFlightFetches.get(url);
      const p = (async () => {
        const res = await fetch(url);
        if (!res.ok) {
          let errorMsg = "HTTP " + res.status + ": " + res.statusText;
          try {
            const data = await res.json();
            if (data?.error) errorMsg = data.error;
          } catch {}
          throw new Error(errorMsg);
        }
        return res.json();
      })().finally(() => {
        inFlightFetches.delete(url);
      });
      inFlightFetches.set(url, p);
      return p;
    }

    function loadSunburst(includeTests = false) {
      progress.style.display = "flex";
      document.getElementById("progress-msg").textContent = "Computing multi-tier radial sunburst hierarchy...";
      fetchViewData("/sunburst" + (includeTests ? "?includeTests=1" : ""))
        .then(data => {
          sunburstData = data;
          if (data.project) {
            document.getElementById("project-name").textContent = data.project.name || "";
            document.getElementById("project-path").textContent = data.project.root || "";
            document.getElementById("project-pill").title = data.project.root || "";
            document.getElementById("project-pill").style.display = "inline-flex";
            document.title = "⚡ " + (data.project.name || "CodeGraph") + " — Sunburst";
          }
          const nodes = data.nodes || [];
          const mods = nodes.filter(n => n.depth === 1);
          const files = nodes.filter(n => n.depth === 2);
          const syms = nodes.filter(n => n.depth === 3);

          document.getElementById("stat-sb-modules").textContent = mods.length;
          document.getElementById("stat-sb-files").textContent = files.length;
          document.getElementById("stat-sb-symbols").textContent = syms.length;
          document.getElementById("stat-sb-depth").textContent = (data.maxDepth || 3) + 1;

          renderSunburst();
          progress.style.display = "none";
        })
        .catch(err => {
          document.getElementById("progress-msg").textContent = "Error: " + err.message;
        });
    }

    function loadChord(includeTests = false) {
      progress.style.display = "flex";
      document.getElementById("progress-msg").textContent = "Computing cross-module interaction matrix & chords...";
      fetchViewData("/chord" + (includeTests ? "?includeTests=1" : ""))
        .then(data => {
          chordData = data;
          if (data.project) {
            document.getElementById("project-name").textContent = data.project.name || "";
            document.getElementById("project-path").textContent = data.project.root || "";
            document.getElementById("project-pill").title = data.project.root || "";
            document.getElementById("project-pill").style.display = "inline-flex";
            document.title = "⚡ " + (data.project.name || "CodeGraph") + " — Chord";
          }
          document.getElementById("stat-ch-modules").textContent = (data.modules || []).length;
          document.getElementById("stat-ch-chords").textContent = (data.chords || []).length;
          document.getElementById("stat-ch-calls").textContent = data.totalCalls || 0;

          renderChord();
          progress.style.display = "none";
        })
        .catch(err => {
          document.getElementById("progress-msg").textContent = "Error: " + err.message;
        });
    }

    function loadHeatmap(includeTests = false) {
      progress.style.display = "flex";
      document.getElementById("progress-msg").textContent = "Computing module heat map & call density...";
      fetchViewData("/heatmap" + (includeTests ? "?includeTests=1" : ""))
        .then(data => {
          heatmapData = data;
          if (data.project) {
            document.getElementById("project-name").textContent = data.project.name || "";
            document.getElementById("project-path").textContent = data.project.root || "";
            document.getElementById("project-pill").title = data.project.root || "";
            document.getElementById("project-pill").style.display = "inline-flex";
            document.title = "⚡ " + (data.project.name || "CodeGraph") + " — Heat Map";
          }
          const mods = data.modules || [];
          const files = data.files || [];
          let totalSyms = 0;
          let maxCalls = 0;
          files.forEach(f => {
            totalSyms += f.symbols.length;
            if (f.totalInCalls > maxCalls) maxCalls = f.totalInCalls;
          });
          document.getElementById("stat-hm-modules").textContent = mods.length;
          document.getElementById("stat-hm-files").textContent = files.length;
          document.getElementById("stat-hm-symbols").textContent = totalSyms;
          document.getElementById("stat-hm-max-calls").textContent = maxCalls;

          renderHeatmap();
          progress.style.display = "none";
        })
        .catch(err => {
          document.getElementById("progress-msg").textContent = "Error: " + err.message;
        });
    }

    function loadGraph(includeTests = false) {
      progress.style.display = "flex";
      document.getElementById("progress-msg").textContent = "Computing topological execution layers...";
      fetchViewData("/graph" + (includeTests ? "?includeTests=1" : ""))
        .then(data => {
          graphData = data;
          if (data.project) {
            document.getElementById("project-name").textContent = data.project.name || "";
            document.getElementById("project-path").textContent = data.project.root || "";
            document.getElementById("project-pill").title = data.project.root || "";
            document.getElementById("project-pill").style.display = "inline-flex";
            document.title = "⚡ " + (data.project.name || "CodeGraph") + " — Layered Call Flow";
          }
          renderGraph();
          progress.style.display = "none";
        })
        .catch(err => {
          document.getElementById("progress-msg").textContent = "Error: " + err.message;
        });
    }

    try {
      const hashTab = (window.location.hash || "").replace("#", "").trim();
      const savedTab = (hashTab && ["layered", "heatmap", "sunburst", "chord"].includes(hashTab))
        ? hashTab
        : localStorage.getItem("codegraph_active_tab");
      if (savedTab && ["layered", "heatmap", "sunburst", "chord"].includes(savedTab)) {
        currentView = savedTab;
        document.querySelectorAll(".tab").forEach(t => {
          if (t.dataset.view === currentView) t.classList.add("active");
          else t.classList.remove("active");
        });
      }
    } catch (e) {}

    window.addEventListener("hashchange", () => {
      const hashTab = (window.location.hash || "").replace("#", "").trim();
      if (hashTab && ["layered", "heatmap", "sunburst", "chord"].includes(hashTab) && hashTab !== currentView) {
        currentView = hashTab;
        document.querySelectorAll(".tab").forEach(t => {
          if (t.dataset.view === currentView) t.classList.add("active");
          else t.classList.remove("active");
        });
        switchView();
      }
    });

    switchView();

    document.getElementById("toggle-tests").onchange = (e) => {
      const incTests = e.target.checked;
      if (currentView === "heatmap") loadHeatmap(incTests);
      else if (currentView === "sunburst") loadSunburst(incTests);
      else if (currentView === "chord") loadChord(incTests);
      else loadGraph(incTests);
    };

    function formatLoc(file, line) {
      const parts = (file || "").split("/");
      const base = parts[parts.length - 1] || file;
      return base + ":" + line;
    }

    function renderGraph() {
      if (!graphData) return;
      canvas.innerHTML = "";
      nodeElements.clear();
      nodeMap.clear();
      edgeElements.clear();
      incomingEdgeMap.clear();
      outgoingEdgeMap.clear();
      violationNodeIds.clear();
      activeHighlighted = [];
      svg.classList.remove("has-selection");

      const nodes = graphData.nodes || [];
      const edges = graphData.edges || [];

      // Pre-index edges, nodes, and search strings
      for (const n of nodes) {
        nodeMap.set(n.id, n);
        n.nameLower = (n.name || "").toLowerCase();
        n.fileLower = (n.file || "").toLowerCase();
        incomingEdgeMap.set(n.id, []);
        outgoingEdgeMap.set(n.id, []);
      }

      edges.forEach((e, idx) => {
        e.id = "edge-" + idx;
        if (incomingEdgeMap.has(e.to)) incomingEdgeMap.get(e.to).push(e);
        if (outgoingEdgeMap.has(e.from)) outgoingEdgeMap.get(e.from).push(e);
        if (e.isViolation) {
          violationNodeIds.add(e.from);
          violationNodeIds.add(e.to);
        }
      });

      // 1. Group nodes by Region: Frontend vs Backend
      const sections = [
        { id: "frontend", label: "FRONTEND", color: "#38bdf8", bg: "#0c1e33" },
        { id: "backend", label: "BACKEND", color: "#a78bfa", bg: "#1e1338" }
      ];

      // 2. Partition each region dynamically into rows by exact connection count:
      // Row 0: 0 conns, Row 1: 1 conn, Row 2: 2 conns, ... Row N: N conns
      const grid = {
        frontend: new Map(),
        backend: new Map()
      };

      for (const n of nodes) {
        const reg = n.region === "backend" ? "backend" : "frontend";
        const conn = (n.inDegree || 0) + (n.outDegree || 0);
        if (!grid[reg].has(conn)) grid[reg].set(conn, []);
        grid[reg].get(conn).push(n);
      }

      // Compute maximum nodes in any single row to scale the SVG canvas dynamically
      let maxRowNodes = 1;
      let distinctRowCount = 0;
      for (const sec of ["frontend", "backend"]) {
        for (const [conn, rowNodes] of grid[sec].entries()) {
          if (rowNodes.length > maxRowNodes) maxRowNodes = rowNodes.length;
          distinctRowCount++;
        }
      }

      document.getElementById("stat-symbols").textContent = nodes.length;
      document.getElementById("stat-calls").textContent = edges.length;
      document.getElementById("stat-layers").textContent = distinctRowCount;
      document.getElementById("stat-most-called").textContent = nodes.filter(n => n.isMostCalled).length;
      document.getElementById("stat-orphans").textContent = nodes.filter(n => n.isOrphan).length;
      document.getElementById("stat-violations").textContent = edges.filter(e => e.isViolation).length;

      posMap = new Map();
      const graphWidth = PADDING_X + (maxRowNodes * NODE_SPACING_X) + 140;

      let currentY = 32;

      for (const sec of sections) {
        const rowMap = grid[sec.id];
        if (rowMap.size === 0) continue;

        let totalSecNodes = 0;
        for (const rowNodes of rowMap.values()) totalSecNodes += rowNodes.length;
        if (totalSecNodes === 0) continue;

        // Section Title Header Banner
        const headerY = currentY;
        const headerText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        headerText.setAttribute("x", 18);
        headerText.setAttribute("y", headerY + 14);
        headerText.setAttribute("fill", sec.color);
        headerText.setAttribute("font-size", "13px");
        headerText.setAttribute("font-weight", "800");
        headerText.setAttribute("letter-spacing", "1.5px");
        headerText.textContent = sec.label + " (" + totalSecNodes + " SYMBOLS)";
        canvas.appendChild(headerText);

        const headerLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        headerLine.setAttribute("x1", 18);
        headerLine.setAttribute("y1", headerY + 24);
        headerLine.setAttribute("x2", graphWidth);
        headerLine.setAttribute("y2", headerY + 24);
        headerLine.setAttribute("stroke", sec.color);
        headerLine.setAttribute("stroke-width", "1.2");
        headerLine.setAttribute("stroke-opacity", "0.35");
        canvas.appendChild(headerLine);

        currentY += 38;

        // Sort connection count keys ascending (0, 1, 2, 3, 4, 5, ...)
        const sortedConns = Array.from(rowMap.keys()).sort((a, b) => a - b);

        for (const connCount of sortedConns) {
          const rowNodes = rowMap.get(connCount) || [];
          if (rowNodes.length === 0) continue;

          // Sort within row by outDegree descending
          rowNodes.sort((a, b) => b.outDegree - a.outDegree);

          const rowHeight = NODE_HEIGHT + 18;
          const rowWidth = PADDING_X + (rowNodes.length * NODE_SPACING_X) + 60;

          const band = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          band.setAttribute("x", 12);
          band.setAttribute("y", currentY);
          band.setAttribute("width", Math.max(graphWidth, rowWidth));
          band.setAttribute("height", rowHeight);
          band.setAttribute("class", "layer-band");
          canvas.appendChild(band);

          // Connection Count Pill Badge on Left
          const badgeWidth = 82;
          const badgeHeight = 24;
          const badgeX = 18;
          const badgeY = currentY + 9;

          const badgeBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          badgeBg.setAttribute("x", badgeX);
          badgeBg.setAttribute("y", badgeY);
          badgeBg.setAttribute("width", badgeWidth);
          badgeBg.setAttribute("height", badgeHeight);
          badgeBg.setAttribute("rx", "5");
          badgeBg.setAttribute("fill", "#0b1120");
          badgeBg.setAttribute("stroke", sec.color);
          badgeBg.setAttribute("stroke-width", "1");
          canvas.appendChild(badgeBg);

          const badgeLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
          badgeLabel.setAttribute("x", badgeX + badgeWidth / 2);
          badgeLabel.setAttribute("y", badgeY + 12);
          badgeLabel.setAttribute("text-anchor", "middle");
          badgeLabel.setAttribute("dominant-baseline", "central");
          badgeLabel.setAttribute("fill", sec.color);
          badgeLabel.setAttribute("font-size", "9px");
          badgeLabel.setAttribute("font-weight", "700");
          badgeLabel.textContent = connCount === 1 ? "1 CONN" : (connCount + " CONNS");
          canvas.appendChild(badgeLabel);

          // Explicitly compute (x, y) for each node in this row
          rowNodes.forEach((n, idx) => {
            const x = PADDING_X + idx * NODE_SPACING_X;
            const y = currentY + 9;
            posMap.set(n.id, { x, y, node: n });
          });

          currentY += rowHeight + 14;
        }

        currentY += 32; // Visual separation gap between Frontend and Backend sections
      }

      // Draw Nodes
      const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      for (const n of nodes) {
        const pos = posMap.get(n.id);
        if (!pos) continue;

        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("class", "node-card");
        g.setAttribute("transform", "translate(" + pos.x + ", " + pos.y + ")");
        g.dataset.id = n.id;

        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("width", NODE_WIDTH);
        rect.setAttribute("height", NODE_HEIGHT);
        rect.setAttribute("fill", "#1e293b");
        rect.setAttribute("stroke", n.color);

        const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
        title.setAttribute("x", 10);
        title.setAttribute("y", 18);
        title.setAttribute("fill", "#f8fafc");
        title.setAttribute("font-size", "11px");
        title.setAttribute("font-weight", "600");
        const titleText = n.name.length > 17 ? n.name.slice(0, 15) + "…" : n.name;
        title.textContent = titleText;

        const subtitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
        subtitle.setAttribute("x", 10);
        subtitle.setAttribute("y", 33);
        subtitle.setAttribute("fill", "#94a3b8");
        subtitle.setAttribute("font-size", "9.5px");
        const locStr = formatLoc(n.file, n.line);
        subtitle.textContent = locStr.length > 20 ? "…" + locStr.slice(-18) : locStr;

        // Incoming and Outgoing Connection Counts Badge on top right
        const countBadge = document.createElementNS("http://www.w3.org/2000/svg", "text");
        countBadge.setAttribute("x", NODE_WIDTH - 8);
        countBadge.setAttribute("y", 18);
        countBadge.setAttribute("text-anchor", "end");
        countBadge.setAttribute("fill", (n.inDegree > 0 || n.outDegree > 0) ? "#38bdf8" : "#64748b");
        countBadge.setAttribute("font-size", "9px");
        countBadge.setAttribute("font-weight", "600");
        countBadge.setAttribute("font-family", "ui-monospace, monospace");
        countBadge.textContent = "↓" + (n.inDegree || 0) + " ↑" + (n.outDegree || 0);

        g.appendChild(rect);
        g.appendChild(title);
        g.appendChild(subtitle);
        g.appendChild(countBadge);

        const tooltip = document.createElementNS("http://www.w3.org/2000/svg", "title");
        tooltip.textContent = n.name + " (" + n.file + ":" + n.line + ")";
        g.appendChild(tooltip);

        g.onclick = (e) => {
          e.stopPropagation();
          selectNode(n);
        };

        nodeElements.set(n.id, g);
        nodeGroup.appendChild(g);
      }
      canvas.appendChild(nodeGroup);

      // Edge layer container — placed AFTER nodeGroup so lines & arrows render on top
      const edgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      edgeGroup.id = "edge-layer";
      canvas.appendChild(edgeGroup);

      scheduleTransform();
      applyFilter();
    }

    function createEdgePathElement(e) {
      const p1 = posMap.get(e.from);
      const p2 = posMap.get(e.to);
      if (!p1 || !p2) return null;

      const idx = e.idx || 0;
      const portOffset1 = 30 + ((idx * 37) % (NODE_WIDTH - 60));
      const portOffset2 = 30 + ((idx * 53) % (NODE_WIDTH - 60));

      const isDownwards = p1.y <= p2.y;
      const x1 = p1.x + portOffset1;
      const y1 = isDownwards ? (p1.y + NODE_HEIGHT) : p1.y;
      const x2 = p2.x + portOffset2;
      const y2 = isDownwards ? p2.y : (p2.y + NODE_HEIGHT);

      const midY = (y1 + y2) / 2;
      const d = "M " + x1 + " " + y1 + " C " + x1 + " " + midY + ", " + x2 + " " + midY + ", " + x2 + " " + y2;

      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "edge-path highlighted" + (e.isViolation ? " violation" : ""));
      path.setAttribute("marker-end", e.isViolation ? "url(#arrow-danger)" : "url(#arrow)");

      const hitbox = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hitbox.setAttribute("d", d);
      hitbox.setAttribute("class", "edge-hitbox highlighted");

      const clickHandler = (evt) => {
        evt.stopPropagation();
        const targetId = evt.shiftKey ? e.from : ((activeSelectedId === e.from) ? e.to : e.from);
        const targetNode = nodeMap.get(targetId);
        if (targetNode) focusNode(targetNode);
      };

      path.onclick = clickHandler;
      hitbox.onclick = clickHandler;

      g.appendChild(path);
      g.appendChild(hitbox);
      return g;
    }

    function selectNode(node) {
      // Toggle off / deselect if already selected
      if (node && activeSelectedId === node.id) {
        node = null;
      }

      const details = document.getElementById("selection-details");

      // Clear previous highlights in O(1)
      for (let i = 0; i < activeHighlighted.length; i++) {
        activeHighlighted[i].classList.remove("highlighted");
      }
      activeHighlighted = [];

      const edgeGroup = document.getElementById("edge-layer");
      if (edgeGroup) edgeGroup.replaceChildren();

      if (!node) {
        activeSelectedId = null;
        svg.classList.remove("has-selection");
        details.innerHTML = '<div style="color: var(--muted); font-size: 12px; margin-top: 10px;">Click any symbol card in the graph to inspect its callers, callees, and layer level.</div>';
        applyFilter();
        return;
      }

      activeSelectedId = node.id;
      svg.classList.add("has-selection");
      const callers = incomingEdgeMap.get(node.id) || [];
      const callees = outgoingEdgeMap.get(node.id) || [];

      // Highlight and unhide selected node
      const selfEl = nodeElements.get(node.id);
      if (selfEl) {
        selfEl.style.display = "block";
        selfEl.classList.add("highlighted");
        activeHighlighted.push(selfEl);
      }

      // Highlight and unhide caller nodes
      for (let i = 0; i < callers.length; i++) {
        const fromEl = nodeElements.get(callers[i].from);
        if (fromEl) {
          fromEl.style.display = "block";
          fromEl.classList.add("highlighted");
          activeHighlighted.push(fromEl);
        }
      }

      // Highlight and unhide callee nodes
      for (let i = 0; i < callees.length; i++) {
        const toEl = nodeElements.get(callees[i].to);
        if (toEl) {
          toEl.style.display = "block";
          toEl.classList.add("highlighted");
          activeHighlighted.push(toEl);
        }
      }

      // Render active edges dynamically
      if (edgeGroup) {
        for (let i = 0; i < callers.length; i++) {
          const el = createEdgePathElement(callers[i]);
          if (el) edgeGroup.appendChild(el);
        }
        for (let i = 0; i < callees.length; i++) {
          const el = createEdgePathElement(callees[i]);
          if (el) edgeGroup.appendChild(el);
        }
      }

      const tierLabels = {
        ui: "Front End (Presentation Components & Pages)",
        hook: "UI Hooks & Client State (use*, stores, context)",
        request: "Client Request / Transport Boundary",
        api: "Backend API Handlers & Controllers (Filter / Entry)",
        service: "Domain & Business Services",
        db: "Data Persistence & Repositories",
        util: "Utilities & Adapters"
      };

      const callerLinks = callers.map(c => {
        const t = nodeMap.get(c.from);
        return t ? '<div class="sidebar-item-link" data-id="' + t.id + '"><span>' + t.name + '</span><span style="color: var(--muted); font-size: 10px;">' + formatLoc(t.file, t.line) + ' ➔</span></div>' : c.from;
      }).join("") || '<div style="color: var(--muted); padding: 4px;">(none - entry point or orphan)</div>';

      const calleeLinks = callees.map(c => {
        const t = nodeMap.get(c.to);
        return t ? '<div class="sidebar-item-link" data-id="' + t.id + '"><span>' + t.name + '</span><span style="color: var(--muted); font-size: 10px;">' + formatLoc(t.file, t.line) + ' ➔</span></div>' : c.to;
      }).join("") || '<div style="color: var(--muted); padding: 4px;">(none - leaf function)</div>';

      const isOrphan = (callers.length === 0 && callees.length === 0);

      details.innerHTML = [
        '<div style="display:flex; justify-content:space-between; align-items:center; background:rgba(56,189,248,0.12); border:1px solid var(--accent); border-radius:6px; padding:6px 10px; margin-bottom:8px;">' +
          '<div style="font-size:11px; font-weight:700; color:var(--accent);">🔍 SELECTED SYMBOL</div>' +
          '<button onclick="window.selectNode(null)" style="background:#1e293b; border:1px solid #334155; color:#94a3b8; font-size:10px; border-radius:4px; padding:2px 6px; cursor:pointer;">✕ Reset</button>' +
        '</div>',
        '<div class="node-detail-field"><div class="node-detail-label">Symbol Name</div><div class="node-detail-val" style="color: ' + node.color + '; font-weight: bold;">' + node.name + '</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Architectural Tier</div><div class="node-detail-val">' + (tierLabels[node.tier] || node.tier) + '</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Location</div><div class="node-detail-val">' + node.file + ':' + node.line + '</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Topological Layer</div><div class="node-detail-val">Level ' + node.layer + '</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Call Connections</div><div class="node-detail-val">' + (isOrphan ? '<span style="color:#fbbf24; font-weight:600;">⚠️ Standalone / Orphan (0 callers, 0 callees)</span>' : ('Incoming: ' + node.inDegree + ' callers | Outgoing: ' + node.outDegree + ' callees')) + '</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Incoming Callers (' + callers.length + ')</div><div class="node-detail-val" style="font-size: 11px; max-height: 140px; overflow-y: auto;">' + callerLinks + '</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Outgoing Calls (' + callees.length + ')</div><div class="node-detail-val" style="font-size: 11px; max-height: 140px; overflow-y: auto;">' + calleeLinks + '</div></div>'
      ].join("");

      details.onclick = (e) => {
        const link = e.target.closest(".sidebar-item-link");
        if (link && link.dataset.id) {
          const target = nodeMap.get(link.dataset.id);
          if (target) focusNode(target);
        }
      };
    }

    window.selectNode = selectNode;

    function getContrastText(hexColor) {
      if (!hexColor || typeof hexColor !== "string") return "#f8fafc";
      const hex = hexColor.replace("#", "");
      const r = parseInt(hex.substring(0, 2), 16) || 0;
      const g = parseInt(hex.substring(2, 4), 16) || 0;
      const b = parseInt(hex.substring(4, 6), 16) || 0;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      return lum > 135 ? "#090d16" : "#f8fafc";
    }

    let activeSelectedHeatmapFile = null;
    let activeSelectedHeatmapModule = null;

    function renderHeatmap() {
      if (!heatmapData) return;
      canvas.innerHTML = "";
      nodeElements.clear();
      svg.classList.remove("has-selection");

      const modules = heatmapData.modules || [];
      const files = heatmapData.files || [];

      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "heatmap-container");

      // Draw 50x50 pure color file heat tiles with module border colors (zero text, zero empty voids)
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", f.x);
        rect.setAttribute("y", f.y);
        rect.setAttribute("width", 50);
        rect.setAttribute("height", 50);
        rect.setAttribute("fill", f.color);
        rect.setAttribute("stroke", f.borderColor || "#38bdf8");
        rect.setAttribute("class", "heatmap-card");
        rect.dataset.file = f.file;
        rect.dataset.module = f.module;

        const tooltip = document.createElementNS("http://www.w3.org/2000/svg", "title");
        tooltip.textContent = f.file + "\\nModule: " + f.module + "\\nCalls: " + f.totalInCalls + "\\nSymbols: " + f.symbols.length + "\\nHeat: " + Math.round(f.heat * 100) + "%";
        rect.appendChild(tooltip);

        rect.onmouseenter = (e) => {
          e.stopPropagation();
          if (!activeSelectedHeatmapFile) {
            renderHeatmapFileDetails(f, false);
          }
        };
        rect.onclick = (e) => {
          e.stopPropagation();
          window.selectHeatmapFile(f);
        };

        g.appendChild(rect);
        nodeElements.set(f.file, rect);
      }

      g.onmouseleave = () => {
        if (activeSelectedHeatmapFile) {
          const lockedFile = (heatmapData?.files || []).find(f => f.file === activeSelectedHeatmapFile);
          if (lockedFile) renderHeatmapFileDetails(lockedFile, true);
        } else {
          renderHeatmapFileDetails(null);
        }
      };

      canvas.appendChild(g);
      centerView("heatmap");
      applyFilter();
    }

    function selectHeatmapModule(mod) {
      if (mod && activeSelectedHeatmapModule === mod.name) {
        mod = null;
      }
      activeSelectedHeatmapModule = mod ? mod.name : null;

      for (let i = 0; i < activeHighlighted.length; i++) {
        activeHighlighted[i].classList.remove("highlighted");
      }
      activeHighlighted = [];

      const details = document.getElementById("selection-details");
      if (!mod) {
        svg.classList.remove("has-selection");
        details.innerHTML = '<div style="color: var(--muted); font-size: 12px; margin-top: 10px;">Hover or click any 50x50 card or module group to inspect its files, call density, and symbols.</div>';
        return;
      }

      svg.classList.add("has-selection");
      const mEl = nodeElements.get("mod:" + mod.name);
      if (mEl) {
        mEl.classList.add("highlighted");
        activeHighlighted.push(mEl);
      }

      const files = (heatmapData?.files || []).filter(f => f.module === mod.name);
      files.forEach(f => {
        const el = nodeElements.get(f.file);
        if (el) {
          el.classList.add("highlighted");
          activeHighlighted.push(el);
        }
      });

      const fileList = files.map(f => {
        return '<div style="display:flex; justify-content:space-between; align-items:center; padding:4px 8px; margin:2px 0; border-radius:4px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05);">' +
          '<span>' + f.file + '</span>' +
          '<span style="display:flex; align-items:center; gap:6px;"><span style="display:inline-block; width:8px; height:8px; border-radius:2px; background:' + f.color + ';"></span><span style="color:var(--accent); font-weight:600;">' + f.totalInCalls + ' calls</span></span>' +
        '</div>';
      }).join("");

      details.innerHTML = [
        '<div class="node-detail-field"><div class="node-detail-label">Module Group</div><div class="node-detail-val" style="color: ' + (mod.borderColor || 'var(--accent)') + '; font-weight: bold;">' + mod.name + '</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Module Metrics</div><div class="node-detail-val">' + mod.fileCount + ' files · ' + mod.symbolCount + ' symbols · ' + mod.totalInCalls + ' total incoming calls</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Contained Files (' + files.length + ')</div><div class="node-detail-val" style="font-size: 11px; max-height: 220px; overflow-y: auto;">' + (fileList || "(none)") + '</div></div>'
      ].join("");
    }

    function renderHeatmapFileDetails(fileData, isLocked = false) {
      const details = document.getElementById("selection-details");

      for (let i = 0; i < activeHighlighted.length; i++) {
        activeHighlighted[i].classList.remove("highlighted");
      }
      activeHighlighted = [];

      if (!fileData) {
        svg.classList.remove("has-selection");
        details.innerHTML = '<div style="color: var(--muted); font-size: 12px; margin-top: 10px;">Hover or click any 50x50 card or module group to inspect its files, call density, and symbols.</div>';
        return;
      }

      svg.classList.add("has-selection");
      const selfEl = nodeElements.get(fileData.file);
      if (selfEl) {
        selfEl.classList.add("highlighted");
        activeHighlighted.push(selfEl);
      }

      const siblingFiles = (heatmapData?.files || []).filter(f => f.module === fileData.module && f.file !== fileData.file);
      siblingFiles.forEach(sf => {
        const el = nodeElements.get(sf.file);
        if (el) {
          el.classList.add("highlighted");
          activeHighlighted.push(el);
        }
      });

      const symList = (fileData.symbols || []).map(s => {
        return '<div style="display:flex; justify-content:space-between; align-items:center; padding:5px 8px; margin:2px 0; border-radius:4px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05);">' +
          '<span>' + s.name + (s.line ? ' <span style="color:var(--muted); font-size:10px;">:' + s.line + '</span>' : '') + '</span>' +
          '<span style="display:flex; align-items:center; gap:6px;"><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:' + fileData.color + ';"></span><span style="color:var(--accent); font-weight:600;">' + (s.inDegree || 0) + ' calls</span></span>' +
        '</div>';
      }).join("");

      const fields = [];
      if (isLocked) {
        fields.push(
          '<div style="display:flex; justify-content:space-between; align-items:center; background:rgba(56,189,248,0.12); border:1px solid var(--accent); border-radius:6px; padding:6px 10px; margin-bottom:8px;">' +
            '<div style="font-size:11px; font-weight:700; color:var(--accent);">🔍 LOCKED SELECTION</div>' +
            '<button onclick="window.selectHeatmapFile(null)" style="background:#1e293b; border:1px solid #334155; color:#94a3b8; font-size:10px; border-radius:4px; padding:2px 6px; cursor:pointer;">✕ Reset</button>' +
          '</div>'
        );
      }

      fields.push(
        '<div class="node-detail-field"><div class="node-detail-label">File</div><div class="node-detail-val" style="color: ' + fileData.color + '; font-weight: bold;">' + fileData.file + '</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Module Directory</div><div class="node-detail-val">' + fileData.module + '</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Heat Density</div><div class="node-detail-val" style="display:flex; align-items:center; gap:8px;"><span style="display:inline-block; width:12px; height:12px; border-radius:3px; background:' + fileData.color + ';"></span><span>' + Math.round(fileData.heat * 100) + '% (' + fileData.totalInCalls + ' incoming calls)</span></div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Declared Functions (' + (fileData.symbols?.length || 0) + ')</div><div class="node-detail-val" style="font-size: 11px; max-height: 200px; overflow-y: auto;">' + (symList || "(none)") + '</div></div>'
      );

      details.innerHTML = fields.join("");
    }

    window.selectHeatmapFile = function(fileData) {
      if (!fileData || activeSelectedHeatmapFile === fileData.file) {
        activeSelectedHeatmapFile = null;
        renderHeatmapFileDetails(null);
      } else {
        activeSelectedHeatmapFile = fileData.file;
        renderHeatmapFileDetails(fileData, true);
      }
    };

    function renderSunburst() {
      if (!sunburstData) return;
      canvas.innerHTML = "";
      nodeElements.clear();
      svg.classList.remove("has-selection");

      const nodes = sunburstData.nodes || [];
      const sunburstNodeMap = new Map(nodes.map(n => [n.id, n]));
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "sunburst-container");

      const frag = document.createDocumentFragment();

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", node.d);
        path.setAttribute("fill", node.color);
        path.setAttribute("class", "sunburst-arc");
        path.dataset.id = node.id;

        nodeElements.set(node.id, path);
        frag.appendChild(path);

        if (node.depth === 0) {
          const rootText = document.createElementNS("http://www.w3.org/2000/svg", "text");
          rootText.setAttribute("x", sunburstData.cx || 500);
          rootText.setAttribute("y", sunburstData.cy || 500);
          rootText.setAttribute("text-anchor", "middle");
          rootText.setAttribute("dominant-baseline", "central");
          rootText.setAttribute("fill", "#f8fafc");
          rootText.setAttribute("font-size", "12px");
          rootText.setAttribute("font-weight", "800");
          rootText.setAttribute("pointer-events", "none");
          rootText.textContent = (sunburstData.project?.name || "Codebase");
          frag.appendChild(rootText);
        }
      }

      // Zone highlight overlay spanning full radius
      const zoneOverlay = document.createElementNS("http://www.w3.org/2000/svg", "path");
      zoneOverlay.setAttribute("id", "sunburst-zone-overlay");
      zoneOverlay.setAttribute("fill", "none");
      zoneOverlay.setAttribute("stroke", "#ffffff");
      zoneOverlay.setAttribute("stroke-width", "3.5");
      zoneOverlay.setAttribute("stroke-linecap", "round");
      zoneOverlay.setAttribute("stroke-linejoin", "round");
      zoneOverlay.setAttribute("style", "pointer-events: none; opacity: 0; filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.95)); transition: opacity 0.15s ease;");
      frag.appendChild(zoneOverlay);

      g.appendChild(frag);

      let hoveredArcElements = [];

      function describeArc(cx, cy, r0, r1, a0, a1) {
        const isFull = Math.abs(a1 - a0) >= 2 * Math.PI - 0.0001;
        if (isFull) a1 = a0 + 2 * Math.PI - 0.0001;
        const x0a = cx + r1 * Math.cos(a0);
        const y0a = cy + r1 * Math.sin(a0);
        const x1a = cx + r1 * Math.cos(a1);
        const y1a = cy + r1 * Math.sin(a1);
        const largeArc = a1 - a0 > Math.PI ? 1 : 0;
        if (r0 <= 0.001) {
          return "M " + cx + " " + cy + " L " + x0a + " " + y0a + " A " + r1 + " " + r1 + " 0 " + largeArc + " 1 " + x1a + " " + y1a + " Z";
        }
        const x0b = cx + r0 * Math.cos(a1);
        const y0b = cy + r0 * Math.sin(a1);
        const x1b = cx + r0 * Math.cos(a0);
        const y1b = cy + r0 * Math.sin(a0);
        return "M " + x0a + " " + y0a + " A " + r1 + " " + r1 + " 0 " + largeArc + " 1 " + x1a + " " + y1a + " L " + x0b + " " + y0b + " A " + r0 + " " + r0 + " 0 " + largeArc + " 0 " + x1b + " " + y1b + " Z";
      }

      function isNodeInSelectedZone(target) {
        if (!activeSelectedSunburstId) return true;
        const sel = sunburstNodeMap.get(activeSelectedSunburstId);
        if (!sel || !target) return false;
        if (target.id === sel.id) return true;
        if (sel.type === "directory" || sel.type === "module") {
          const p = sel.fullPath || sel.name;
          return (target.fullPath && (target.fullPath === p || target.fullPath.startsWith(p + "/"))) ||
                 (target.module && (target.module === p || target.module.startsWith(p + "/"))) ||
                 (target.file && target.file.startsWith(p + "/"));
        }
        if (sel.type === "file") {
          return target.fullPath === sel.fullPath || target.file === sel.fullPath;
        }
        if (sel.type === "symbol") {
          return target.id === sel.id || target.id === ("file:" + sel.file);
        }
        return false;
      }

      function clearSunburstHover() {
        for (let i = 0; i < hoveredArcElements.length; i++) {
          hoveredArcElements[i].classList.remove("hovered");
        }
        hoveredArcElements = [];
        if (activeSelectedSunburstId) {
          const selNode = sunburstNodeMap.get(activeSelectedSunburstId);
          if (selNode) renderSunburstDetails(selNode);
        } else {
          const details = document.getElementById("selection-details");
          details.innerHTML = '<div style="color: var(--muted); font-size: 12px; margin-top: 10px;">Hover or click any radial arc segment in the sunburst chart to inspect its hierarchy and call metrics.</div>';
        }
      }

      function highlightSunburstHover(node) {
        if (!node) return;
        if (activeSelectedSunburstId && !isNodeInSelectedZone(node)) return;

        clearSunburstHover();

        const el = nodeElements.get(node.id);
        if (el) {
          el.classList.add("hovered");
          hoveredArcElements.push(el);
        }

        renderSunburstDetails(node);
      }

      function renderSunburstDetails(node) {
        if (!node) return;
        const details = document.getElementById("selection-details");
        const nodes = sunburstData?.nodes || [];

        let breadcrumbs = "Codebase Root";
        let containedItemsHtml = "";

        if (node.depth === 0) {
          breadcrumbs = "🌐 " + (sunburstData?.project?.name || "Codebase Root");
        } else if (node.type === "symbol") {
          const modTrail = node.module ? node.module.split("/").join(" ➔ ") + " ➔ " : "";
          const fileBase = node.file ? node.file.split("/").pop() + " ➔ " : "";
          breadcrumbs = "📁 " + modTrail + "📄 " + fileBase + "⚡ " + node.name;
        } else if (node.type === "file") {
          const modTrail = node.module ? node.module.split("/").join(" ➔ ") + " ➔ " : "";
          breadcrumbs = "📁 " + modTrail + "📄 " + node.name;
          const syms = nodes.filter(n => n.type === "symbol" && (n.file === node.fullPath || n.file === node.name));
          if (syms.length > 0) {
            containedItemsHtml = '<div class="node-detail-field"><div class="node-detail-label">Declared Functions (' + syms.length + ')</div><div class="node-detail-val" style="font-size: 11px; max-height: 180px; overflow-y: auto;">' +
              syms.map(s => '<div style="display:flex; justify-content:space-between; padding:3px 6px; margin:2px 0; border-radius:4px; background:rgba(255,255,255,0.03);">' +
                '<span>⚡ ' + s.name + (s.line ? ' <span style="color:var(--muted); font-size:10px;">:' + s.line + '</span>' : '') + '</span>' +
                '<span style="color:var(--accent); font-weight:600;">' + (s.calls || 0) + ' calls</span>' +
              '</div>').join("") +
            '</div></div>';
          }
        } else if (node.type === "directory" || node.type === "module") {
          const dirTrail = (node.fullPath || node.name).split("/").join(" ➔ ");
          breadcrumbs = "📁 " + dirTrail;
          const childFiles = nodes.filter(n => n.type === "file" && n.fullPath && n.fullPath.startsWith((node.fullPath || node.name) + "/"));
          const childSyms = nodes.filter(n => n.type === "symbol" && n.file && n.file.startsWith((node.fullPath || node.name) + "/"));
          if (childFiles.length > 0) {
            containedItemsHtml = '<div class="node-detail-field"><div class="node-detail-label">Contained Files (' + childFiles.length + ') & Symbols (' + childSyms.length + ')</div><div class="node-detail-val" style="font-size: 11px; max-height: 180px; overflow-y: auto;">' +
              childFiles.slice(0, 30).map(f => '<div style="display:flex; justify-content:space-between; padding:3px 6px; margin:2px 0; border-radius:4px; background:rgba(255,255,255,0.03);">' +
                '<span>📄 ' + f.name + '</span>' +
                '<span style="color:var(--accent); font-weight:600;">' + (f.calls || 0) + ' calls</span>' +
              '</div>').join("") +
              (childFiles.length > 30 ? '<div style="color:var(--muted); text-align:center; padding:4px;">+' + (childFiles.length - 30) + ' more files</div>' : '') +
            '</div></div>';
          }
        }

        const typeLabel = node.depth === 0
          ? "CODEBASE ROOT"
          : (node.type === "directory" ? "DIRECTORY" : (node.type === "module" ? "MODULE" : (node.type === "file" ? "FILE" : (node.type === "group" ? "SYMBOL GROUP" : "FUNCTION / SYMBOL"))));
        const fields = [];

        if (activeSelectedSunburstId) {
          fields.push(
            '<div style="display:flex; justify-content:space-between; align-items:center; background:rgba(56,189,248,0.12); border:1px solid var(--accent); border-radius:6px; padding:6px 10px; margin-bottom:8px;">' +
              '<div style="font-size:11px; font-weight:700; color:var(--accent);">🔍 FILTERED SELECTION</div>' +
              '<button onclick="window.selectSunburstNode(null)" style="background:#1e293b; border:1px solid #334155; color:#94a3b8; font-size:10px; border-radius:4px; padding:2px 6px; cursor:pointer;">✕ Reset</button>' +
            '</div>'
          );
        }

        fields.push('<div class="node-detail-field"><div class="node-detail-label">Hierarchy Trail</div><div class="node-detail-val" style="color: #cbd5e1; font-size: 11px;">' + breadcrumbs + '</div></div>');
        fields.push('<div class="node-detail-field"><div class="node-detail-label">Name</div><div class="node-detail-val" style="color: ' + (node.color || 'var(--accent)') + '; font-weight: bold;">' + node.name + '</div></div>');
        fields.push('<div class="node-detail-field"><div class="node-detail-label">Type</div><div class="node-detail-val">' + typeLabel + '</div></div>');

        if (node.fullPath) {
          fields.push('<div class="node-detail-field"><div class="node-detail-label">Path</div><div class="node-detail-val">' + node.fullPath + '</div></div>');
        } else if (node.file) {
          fields.push('<div class="node-detail-field"><div class="node-detail-label">File Location</div><div class="node-detail-val">' + node.file + (node.line ? ':' + node.line : '') + '</div></div>');
        }

        if (node.module) {
          fields.push('<div class="node-detail-field"><div class="node-detail-label">Parent Directory</div><div class="node-detail-val">' + node.module + '</div></div>');
        }

        if (node.depth === 0) {
          if (node.modulesCount) fields.push('<div class="node-detail-field"><div class="node-detail-label">Total Modules</div><div class="node-detail-val">' + node.modulesCount + ' modules</div></div>');
          if (node.filesCount) fields.push('<div class="node-detail-field"><div class="node-detail-label">Total Files</div><div class="node-detail-val">' + node.filesCount + ' files</div></div>');
          if (node.symbolsCount) fields.push('<div class="node-detail-field"><div class="node-detail-label">Total Symbols</div><div class="node-detail-val">' + node.symbolsCount + ' functions / components</div></div>');
          fields.push('<div class="node-detail-field"><div class="node-detail-label">Codebase Call Volume</div><div class="node-detail-val">' + (node.calls || 0) + ' incoming calls across entire project</div></div>');
        } else if (node.depth === 1) {
          if (node.filesCount) fields.push('<div class="node-detail-field"><div class="node-detail-label">Contained Files</div><div class="node-detail-val">' + node.filesCount + ' files</div></div>');
          if (node.symbolsCount) fields.push('<div class="node-detail-field"><div class="node-detail-label">Contained Symbols</div><div class="node-detail-val">' + node.symbolsCount + ' functions / methods</div></div>');
          fields.push('<div class="node-detail-field"><div class="node-detail-label">Module Call Volume</div><div class="node-detail-val">' + (node.calls || 0) + ' incoming calls (sum of all files in this module)</div></div>');
        } else if (node.depth === 2) {
          if (node.symbolsCount) fields.push('<div class="node-detail-field"><div class="node-detail-label">Declared Symbols</div><div class="node-detail-val">' + node.symbolsCount + ' functions / methods</div></div>');
          fields.push('<div class="node-detail-field"><div class="node-detail-label">File Call Volume</div><div class="node-detail-val">' + (node.calls || 0) + ' incoming calls (sum of all functions in this file)</div></div>');
        } else {
          fields.push('<div class="node-detail-field"><div class="node-detail-label">Incoming Calls</div><div class="node-detail-val">' + (node.calls || 0) + ' caller' + (node.calls === 1 ? '' : 's') + ' invoke this ' + (node.type === 'group' ? 'group' : 'function') + '</div></div>');
        }

        if (containedItemsHtml) {
          fields.push(containedItemsHtml);
        }

        details.innerHTML = fields.join("");
      }

      let lastHoveredId = null;
      g.onmousemove = (e) => {
        if (isMouseDown) return;
        const arc = e.target.closest(".sunburst-arc");
        const id = arc?.dataset?.id;
        if (id === lastHoveredId) return;
        lastHoveredId = id;
        if (id) {
          const target = sunburstNodeMap.get(id);
          if (target && isNodeInSelectedZone(target)) {
            highlightSunburstHover(target);
          } else {
            clearSunburstHover();
          }
        } else {
          clearSunburstHover();
        }
      };

      g.onmouseleave = () => {
        lastHoveredId = null;
        clearSunburstHover();
      };

      g.onclick = (e) => {
        const arc = e.target.closest(".sunburst-arc");
        if (arc && arc.dataset.id) {
          e.stopPropagation();
          const target = sunburstNodeMap.get(arc.dataset.id);
          if (target) selectSunburstNode(target);
        }
      };

      canvas.appendChild(g);
      centerView("sunburst");
      applyFilter();
    }

    function selectSunburstNode(node) {
      if (node && activeSelectedSunburstId === node.id) {
        node = null;
      }
      activeSelectedSunburstId = node ? node.id : null;

      for (let i = 0; i < activeHighlighted.length; i++) {
        activeHighlighted[i].classList.remove("highlighted");
        activeHighlighted[i].classList.remove("active-branch");
      }
      activeHighlighted = [];

      const zoneEl = document.getElementById("sunburst-zone-overlay");
      const details = document.getElementById("selection-details");
      if (!node) {
        svg.classList.remove("has-selection");
        if (zoneEl) zoneEl.style.opacity = "0";
        details.innerHTML = '<div style="color: var(--muted); font-size: 12px; margin-top: 10px;">Hover or click any radial arc segment in the sunburst chart to inspect its hierarchy and call metrics.</div>';
        return;
      }

      svg.classList.add("has-selection");
      if (zoneEl && typeof node.a0 === "number" && typeof node.a1 === "number") {
        const cx = sunburstData.cx || 500;
        const cy = sunburstData.cy || 500;
        const r0 = (node.depth === 0 ? 0 : 95);
        const r1 = 425;
        const isFull = Math.abs(node.a1 - node.a0) >= 2 * Math.PI - 0.0001;
        const a1 = isFull ? (node.a0 + 2 * Math.PI - 0.0001) : node.a1;
        const x0a = cx + r1 * Math.cos(node.a0);
        const y0a = cy + r1 * Math.sin(node.a0);
        const x1a = cx + r1 * Math.cos(a1);
        const y1a = cy + r1 * Math.sin(a1);
        const largeArc = a1 - node.a0 > Math.PI ? 1 : 0;
        let d = "";
        if (r0 <= 0.001) {
          d = "M " + cx + " " + cy + " L " + x0a + " " + y0a + " A " + r1 + " " + r1 + " 0 " + largeArc + " 1 " + x1a + " " + y1a + " Z";
        } else {
          const x0b = cx + r0 * Math.cos(a1);
          const y0b = cy + r0 * Math.sin(a1);
          const x1b = cx + r0 * Math.cos(node.a0);
          const y1b = cy + r0 * Math.sin(node.a0);
          d = "M " + x0a + " " + y0a + " A " + r1 + " " + r1 + " 0 " + largeArc + " 1 " + x1a + " " + y1a + " L " + x0b + " " + y0b + " A " + r0 + " " + r0 + " 0 " + largeArc + " 0 " + x1b + " " + y1b + " Z";
        }
        zoneEl.setAttribute("d", d);
        zoneEl.style.opacity = "1";
      }

      const el = nodeElements.get(node.id);
      if (el) {
        el.classList.add("active-branch");
        activeHighlighted.push(el);
      }

      const nodes = sunburstData?.nodes || [];
      if (node.type === "symbol") {
        if (node.file) {
          const fEl = nodeElements.get("file:" + node.file);
          if (fEl) { fEl.classList.add("active-branch"); activeHighlighted.push(fEl); }
        }
        if (node.module) {
          const mEl = nodeElements.get("mod:" + node.module);
          if (mEl) { mEl.classList.add("active-branch"); activeHighlighted.push(mEl); }
        }
      } else if (node.type === "file") {
        if (node.module) {
          const mEl = nodeElements.get("mod:" + node.module);
          if (mEl) { mEl.classList.add("active-branch"); activeHighlighted.push(mEl); }
        }
        const syms = nodes.filter(n => n.type === "symbol" && (n.file === node.fullPath || n.file === node.name));
        syms.forEach(sn => {
          const sEl = nodeElements.get(sn.id);
          if (sEl) { sEl.classList.add("active-branch"); activeHighlighted.push(sEl); }
        });
      } else if (node.type === "module") {
        nodes.filter(n => n.module === node.name).forEach(cn => {
          const cEl = nodeElements.get(cn.id);
          if (cEl) { cEl.classList.add("active-branch"); activeHighlighted.push(cEl); }
        });
      }

      renderSunburstDetails(node);
    }
    window.selectSunburstNode = selectSunburstNode;

    function renderChord() {
      if (!chordData) return;
      canvas.innerHTML = "";
      nodeElements.clear();
      svg.classList.remove("has-selection");

      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "chord-container");

      const ribbonGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      ribbonGroup.setAttribute("class", "chord-ribbons");

      const chordLabels = new Map();
      const chords = chordData.chords || [];
      chords.forEach(c => {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", c.d);
        path.setAttribute("fill", c.color);
        path.setAttribute("class", "chord-ribbon");
        path.dataset.source = c.source;
        path.dataset.target = c.target;

        const tooltip = document.createElementNS("http://www.w3.org/2000/svg", "title");
        tooltip.textContent = c.source + " ⇄ " + c.target + ": " + c.calls + " calls";
        path.appendChild(tooltip);

        path.onmouseenter = () => {
          path.classList.add("hovered");
          const sLabel = chordLabels.get(c.source);
          if (sLabel) sLabel.classList.add("hovered");
          const tLabel = chordLabels.get(c.target);
          if (tLabel) tLabel.classList.add("hovered");
        };
        path.onmouseleave = () => {
          path.classList.remove("hovered");
          const sLabel = chordLabels.get(c.source);
          if (sLabel) sLabel.classList.remove("hovered");
          const tLabel = chordLabels.get(c.target);
          if (tLabel) tLabel.classList.remove("hovered");
        };

        path.onclick = (e) => {
          e.stopPropagation();
          selectChordModule({ name: c.source });
        };

        ribbonGroup.appendChild(path);
      });
      g.appendChild(ribbonGroup);

      const arcGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      arcGroup.setAttribute("class", "chord-arcs");

      const modules = chordData.modules || [];
      for (let i = 0; i < modules.length; i++) {
        const mod = modules[i];
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", mod.d);
        path.setAttribute("fill", mod.color);
        path.setAttribute("class", "chord-arc");
        path.dataset.name = mod.name;

        const tooltip = document.createElementNS("http://www.w3.org/2000/svg", "title");
        tooltip.textContent = mod.name + " (" + mod.totalCalls + " interaction calls)";
        path.appendChild(tooltip);

        const midAngle = (mod.a0 + mod.a1) / 2;
        const labelR = (chordData.radius || 360) + 16;
        const lx = (chordData.cx || 500) + labelR * Math.cos(midAngle);
        const ly = (chordData.cy || 500) + labelR * Math.sin(midAngle);
        const isRightSide = Math.cos(midAngle) >= 0;

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", lx);
        text.setAttribute("y", ly);
        text.setAttribute("text-anchor", isRightSide ? "start" : "end");
        text.setAttribute("dominant-baseline", "central");
        text.setAttribute("fill", mod.color);
        text.setAttribute("class", "chord-label");
        text.textContent = mod.name;

        chordLabels.set(mod.name, text);
        arcGroup.appendChild(text);

        path.onmouseenter = () => {
          text.classList.add("hovered");
          const connected = (chordData.chords || []).filter(c => c.source === mod.name || c.target === mod.name);
          connected.forEach(c => {
            const other = c.source === mod.name ? c.target : c.source;
            const oLabel = chordLabels.get(other);
            if (oLabel) oLabel.classList.add("hovered");
          });
        };
        path.onmouseleave = () => {
          text.classList.remove("hovered");
          const connected = (chordData.chords || []).filter(c => c.source === mod.name || c.target === mod.name);
          connected.forEach(c => {
            const other = c.source === mod.name ? c.target : c.source;
            const oLabel = chordLabels.get(other);
            if (oLabel) oLabel.classList.remove("hovered");
          });
        };

        path.onclick = (e) => {
          e.stopPropagation();
          selectChordModule(mod);
        };

        arcGroup.appendChild(path);
        nodeElements.set(mod.name, path);
      }

      g.appendChild(arcGroup);
      canvas.appendChild(g);
      centerView("chord");
      applyFilter();
    }

    function selectChordModule(mod) {
      if (mod && activeSelectedChordModule === mod.name) {
        mod = null;
      }
      activeSelectedChordModule = mod ? mod.name : null;

      for (let i = 0; i < activeHighlighted.length; i++) {
        activeHighlighted[i].classList.remove("highlighted");
      }
      activeHighlighted = [];

      const details = document.getElementById("selection-details");
      if (!mod) {
        svg.classList.remove("has-selection");
        details.innerHTML = '<div style="color: var(--muted); font-size: 12px; margin-top: 10px;">Click any module arc on the circular perimeter to highlight its cross-package couplings.</div>';
        return;
      }

      svg.classList.add("has-selection");
      const arcEl = nodeElements.get(mod.name);
      if (arcEl) {
        arcEl.classList.add("highlighted");
        activeHighlighted.push(arcEl);
      }

      const allLabels = document.querySelectorAll(".chord-label");
      const allRibbons = document.querySelectorAll(".chord-ribbon");
      allLabels.forEach(l => {
        if (l.textContent === mod.name) {
          l.classList.add("highlighted");
          activeHighlighted.push(l);
        }
      });

      const connectedChords = (chordData.chords || []).filter(c => c.source === mod.name || c.target === mod.name);
      allRibbons.forEach(r => {
        if (r.dataset.source === mod.name || r.dataset.target === mod.name) {
          r.classList.add("highlighted");
          activeHighlighted.push(r);
        }
      });

      const partnerMap = new Map();
      connectedChords.forEach(c => {
        const other = c.source === mod.name ? c.target : c.source;
        partnerMap.set(other, (partnerMap.get(other) || 0) + c.calls);
      });

      partnerMap.forEach((_, pName) => {
        allLabels.forEach(l => {
          if (l.textContent === pName) {
            l.classList.add("highlighted");
            activeHighlighted.push(l);
          }
        });
      });

      const partnerList = [...partnerMap.entries()].sort((a, b) => b[1] - a[1]).map(([p, calls]) => {
        return '<div style="display:flex; justify-content:space-between; align-items:center; padding:5px 8px; margin:2px 0; border-radius:4px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05);">' +
          '<span>' + p + '</span>' +
          '<span style="color:var(--accent); font-weight:600;">' + calls + ' calls</span>' +
        '</div>';
      }).join("");

      details.innerHTML = [
        '<div class="node-detail-field"><div class="node-detail-label">Module Name</div><div class="node-detail-val" style="color: ' + (mod.color || 'var(--accent)') + '; font-weight: bold;">' + mod.name + '</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Connected Interactions</div><div class="node-detail-val">' + connectedChords.length + ' chords (' + (mod.totalCalls || connectedChords.reduce((a, c) => a + c.calls, 0)) + ' total calls)</div></div>',
        '<div class="node-detail-field"><div class="node-detail-label">Coupled Modules (' + partnerMap.size + ')</div><div class="node-detail-val" style="font-size: 11px; max-height: 200px; overflow-y: auto;">' + (partnerList || "(none)") + '</div></div>'
      ].join("");
    }

    document.querySelectorAll(".filter-btn").forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentFilter = btn.dataset.filter;
        applyFilter();
      };
    });

    function applyFilter() {
      const query = document.getElementById("search-input").value.trim().toLowerCase();

      if (currentView === "sunburst") {
        if (!sunburstData) return;
        const nodes = sunburstData.nodes || [];
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const el = nodeElements.get(n.id);
          if (!el) continue;
          let visible = true;
          if (currentFilter === "most-called") visible = !!n.isMostCalled;
          else if (currentFilter === "orphans") visible = !!n.isOrphan;
          else if (currentFilter === "violations") visible = !!n.hasViolation;

          if (visible && query) {
            const nameMatch = n.name && n.name.toLowerCase().includes(query);
            const pathMatch = n.fullPath && n.fullPath.toLowerCase().includes(query);
            const modMatch = n.module && n.module.toLowerCase().includes(query);
            const fileMatch = n.file && n.file.toLowerCase().includes(query);
            visible = !!(nameMatch || pathMatch || modMatch || fileMatch);
          }

          if (currentFilter !== "all" || query) {
            el.style.opacity = visible ? "1" : "0.06";
          } else {
            el.style.opacity = "";
          }
        }
        return;
      }

      if (currentView === "chord") {
        if (!chordData) return;
        const modules = chordData.modules || [];
        const chords = chordData.chords || [];
        const ribbons = document.querySelectorAll(".chord-ribbon");
        const labels = document.querySelectorAll(".chord-label");

        for (let i = 0; i < modules.length; i++) {
          const m = modules[i];
          const el = nodeElements.get(m.name);
          if (!el) continue;

          let match = true;
          if (currentFilter === "most-called") match = !!m.isMostCalled;
          else if (currentFilter === "orphans") match = !!m.isOrphan;
          else if (currentFilter === "violations") match = !!m.hasViolation;

          if (match && query) match = m.name.toLowerCase().includes(query);

          el.style.opacity = match ? "1" : "0.08";
        }

        ribbons.forEach(r => {
          const s = r.dataset.source;
          const t = r.dataset.target;
          let match = true;
          if (currentFilter === "most-called") {
            const sm = modules.find(m => m.name === s);
            const tm = modules.find(m => m.name === t);
            match = !!(sm?.isMostCalled || tm?.isMostCalled);
          } else if (currentFilter === "orphans") {
            match = false;
          } else if (currentFilter === "violations") {
            const chord = chords.find(c => (c.source === s && c.target === t) || (c.source === t && c.target === s));
            match = !!chord?.isViolation;
          }

          if (match && query) {
            match = s.toLowerCase().includes(query) || t.toLowerCase().includes(query);
          }

          r.style.opacity = match ? (currentFilter === "all" && !query ? "0.45" : "0.9") : "0.02";
        });

        if (currentFilter !== "all" || query) {
          labels.forEach(l => {
            const m = modules.find(mod => mod.name === l.textContent);
            let match = false;
            if (m) {
              if (currentFilter === "most-called") match = !!m.isMostCalled;
              else if (currentFilter === "orphans") match = !!m.isOrphan;
              else if (currentFilter === "violations") match = !!m.hasViolation;
              else if (query) match = m.name.toLowerCase().includes(query);
            }
            l.style.opacity = match ? "1" : "0";
          });
        } else if (!document.querySelector(".chord-arc.highlighted")) {
          labels.forEach(l => { l.style.opacity = "0"; });
        }
        return;
      }

      if (currentView === "heatmap") {
        if (!heatmapData) return;
        const files = heatmapData.files || [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const el = nodeElements.get(f.file);
          if (!el) continue;
          let visible = true;
          if (currentFilter === "most-called") visible = !!f.isMostCalled;
          else if (currentFilter === "orphans") visible = !!f.isOrphan;
          else if (currentFilter === "violations") visible = !!f.hasViolation;

          if (visible && query) {
            visible = f.file.toLowerCase().includes(query) || f.module.toLowerCase().includes(query);
          }
          if (currentFilter !== "all" || query) {
            el.style.opacity = visible ? "1" : "0.06";
          } else {
            el.style.opacity = "";
          }
        }
        return;
      }

      if (!graphData) return;
      const nodes = graphData.nodes || [];
      const edges = graphData.edges || [];
      const visibleNodeIds = new Set();

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const el = nodeElements.get(node.id);
        if (!el) continue;

        let visible = true;
        if (currentFilter === "most-called") visible = !!node.isMostCalled;
        else if (currentFilter === "orphans") visible = !!node.isOrphan;
        else if (currentFilter === "violations") visible = violationNodeIds.has(node.id);

        if (visible && query) {
          visible = node.nameLower.includes(query) || node.fileLower.includes(query);
        }

        if (activeSelectedId) {
          const isSelected = (node.id === activeSelectedId);
          const isConnected = (incomingEdgeMap.get(activeSelectedId) || []).some(e => e.from === node.id) ||
                            (outgoingEdgeMap.get(activeSelectedId) || []).some(e => e.to === node.id);
          if (isSelected || isConnected) {
            visible = true;
          }
        }

        el.style.display = visible ? "block" : "none";
        if (visible) {
          visibleNodeIds.add(node.id);
        }
      }

      const edgeGroup = document.getElementById("edge-layer");
      if (edgeGroup && !activeSelectedId) {
        edgeGroup.replaceChildren();
        if (currentFilter === "violations") {
          for (let i = 0; i < edges.length; i++) {
            if (edges[i].isViolation && visibleNodeIds.has(edges[i].from) && visibleNodeIds.has(edges[i].to)) {
              const el = createEdgePathElement(edges[i]);
              if (el) edgeGroup.appendChild(el);
            }
          }
        }
      }
    }

    document.getElementById("search-input").addEventListener("input", applyFilter);
  </script>
</body>
</html>`

export function createVisualizerServer(rootPath = root, options = {}) {
  const queryStreamFn = options.streamQuery ?? streamQuery
  const sseClients = new Set()

  let inFlightGraphQuery = null
  let cachedRawGraph = null

  function fetchRawGraph(forceFresh = false) {
    if (cachedRawGraph && !forceFresh) return Promise.resolve(cachedRawGraph)
    if (inFlightGraphQuery) return inFlightGraphQuery
    inFlightGraphQuery = (async () => {
      let rawGraph = { symbols: [], edges: [] }
      for await (const row of queryStreamFn(rootPath, { type: 'graph' })) {
        rawGraph = row
      }
      cachedRawGraph = rawGraph
      return rawGraph
    })().finally(() => {
      inFlightGraphQuery = null
    })
    return inFlightGraphQuery
  }

  const resolvedRoot = (() => {
    try { return fs.realpathSync(rootPath) } catch { return path.resolve(rootPath) }
  })()
  const codegraphDir = path.join(resolvedRoot, '.codegraph')
  const debounceMs = options.debounceMs ?? 1500
  let debounceTimer = null
  let isDebouncing = false

  function broadcast(data) {
    const payload = 'data: ' + JSON.stringify(data) + '\n\n'
    for (const client of sseClients) {
      try { client.write(payload) } catch {}
    }
  }

  function handleFileChange(eventType, filepath) {
    const filename = filepath ? path.basename(filepath) : 'CURRENT'
    if (!isDebouncing) {
      isDebouncing = true
      console.log(`[CodeGraph Server] Code changes detected (${filename}) — debouncing (state: indexing)`)
      broadcast({ status: 'indexing' })
    }
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      isDebouncing = false
      cachedRawGraph = null
      console.log(`[CodeGraph Server] Code changes settled (${debounceMs}ms) — invalidated graph cache, broadcast (state: ready)`)
      broadcast({ status: 'ready' })
    }, debounceMs)
  }

  let watcher = null
  try {
    const currentFile = path.join(codegraphDir, 'CURRENT')
    const watchPaths = [currentFile, codegraphDir, resolvedRoot]
    watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      persistent: true,
      dot: true,
      usePolling: options.usePolling ?? false,
      ignored: (candidate) => {
        const p = candidate.split(path.sep).join('/')
        if (p.includes('/node_modules/') || p.includes('/.git/') || p.includes('/dist/') || p.includes('/build/') || p.includes('/coverage/')) return true
        if (p.endsWith('/node_modules') || p.endsWith('/.git') || p.endsWith('/dist') || p.endsWith('/build') || p.endsWith('/coverage')) return true
        if (p.includes('/.codegraph/generations') || p.includes('/.codegraph/partitions') || p.includes('/.codegraph/overlays')) return true
        if (p.endsWith('.tmp') || p.includes('.tmp.') || p.includes('query-view-cache.bin')) return true
        return false
      }
    })
    watcher.on('all', (evt, file) => {
      const base = path.basename(file)
      const ext = path.extname(file).toLowerCase()
      const isCurrent = base === 'CURRENT'
      const isSource = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)
      if (isCurrent || isSource) {
        handleFileChange(evt, file)
      }
    })
    console.log(`[CodeGraph Server] Watching for code & index changes in: ${resolvedRoot}`)
  } catch (err) {
    console.warn(`[CodeGraph Server] Could not attach watcher to ${resolvedRoot}:`, err.message)
  }

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1')
    if (parsedUrl.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      })
      res.write('data: {"status":"connected"}\n\n')
      sseClients.add(res)
      console.log(`[CodeGraph Server] SSE client connected to /events (active clients: ${sseClients.size})`)
      const pingTimer = setInterval(() => {
        if (!res.writableEnded) {
          try { res.write('data: {"status":"ping"}\n\n') } catch {}
        }
      }, 25000)
      req.on('close', () => {
        clearInterval(pingTimer)
        sseClients.delete(res)
        console.log(`[CodeGraph Server] SSE client disconnected (active clients: ${sseClients.size})`)
      })
      return
    }
    if (parsedUrl.pathname === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      try {
        const fileContent = fs.readFileSync(new URL(import.meta.url).pathname, 'utf8')
        const sIdx = fileContent.search(/<!doctype html>/i)
        const eIdx = fileContent.search(/<\/html>/i)
        if (sIdx !== -1 && eIdx !== -1) {
          return res.end(fileContent.slice(sIdx, eIdx + 7))
        }
      } catch {}
      return res.end(page)
    }
    if (parsedUrl.pathname === '/graph') {
      const includeTests = parsedUrl.searchParams.get('includeTests') === '1'
      try {
        const rawGraph = await fetchRawGraph()
        const layered = buildLayeredGraph(rawGraph, { includeTests })
        layered.project = {
          name: path.basename(rootPath),
          root: rootPath,
        }
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify(layered))
      } catch (error) {
        console.error(`[CodeGraph Server] Error serving /graph:`, error.message)
        res.statusCode = 500
        return res.end(JSON.stringify({ error: error.message }))
      }
    }
    if (parsedUrl.pathname === '/heatmap') {
      const includeTests = parsedUrl.searchParams.get('includeTests') === '1'
      try {
        const rawGraph = await fetchRawGraph()
        const heatmap = buildHeatmapData(rawGraph, { includeTests, width: 1400 })
        heatmap.project = {
          name: path.basename(rootPath),
          root: rootPath,
        }
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify(heatmap))
      } catch (error) {
        console.error(`[CodeGraph Server] Error serving /heatmap:`, error.message)
        res.statusCode = 500
        return res.end(JSON.stringify({ error: error.message }))
      }
    }
    if (parsedUrl.pathname === '/sunburst') {
      const includeTests = parsedUrl.searchParams.get('includeTests') === '1'
      try {
        const rawGraph = await fetchRawGraph()
        const sunburst = buildSunburstData(rawGraph, { includeTests, cx: 500, cy: 500, radius: 440 })
        sunburst.project = {
          name: path.basename(rootPath),
          root: rootPath,
        }
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify(sunburst))
      } catch (error) {
        console.error(`[CodeGraph Server] Error serving /sunburst:`, error.message)
        res.statusCode = 500
        return res.end(JSON.stringify({ error: error.message }))
      }
    }
    if (parsedUrl.pathname === '/chord') {
      const includeTests = parsedUrl.searchParams.get('includeTests') === '1'
      try {
        const rawGraph = await fetchRawGraph()
        const chord = buildChordData(rawGraph, { includeTests, cx: 500, cy: 500, radius: 360 })
        chord.project = {
          name: path.basename(rootPath),
          root: rootPath,
        }
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify(chord))
      } catch (error) {
        console.error(`[CodeGraph Server] Error serving /chord:`, error.message)
        res.statusCode = 500
        return res.end(JSON.stringify({ error: error.message }))
      }
    }
    res.statusCode = 404
    res.end('not found')
  })
  server.watcher = watcher
  return server
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  createVisualizerServer(root).listen(port, '127.0.0.1', () => {
    process.stderr.write(`⚡ CodeGraph visualizer: http://127.0.0.1:${port}\n`)
  })
}

