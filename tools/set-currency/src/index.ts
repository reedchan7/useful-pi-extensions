/**
 * Switches the status line's display currency.
 *
 * Usage: bun tools/set-currency/src/index.ts <CODE>
 *
 * Writes `currency.code` in ~/.pi/agent/statusline.json and keeps everything else: a pinned perUsd
 * keeps pinning, and a cached rates table stays cached, so a switch to a currency the table already
 * knows needs no fetch at all. The extension reads the file once per session, so finish /reload.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const code = (process.argv[2] ?? '').trim().toUpperCase()
if (code === '') {
  console.error('usage: bun tools/set-currency/src/index.ts <CODE>   e.g. CNY, JPY, EUR')
  process.exit(1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const dir = join(homedir(), '.pi', 'agent', 'statusline')
const path = join(dir, 'config.json')
const legacy = join(homedir(), '.pi', 'agent', 'statusline.json')

let config: Record<string, unknown> = {}
try {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (isRecord(parsed)) config = parsed
} catch {
  // Pre-1.8 flat config, or none at all: either way the switch starts from what is readable.
  try {
    const parsed: unknown = JSON.parse(await readFile(legacy, 'utf8'))
    if (isRecord(parsed)) config = parsed
  } catch {}
}

config.currency = {
  ...(isRecord(config.currency) ? config.currency : {}),
  code,
}

await mkdir(dir, { recursive: true })
await writeFile(path, `${JSON.stringify(config, null, 2)}\n`)
await unlink(legacy).catch(() => {})
console.log(`statusline currency set to ${code}. /reload (or restart pi) to apply.`)
