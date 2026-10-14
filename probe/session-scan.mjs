/**
 * Diagnostic: read one compressed DSH session log and report what reached the model.
 *
 * The question this answers is "which row injected this text", which the Web conversation view
 * cannot show: it prints the session header, every `system/message`, every `user/message` whose
 * text mentions instructions, and the tool names in the first `request/header`.
 *
 * The log is a sequence of appended zstd frames with no index, and a single-shot
 * `zstdDecompressSync` stops at the first frame — returning the session header alone. Each frame
 * is therefore decoded on its own, located by the zstd magic number and kept only when the
 * decoded text is a JSON record.
 *
 * Usage: node probe/session-scan.mjs <session-dir-or-session.v4.jsonl.zstd>
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const target = process.argv[2]
if (target === undefined) throw new Error('usage: node probe/session-scan.mjs <session directory or session.v4.jsonl.zstd>')

/** The one log file under a session directory, or the file itself. */
function logFile(path) {
  if (statSync(path).isFile()) return path
  const found = readdirSync(path).filter(name => name.startsWith('session.') && name.endsWith('.zstd'))
  if (found.length !== 1) throw new Error(`${path} holds ${found.length} session logs`)
  return join(path, found[0])
}

/** Every JSON line of an appended zstd-frame log, in file order. */
function decompress(file) {
  const raw = readFileSync(file)
  const magic = [0x28, 0xB5, 0x2F, 0xFD]
  const at = (offset) => magic.every((byte, index) => raw[offset + index] === byte)
  let text = ''
  for (let offset = 0; offset + 4 <= raw.length; offset++) {
    if (!at(offset)) continue
    let decoded
    try {
      decoded = zstdDecompressSync(raw.subarray(offset)).toString('utf8')
    } catch {
      continue
    }
    // Compressed bytes can contain the magic; only a frame decodes to a record.
    if (decoded.startsWith('{"')) text += decoded
  }
  return text
}

/** Text blocks of one message record, joined. */
function textOf(message) {
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
}

const file = logFile(target)
const lines = decompress(file).split('\n').filter(line => line.trim() !== '')
const events = lines.map(line => JSON.parse(line))

console.log(`file: ${file}`)
console.log(`events: ${events.length}`)

if (process.argv.includes('--raw')) {
  for (const event of events) console.log(JSON.stringify(event).slice(0, 3000))
  process.exit(0)
}

const header = events.find(event => event.type === 'session/header')
if (header !== undefined) console.log(`header: ${JSON.stringify(header)}`)

console.log('\ntimeline:')
for (const event of events) {
  const extra = event.type === 'agent-preset/selected' ? ` ${JSON.stringify(event.data)}` : ''
  console.log(`  [${event.seq ?? '-'}] ${event.type}${extra}`)
}

const tools = new Map()
for (const event of events) {
  if (event.type === 'request/header') tools.set(event.seq, (event.data.header?.tools ?? []).map(tool => tool.name))
}

for (const event of events) {
  if (event.type === 'system/message') {
    const text = textOf(event.data.message)
    console.log(`\n[${event.seq}] system/message (${text.length} chars)\n${text.slice(0, 600)}`)
    continue
  }
  if (event.type !== 'user/message' && event.type !== 'developer/message') continue
  const message = event.data?.message
  if (message === undefined) continue
  const text = textOf(message)
  const source = message.source
  if (!text.includes('Instructions from:') && !text.includes('AGENTS.md') && source?.kind !== 'system-prompt') continue
  console.log(`\n[${event.seq}] ${event.type} source=${JSON.stringify(source)}\n${text.slice(0, 900)}`)
}

for (const [seq, names] of tools) console.log(`\n[${seq}] tools: ${names.join(', ')}`)
