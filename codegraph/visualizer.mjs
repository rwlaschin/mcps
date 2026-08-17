#!/usr/bin/env node
import http from 'node:http'
import path from 'node:path'
import { streamQuery } from './query-client.mjs'

const args = process.argv.slice(2); const rootAt = args.indexOf('--root'); const portAt = args.indexOf('--port')
const root = path.resolve(rootAt >= 0 ? args[rootAt + 1] : process.env.CODEGRAPH_ROOT ?? process.cwd())
const port = Number(portAt >= 0 ? args[portAt + 1] : 7331)
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Codegraph</title><style>body{font:14px system-ui;margin:0;color:#18202a}header{padding:16px;border-bottom:1px solid #ddd}svg{width:100%;height:calc(100vh - 60px)}circle{fill:#3b82f6}line{stroke:#94a3b8}text{font-size:11px}</style></head><body><header><strong>Codegraph</strong> <span id="status">Loading…</span></header><svg role="img" aria-label="Project dependency graph"></svg><script>fetch('/graph').then(r=>r.json()).then(g=>{status.textContent=g.symbols.length+' symbols / '+g.edges.length+' edges';const s=document.querySelector('svg'),ns='http://www.w3.org/2000/svg',shown=g.symbols.slice(0,120),by=new Map(shown.map((x,i)=>[x.id,{x:50+(i%12)*105,y:40+Math.floor(i/12)*65,s:x}]));for(const e of g.edges){const a=by.get(e.from),b=by.get(e.to);if(a&&b){const l=document.createElementNS(ns,'line');for(const [k,v] of Object.entries({x1:a.x,y1:a.y,x2:b.x,y2:b.y}))l.setAttribute(k,v);s.append(l)}}for(const n of by.values()){const c=document.createElementNS(ns,'circle');c.setAttribute('cx',n.x);c.setAttribute('cy',n.y);c.setAttribute('r',7);const t=document.createElementNS(ns,'text');t.setAttribute('x',n.x+10);t.setAttribute('y',n.y+4);t.textContent=n.s.name;s.append(c,t)}}).catch(e=>status.textContent='Error: '+e.message)</script></body></html>`

http.createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(page) }
  if (req.url === '/graph') {
    const controller = new AbortController()
    const abort = () => { if (!res.writableEnded) controller.abort() }
    req.once('aborted', abort); res.once('close', abort)
    try { let graph; for await (const row of streamQuery(root, { type: 'graph' }, { signal: controller.signal })) graph = row; if (controller.signal.aborted) return; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(graph)) }
    catch (error) { res.statusCode = 500; return res.end(JSON.stringify({ error: error.message })) }
    finally { req.off('aborted', abort); res.off('close', abort) }
  }
  res.statusCode = 404; res.end('not found')
}).listen(port, '127.0.0.1', () => process.stderr.write(`codegraph visualizer: http://127.0.0.1:${port}\n`))
