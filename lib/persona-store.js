/**
 * 往 dsh-persona-select 的数据目录里写一条人设。
 *
 * 为什么不走它的 HTTP 接口：那套接口带同源校验，跨插件调用要复刻它的鉴权；
 * 而它的落盘格式稳定、字段少，直接读写磁盘更简单，也不依赖它启动没启动。
 * 格式对照 lib/store.js（STORE_VERSION = 3）。
 */

import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const STORE_VERSION = 3
const HISTORY_DIR = 'history'
const HISTORY_FILE_PATTERN = /^[A-Za-z0-9:_-]{1,80}\.txt$/
const MAX_NAME_LENGTH = 40
const MAX_PERSONAS = 200

function emptyStore() {
  return {
    version: STORE_VERSION,
    activeId: null,
    soloOnly: false,
    stripRuntime: false,
    stripTools: false,
    stripInjected: false,
    toolReusable: true,
    personas: [],
    sessions: {},
  }
}

export function normalizeName(value) {
  const flat = typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : ''
  return flat.length > MAX_NAME_LENGTH ? flat.slice(0, MAX_NAME_LENGTH) : flat
}

function newPersonaId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}

async function readStore(path) {
  if (!(await exists(path))) return emptyStore()
  const raw = await readFile(path, 'utf8')
  if (raw.trim() === '') return emptyStore()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyStore()
  }
  if (parsed === null || typeof parsed !== 'object') return emptyStore()
  const doc = { ...emptyStore(), ...parsed }
  if (!Array.isArray(doc.personas)) doc.personas = []
  if (doc.sessions === null || typeof doc.sessions !== 'object') doc.sessions = {}
  return doc
}

/**
 * 写入/更新一条「只带历史对话、不带人设正文」的人设。
 * 同名的人设会被更新（换掉历史对话），避免每拉一次就多一条。
 */
export async function saveHistoryPersona({ storePath, name, historyText, sectionOrder = -1 } = {}) {
  const cleanName = normalizeName(name)
  if (cleanName === '') throw new Error('人设名称不能为空')
  if (typeof historyText !== 'string' || historyText.trim() === '') throw new Error('历史对话是空的，没什么可写的')

  const doc = await readStore(storePath)
  const storeVersion = Number(doc.version)
  if (Number.isFinite(storeVersion) && storeVersion > STORE_VERSION) {
    throw Object.assign(
      new Error(
        `persona-select 的数据格式版本是 ${storeVersion}，本插件只认识 ${STORE_VERSION}：`
          + '直接写会有损坏风险，请先升级 dsh-memory-inherit（或把 persona-select 降回兼容版本）。',
      ),
      { code: 'store-version-too-new', status: 409 },
    )
  }
  const now = Date.now()
  const existing = doc.personas.find((entry) => entry !== null && typeof entry === 'object' && entry.name === cleanName)
  const id = existing !== undefined && typeof existing.id === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(existing.id)
    ? existing.id
    : newPersonaId()
  const file = `${id}.txt`
  if (!HISTORY_FILE_PATTERN.test(file)) throw new Error(`历史对话文件名不合法：${file}`)

  if (existing === undefined && doc.personas.length >= MAX_PERSONAS) {
    throw new Error(`persona-select 里的人设已经有 ${doc.personas.length} 条，达到上限 ${MAX_PERSONAS}`)
  }

  const text = historyText.replace(/\r\n?/g, '\n').trim()
  const historyPath = join(dirname(storePath), HISTORY_DIR, file)
  await writeAtomic(historyPath, text)

  const summary = {
    file,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    lockedAt: null,
    kind: 'persona-history',
  }
  if (existing === undefined) {
    doc.personas.push({
      id,
      name: cleanName,
      text: '',
      sectionOrder,
      history: summary,
      createdAt: now,
      updatedAt: now,
    })
  } else {
    existing.text = typeof existing.text === 'string' ? existing.text : ''
    existing.history = summary
    existing.updatedAt = now
    if (!Number.isFinite(existing.sectionOrder) && existing.sectionOrder !== null) existing.sectionOrder = sectionOrder
  }
  doc.version = Number.isFinite(doc.version) ? doc.version : STORE_VERSION

  await writeAtomic(storePath, `${JSON.stringify(doc, null, 2)}\n`)
  return { id, file, chars: summary.chars, bytes: summary.bytes, created: existing === undefined, name: cleanName }
}

/** persona-select 这个包有没有被装进同一个 profile（装了才会真的去注入）。 */
export function personaSelectInstalled() {
  try {
    if (typeof import.meta.resolve !== 'function') return null
    return import.meta.resolve('dsh-persona-select') !== null
  } catch {
    return false
  }
}

/** 给界面看的：persona-select 那边现在有哪些人设。 */
export async function listStorePersonas(storePath) {
  const found = await exists(storePath)
  if (!found) return { installed: false, personas: [] }
  const doc = await readStore(storePath)
  return {
    installed: true,
    personas: doc.personas
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        id: String(entry.id ?? ''),
        name: String(entry.name ?? ''),
        chars: Number.isFinite(entry?.history?.chars) ? entry.history.chars : 0,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : null,
      })),
  }
}
