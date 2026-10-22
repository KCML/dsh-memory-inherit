import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

const root = process.argv[2]
const exts = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.ps1', '.py', '.txt', '.cjs'])
const bad = []
const decoder = new TextDecoder('utf-8', { fatal: true })

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) walk(path)
    else if (exts.has(extname(name).toLowerCase())) {
      const bytes = readFileSync(path)
      try {
        decoder.decode(bytes)
      } catch {
        bad.push({ file: relative(root, path), bytes: info.size })
      }
      if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        bad.push({ file: relative(root, path), bytes: info.size, note: 'has BOM' })
      }
    }
  }
}

walk(root)
if (bad.length === 0) console.log('all text files are valid UTF-8 without BOM')
else for (const entry of bad) console.log('BAD', entry.file, entry.bytes, entry.note ?? '')
process.exitCode = bad.length > 0 && bad.some((entry) => entry.note !== 'has BOM') ? 1 : 0
