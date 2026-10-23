#!/usr/bin/env node
/** Stand-in Desktop executable: answers the remote debugging listing the launch smoke polls and exits cleanly on SIGTERM. */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const mode = process.env.FAKE_DESKTOP_MODE ?? 'welcome'
const port = Number(process.argv.find(argument => argument.startsWith('--remote-debugging-port='))?.split('=')[1])
if (mode === 'crash') {
  if (process.env.DSH_DESKTOP_DIAGNOSTIC_FILE) writeFileSync(process.env.DSH_DESKTOP_DIAGNOSTIC_FILE, 'fixture startup failure\n')
  process.exit(3)
}
const started = Date.now()
const server = createServer((request, response) => {
  if (request.url === '/json/version') {
    response.end(JSON.stringify({ Browser: 'Chrome/152.0.0.0' }))
    return
  }
  const targets = Date.now() - started < 300 || mode === 'loading'
    ? [{ type: 'page', url: 'dsh-app://app/' }]
    : [{ type: 'page', url: 'dsh-app://app/' }, { type: 'page', url: 'file:///opt/DeepSeek%20Harness/resources/app.asar/renderer/welcome.html' }]
  response.end(JSON.stringify(targets))
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => { server.close(); process.exit(mode === 'hang' ? 7 : 0) })
