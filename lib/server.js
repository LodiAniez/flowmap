import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { simulate } from './simulate.js'
import { mermaid } from './diagram.js'
import { resolveAnchor } from './anchor.js'

const here = dirname(fileURLToPath(import.meta.url))

// Localhost only, no build step, no CDN, no external fonts. See DESIGN.md "UI principles":
// this has to work on a plane. The page is one file served from disk.
export function serve({ root, mapPath, port = 7777 }) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        route(req, res, { root, mapPath })
      } catch (err) {
        json(res, 500, { error: err.message })
      }
    })

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is in use — try \`flowmap visualize --port ${port + 1}\``))
      } else reject(err)
    })

    server.listen(port, '127.0.0.1', () => {
      process.stdout.write(`\n  flowmap  http://localhost:${port}\n`)
      process.stdout.write(`  serving ${mapPath}\n`)
      process.stdout.write(`  ctrl-c to stop\n\n`)
      resolve(server)
    })
  })
}

function route(req, res, { root, mapPath }) {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/') {
    const html = readFileSync(join(here, 'ui.html'), 'utf8')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  // Re-read on every request so editing flowmap.json shows up on refresh, no restart.
  if (url.pathname === '/api/map') {
    const map = JSON.parse(readFileSync(mapPath, 'utf8'))
    const journeys = {}
    for (const [name, journey] of Object.entries(map.journeys ?? {})) {
      journeys[name] = {
        ...journey,
        mermaid: mermaid(map, name, journey),
        anchors: anchorStatus(root, journey),
      }
    }
    json(res, 200, { repos: map.repos ?? {}, contracts: map.contracts ?? {}, journeys })
    return
  }

  if (url.pathname === '/api/simulate' && req.method === 'POST') {
    readBody(req, (body) => {
      const map = JSON.parse(readFileSync(mapPath, 'utf8'))
      const journey = map.journeys?.[body.journey]
      if (!journey) return json(res, 404, { error: `no journey "${body.journey}"` })
      json(res, 200, simulate(map, journey, body.payload ?? {}))
    })
    return
  }

  json(res, 404, { error: 'not found' })
}

// Anchor state travels with the journey so the UI can show a hop as verified or drifted,
// for the same reason the CLI does: a hop that no longer resolves must not look fine.
function anchorStatus(root, journey) {
  const out = {}
  ;(journey.hops ?? []).forEach((hop, i) => {
    for (const side of ['reads', 'writes']) {
      if (!hop[side]) continue
      out[`${i}.${side}`] = resolveAnchor(root, hop.repo, hop[side]).status
    }
  })
  return out
}

function readBody(req, done) {
  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    try {
      done(raw ? JSON.parse(raw) : {})
    } catch {
      done({})
    }
  })
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}
