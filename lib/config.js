import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** DSH_HOME 的解析规则与宿主保持一致：先看环境变量，再退回 ~/.dsh。 */
export function dshHome(env = process.env) {
  const configured = env?.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/** 本插件自己的数据目录。 */
export function pluginDir(env = process.env) {
  return join(dshHome(env), 'memory-inherit')
}

export function pathsOf(env = process.env) {
  const root = pluginDir(env)
  return {
    root,
    config: join(root, 'config.json'),
    index: join(root, 'index.json'),
    raw: join(root, 'raw'),
    corpus: join(root, 'corpus'),
    personaStore: join(dshHome(env), 'persona-select', 'personas.json'),
  }
}

export async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, 'utf8')
    if (raw.trim() === '') return fallback
    return JSON.parse(raw)
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

/** 先写临时文件再改名，避免读到写了一半的 JSON。 */
export async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}

export async function writeJsonAtomic(path, value) {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}
