/**
 * dsh-memory-inherit · 宿主侧
 *
 * 干三件事：
 *   1. 保存一个 DeepSeek 网页版 token（能验证就验证，验证不了也存着）
 *   2. 把账号里的历史对话拉下来，原文落盘（raw/）+ 可读语料落盘（corpus/）
 *   3. 把选中的对话转成「历史对话」，写进 dsh-persona-select 的一条人设里
 *
 * 注入本身不归这里管：persona-select 会在新对话第一步把它注进上下文，并且只注一次。
 * 我们只负责把数据准备好、放对地方。
 */

import { join } from 'node:path'
import { DeepSeekAccount } from './lib/deepseek.js'
import { conversationOf, renderCorpus, renderHistory, statsOf } from './lib/convert.js'
import { listStorePersonas, normalizeName, personaSelectInstalled, saveHistoryPersona } from './lib/persona-store.js'
import { pathsOf, readJson, writeAtomic, writeJsonAtomic } from './lib/config.js'

export const inject = ['webServer', 'commands', 'connection']

const ROUTE_PREFIX = '/memory-inherit'
const PLUGIN_NAME = 'dsh-memory-inherit'
const MAX_BODY_BYTES = 256 * 1024
const DEFAULT_MAX_CHARS = 60000
const MAX_MAX_CHARS = 400000

function log(ctx, level, message) {
  try {
    const logger = ctx?.logger
    const fn = logger !== null && logger !== undefined && typeof logger[level] === 'function' ? logger[level] : null
    if (fn !== null) {
      fn.call(logger, `[${PLUGIN_NAME}] ${message}`)
      return
    }
  } catch {
  }
  try {
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : 'log'](`[${PLUGIN_NAME}] ${message}`)
  } catch {
  }
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error(`请求体超过 ${limit} 字节`), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function mount(ctx) {
  const paths = pathsOf()
  const state = {
    config: { token: '', account: null, savedAt: null },
    index: { generatedAt: null, sessions: [] },
    progress: null,
    running: false,
  }

  const disposers = []
  const effect = (fn, label) => {
    if (typeof ctx?.effect === 'function') {
      disposers.push(ctx.effect(fn, label))
      return
    }
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  const accountClient = () => {
    const token = typeof state.config.token === 'string' ? state.config.token.trim() : ''
    if (token === '') throw Object.assign(new Error('还没有保存 token：请先在设置页粘贴，再点保存'), { status: 400 })
    return new DeepSeekAccount({ token })
  }

  async function persistConfig() {
    await writeJsonAtomic(paths.config, state.config)
  }

  async function persistIndex() {
    await writeJsonAtomic(paths.index, state.index)
  }

  async function loadFromDisk() {
    try {
      const config = await readJson(paths.config, null)
      if (config !== null && typeof config === 'object') {
        state.config = {
          token: typeof config.token === 'string' ? config.token : '',
          account: config.account ?? null,
          savedAt: Number.isFinite(config.savedAt) ? config.savedAt : null,
        }
      }
    } catch (error) {
      log(ctx, 'warn', `读取配置失败：${error?.message ?? String(error)}`)
    }
    try {
      const index = await readJson(paths.index, null)
      if (index !== null && typeof index === 'object' && Array.isArray(index.sessions)) {
        state.index = { generatedAt: index.generatedAt ?? null, sessions: index.sessions }
      }
    } catch (error) {
      log(ctx, 'warn', `读取索引失败：${error?.message ?? String(error)}`)
    }
  }

  async function conversationById(id) {
    const raw = await readJson(join(paths.raw, `${id}.json`), null)
    if (raw === null) throw Object.assign(new Error(`没有这个会话的原始数据：${id}（先拉取一次）`), { status: 404 })
    const session = raw.session ?? null
    return conversationOf({
      id,
      title: typeof session?.title === 'string' ? session.title : '',
      updatedAt: Number.isFinite(session?.updated_at) ? session.updated_at * 1000 : null,
      currentMessageId: session?.current_message_id,
      messages: Array.isArray(raw.messages) ? raw.messages : [],
    })
  }

  async function viewOf() {
    const store = await listStorePersonas(paths.personaStore)
    return {
      ok: true,
      configured: typeof state.config.token === 'string' && state.config.token !== '',
      account: state.config.account ?? null,
      savedAt: state.config.savedAt ?? null,
      lastSyncAt: state.index.generatedAt ?? null,
      running: state.running,
      progress: state.progress,
      sessions: state.index.sessions.map((entry) => ({
        id: entry.id,
        title: entry.title,
        updatedAt: entry.updatedAt ?? null,
        turns: entry.turns ?? 0,
        chars: entry.chars ?? 0,
        personaHint: entry.personaHint ?? false,
      })),
      personaStore: { ...store, pluginInstalled: personaSelectInstalled() },
      defaults: { maxChars: DEFAULT_MAX_CHARS },
    }
  }

  async function runSync({ maxSessions = 500 } = {}) {
    if (state.running) throw Object.assign(new Error('已经在拉了，等这次结束'), { status: 409 })
    state.running = true
    state.progress = { phase: 'listing', total: 0, done: 0, message: '正在读取会话列表…' }
    try {
      const client = accountClient()
      const sessions = await client.listSessions({
        pageSize: 50,
        maxSessions,
        onPage: ({ total, hasMore }) => {
          state.progress = {
            phase: 'listing',
            total,
            done: 0,
            message: `会话列表：已取到 ${total} 条${hasMore ? '，继续翻页…' : ''}`,
          }
        },
      })
      state.progress = { phase: 'fetching', total: sessions.length, done: 0, message: '开始拉取每个会话的消息…' }
      const collected = []
      for (const session of sessions) {
        state.progress = {
          phase: 'fetching',
          total: sessions.length,
          done: collected.length,
          message: `正在拉取：${session.title}`,
        }
        try {
          const { session: head, messages } = await client.historyMessages(session.id)
          const conversation = conversationOf({
            id: session.id,
            title: typeof head?.title === 'string' && head.title !== '' ? head.title : session.title,
            updatedAt: Number.isFinite(head?.updated_at) ? head.updated_at * 1000 : session.updatedAt,
            currentMessageId: head?.current_message_id,
            messages,
          })
          await writeJsonAtomic(join(paths.raw, `${session.id}.json`), { session: head, messages })
          await writeAtomic(join(paths.corpus, `${session.id}.md`), renderCorpus([conversation]))
          const stats = statsOf([conversation])
          collected.push({
            id: session.id,
            title: conversation.title,
            updatedAt: conversation.updatedAt,
            turns: stats.turns,
            chars: stats.chars,
          })
        } catch (error) {
          log(ctx, 'warn', `会话 ${session.id} 拉取失败：${error?.message ?? String(error)}`)
          collected.push({
            id: session.id,
            title: session.title,
            updatedAt: session.updatedAt,
            turns: 0,
            chars: 0,
            error: error?.message ?? String(error),
          })
        }
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      state.index = { generatedAt: Date.now(), sessions: collected }
      await persistIndex()
      state.progress = {
        phase: 'done',
        total: sessions.length,
        done: collected.length,
        message: `完成：${collected.length} 个会话`,
      }
      const ok = collected.filter((entry) => entry.error === undefined)
      return {
        sessions: collected.length,
        turns: ok.reduce((sum, entry) => sum + entry.turns, 0),
        chars: ok.reduce((sum, entry) => sum + entry.chars, 0),
        failed: collected.length - ok.length,
      }
    } finally {
      state.running = false
    }
  }

  async function runImport({ name, ids, mode, includeThinking, maxChars }) {
    const sessions = state.index.sessions
    if (sessions.length === 0) {
      throw Object.assign(new Error('本地还没有拉取过对话：先点「拉取」'), { status: 400 })
    }
    // 显式传了 ids（哪怕是空数组）就按它来；完全没传才当成「全都要」
    const wanted = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : sessions.map((entry) => entry.id)
    const known = new Set(sessions.map((entry) => entry.id))
    const chosen = wanted.filter((id) => known.has(id))
    if (chosen.length === 0) throw Object.assign(new Error('没有选中任何会话'), { status: 400 })

    const conversations = []
    for (const id of chosen) {
      try {
        conversations.push(await conversationById(id))
      } catch (error) {
        log(ctx, 'warn', `重建会话 ${id} 失败：${error?.message ?? String(error)}`)
      }
    }
    if (conversations.length === 0) throw Object.assign(new Error('选中的会话都读不出来（原始数据可能被删了）'), { status: 400 })

    const includeAssistant = mode !== 'user-only'
    const historyText = renderHistory(conversations, {
      includeAssistant,
      includeThinking: includeThinking === true,
      maxChars: clampInt(maxChars, DEFAULT_MAX_CHARS, 500, MAX_MAX_CHARS),
    })
    if (historyText.trim() === '') throw Object.assign(new Error('转换出来的历史对话是空的'), { status: 400 })

    const personaName = normalizeName(name) || '旧账号记忆'
    const saved = await saveHistoryPersona({
      storePath: paths.personaStore,
      name: personaName,
      historyText,
      sectionOrder: -1,
    })
    return { persona: saved, chars: historyText.length, sessions: conversations.length }
  }

  effect(() => {
    const disposer = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        try {
          const connection = Reflect.get(ctx, 'connection')
          if (connection !== null && connection !== undefined && typeof connection.requestRejection === 'function') {
            const rejection = connection.requestRejection(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
          }
          const url = new URL(String(req.url ?? '/'), 'http://localhost')
          const path = url.pathname
          const method = String(req.method ?? 'GET').toUpperCase()

          if (path === `${ROUTE_PREFIX}/state` && (method === 'GET' || method === 'HEAD')) {
            sendJson(res, 200, await viewOf())
            return
          }

          if (path === `${ROUTE_PREFIX}/token`) {
            if (method === 'DELETE') {
              state.config = { token: '', account: null, savedAt: null }
              await persistConfig()
              sendJson(res, 200, { ok: true, configured: false })
              return
            }
            if (method === 'PUT' || method === 'POST') {
              const body = await readJsonBody(req)
              const token = typeof body?.token === 'string' ? body.token.trim() : ''
              if (token === '') {
                state.config = { token: '', account: null, savedAt: null }
                await persistConfig()
                sendJson(res, 200, { ok: true, configured: false })
                return
              }
              let account = null
              let warning = null
              try {
                account = await new DeepSeekAccount({ token }).me()
              } catch (error) {
                warning = `token 存下了，但验证没通过：${error?.message ?? String(error)}`
              }
              state.config = { token, account, savedAt: Date.now() }
              await persistConfig()
              sendJson(res, 200, { ok: true, configured: true, account, warning })
              return
            }
            sendJson(res, 405, { ok: false, message: '只支持 PUT / DELETE' })
            return
          }

          if (path === `${ROUTE_PREFIX}/sync`) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, message: '只支持 POST' })
              return
            }
            const body = await readJsonBody(req)
            const summary = await runSync({ maxSessions: clampInt(body?.maxSessions, 500, 1, 5000) })
            sendJson(res, 200, { ok: true, summary })
            return
          }

          if (path === `${ROUTE_PREFIX}/import`) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, message: '只支持 POST' })
              return
            }
            const body = await readJsonBody(req)
            const result = await runImport({
              name: body?.name,
              ids: body?.ids,
              mode: body?.mode,
              includeThinking: body?.includeThinking,
              maxChars: body?.maxChars,
            })
            sendJson(res, 200, { ok: true, ...result })
            return
          }

          if (path === `${ROUTE_PREFIX}/preview`) {
            if (method !== 'GET') {
              sendJson(res, 405, { ok: false, message: '只支持 GET' })
              return
            }
            const ids = (url.searchParams.get('ids') ?? '').split(',').filter((id) => id !== '')
            const includeAssistant = url.searchParams.get('mode') !== 'user-only'
            const conversations = []
            for (const id of ids) {
              try {
                conversations.push(await conversationById(id))
              } catch {
              }
            }
            const text = renderHistory(conversations, {
              includeAssistant,
              includeThinking: url.searchParams.get('thinking') === '1',
              maxChars: 4000,
            })
            sendJson(res, 200, { ok: true, sessions: conversations.length, preview: text })
            return
          }

          sendJson(res, 404, { ok: false, message: `没有这条路由：${path}` })
        } catch (error) {
          const status = Number.isInteger(error?.status) ? error.status : 500
          if (status >= 500) log(ctx, 'error', `请求处理失败：${error?.message ?? String(error)}`)
          sendJson(res, status, { ok: false, message: error?.message ?? String(error) })
        }
      },
    })
    if (typeof disposer !== 'function') throw new TypeError('webServer.register() 没有返回 disposer')
    return disposer
  }, `${PLUGIN_NAME}: ${ROUTE_PREFIX} 路由`)

  function statusText() {
    const configured = typeof state.config.token === 'string' && state.config.token !== ''
    const lines = [
      `token：${configured ? '已保存' : '未保存'}`,
      `账号：${state.config.account?.name ?? '（未验证）'}${state.config.account?.mobile ? ` · ${state.config.account.mobile}` : ''}`,
      `本地会话：${state.index.sessions.length} 条${state.index.generatedAt ? `（${new Date(state.index.generatedAt).toLocaleString()} 拉取）` : ''}`,
      state.running ? `状态：正在拉取（${state.progress?.message ?? ''}）` : '状态：空闲',
      '',
      '子命令：/memory sync · /memory list · /memory import [人设名] · /memory token <token>',
      '图形界面：设置 → 记忆继承',
    ]
    return lines.join('\n')
  }

  effect(() => {
    const commands = Reflect.get(ctx, 'commands')
    if (commands === null || commands === undefined || typeof commands.register !== 'function') return undefined
    return commands.register({
      name: 'memory',
      description: '旧账号记忆：status / sync / list / import / token',
      input: { hint: 'status | sync | list | import [人设名] | token <token>' },
      handler: async ({ rawInput } = {}) => {
        const raw = typeof rawInput === 'string' ? rawInput.trim() : ''
        const verb = (raw.split(/\s+/)[0] ?? '').toLowerCase()
        const rest = raw.slice(verb.length).trim()
        try {
          if (verb === '' || verb === 'status') return { kind: 'success', text: statusText() }
          if (verb === 'sync') {
            if (state.running) return { kind: 'error', text: '已经在拉了，等这次结束' }
            void runSync({ maxSessions: 500 }).catch((error) => log(ctx, 'error', `拉取失败：${error?.message ?? String(error)}`))
            return { kind: 'success', text: '开始拉取… 完成后用 /memory 看结果' }
          }
          if (verb === 'list') {
            if (state.index.sessions.length === 0) return { kind: 'success', text: '本地还没有会话，先 /memory sync' }
            const lines = state.index.sessions
              .slice(0, 40)
              .map((entry, index) => `${index + 1}. ${entry.title} · ${entry.turns} 轮 · ${entry.chars} 字`)
            if (state.index.sessions.length > 40) lines.push(`……还有 ${state.index.sessions.length - 40} 条`)
            return { kind: 'success', text: lines.join('\n') }
          }
          if (verb === 'token') {
            if (rest === '') return { kind: 'error', text: '用法：/memory token <userToken>' }
            const account = await new DeepSeekAccount({ token: rest }).me()
            state.config = { token: rest, account, savedAt: Date.now() }
            await persistConfig()
            return {
              kind: 'success',
              text: `token 已保存并验证：${account.name}${account.mobile ? ` · ${account.mobile}` : ''}`,
            }
          }
          if (verb === 'import') {
            const result = await runImport({ name: rest || '旧账号记忆', mode: 'full', maxChars: DEFAULT_MAX_CHARS })
            const persona = result.persona
            return {
              kind: 'success',
              text: `${persona.created ? '已新建' : '已更新'}人设「${persona.name}」：${result.sessions} 段对话，${persona.chars} 字。到对话页「人设」里选它（要新对话才注入）。`,
            }
          }
          return { kind: 'error', text: `不认识的子命令：${verb}\n\n${statusText()}` }
        } catch (error) {
          return { kind: 'error', text: error?.message ?? String(error) }
        }
      },
    })
  }, `${PLUGIN_NAME}: /memory 命令`)

  void loadFromDisk()
    .then(async () => {
      // 配置里只有 token、还没验过账号：启动时顺手验一次，界面上就能显示是谁的账号。
      const token = typeof state.config.token === 'string' ? state.config.token.trim() : ''
      if (token === '' || state.config.account !== null) return
      try {
        const account = await new DeepSeekAccount({ token }).me()
        state.config = { ...state.config, account, savedAt: Date.now() }
        await persistConfig()
      } catch (error) {
        log(ctx, 'warn', `启动时验证 token 失败（不影响使用）：${error?.message ?? String(error)}`)
      }
    })
    .catch((error) => {
      log(ctx, 'warn', `初始化读取失败：${error?.message ?? String(error)}`)
    })

  return () => {
    for (const disposer of disposers.reverse()) {
      try {
        disposer?.()
      } catch {
      }
    }
  }
}


/**
 * 宿主入口。任何一步自己挂了，都只记日志、不把整个 profile 带崩。
 */
export function apply(ctx) {
  try {
    return mount(ctx)
  } catch (error) {
    log(ctx, 'error', `挂载失败（插件已跳过，DSH 其余功能不受影响）：${error?.message ?? String(error)}`)
    return () => {}
  }
}
