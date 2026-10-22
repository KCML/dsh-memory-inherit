/**
 * DeepSeek 网页版账号接口的最小客户端。
 *
 * 只用到三个端点（都能在 fe-static 的 main.js 里找到）：
 *   GET /api/v0/users/current                      账号信息
 *   GET /api/v0/chat_session/fetch_page            会话列表（lte 游标翻页）
 *   GET /api/v0/chat/history_messages              某个会话的消息
 *
 * 这些是网页版自己用的接口，不是公开 API：随时可能变、可能限流、也可能哪天就要求
 * 额外的风控参数。所以这里每个请求都留了超时，翻页留了硬上限，出错信息尽量原样带回。
 */

const DEFAULT_BASE = 'https://chat.deepseek.com'
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0'

export class DeepSeekApiError extends Error {
  constructor(message, { status, code, bizCode } = {}) {
    super(message)
    this.name = 'DeepSeekApiError'
    this.status = status ?? null
    this.code = code ?? null
    this.bizCode = bizCode ?? null
  }
}

function unwrap(json, status) {
  if (json === null || typeof json !== 'object') {
    throw new DeepSeekApiError('接口返回的不是 JSON（可能被风控页拦截了）', { status })
  }
  if (json.code !== 0) {
    throw new DeepSeekApiError(json.msg || `接口返回 code=${json.code}`, { status, code: json.code })
  }
  const data = json.data
  if (data === null || typeof data !== 'object') {
    throw new DeepSeekApiError('接口返回缺少 data', { status, code: json.code })
  }
  if (data.biz_code !== 0) {
    throw new DeepSeekApiError(data.biz_msg || `biz_code=${data.biz_code}`, {
      status,
      code: json.code,
      bizCode: data.biz_code,
    })
  }
  return data.biz_data
}

export class DeepSeekAccount {
  constructor({ token, baseUrl = DEFAULT_BASE, userAgent = DEFAULT_UA, fetchImpl, timeoutMs = 30000 } = {}) {
    if (typeof token !== 'string' || token.trim() === '') throw new Error('缺少 token')
    this.token = token.trim()
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : fetch
    this.userAgent = userAgent
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
      'x-app-version': '20241129.1',
      'x-client-platform': 'web',
      'x-client-version': '1.0.0-always',
      Accept: '*/*',
    }
  }

  async request(path, { method = 'GET', query, body } = {}) {
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
    const init = { method, headers: this.headers() }
    if (body !== undefined) init.body = JSON.stringify(body)
    let response
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new DeepSeekApiError(`请求超时（${this.timeoutMs}ms）：${url.pathname}`, {})
      }
      throw new DeepSeekApiError(`网络请求失败：${error?.message ?? String(error)}`, {})
    }
    const text = await response.text()
    if (response.status === 401 || response.status === 403) {
      throw new DeepSeekApiError('token 已失效或被拒绝（HTTP ' + response.status + '）：请重新登录网页版再取一次', {
        status: response.status,
      })
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new DeepSeekApiError(
        `接口返回了非 JSON 内容（HTTP ${response.status}），多半是风控页或登录页：${text.slice(0, 120)}`,
        { status: response.status },
      )
    }
    return unwrap(json, response.status)
  }

  /** 当前 token 属于哪个账号。 */
  async me() {
    const data = await this.request('/api/v0/users/current')
    return {
      id: data?.id ?? null,
      name: data?.id_profile?.name ?? data?.id_profiles?.[0]?.name ?? '',
      provider: data?.id_profile?.provider ?? '',
      mobile: data?.mobile_number ?? '',
      email: data?.email ?? '',
      hasLegacyHistory: data?.has_legacy_chat_history === true,
    }
  }

  /**
   * 会话列表。网页端用 lte 游标翻页：把上一页最后一条的 (pinned, updated_at) 当游标。
   * 这里做了几层保险：页码上限、游标不前进就停、id 重复就停。
   */
  async listSessions({ pageSize = 50, maxSessions = 2000, onPage } = {}) {
    const sessions = []
    const seen = new Set()
    let cursor = null
    for (let page = 0; page < 200; page += 1) {
      const query = { count: pageSize }
      if (cursor !== null) {
        query.mode = 'lte'
        query['lte_cursor.pinned'] = cursor.pinned ? 'true' : 'false'
        query['lte_cursor.updated_at'] = cursor.updatedAt
      }
      const data = await this.request('/api/v0/chat_session/fetch_page', { query })
      const batch = Array.isArray(data?.chat_sessions) ? data.chat_sessions : []
      let fresh = 0
      for (const item of batch) {
        const id = typeof item?.id === 'string' ? item.id : null
        if (id === null || seen.has(id)) continue
        seen.add(id)
        fresh += 1
        sessions.push({
          id,
          title: typeof item?.title === 'string' && item.title !== '' ? item.title : '(无标题)',
          updatedAt: Number.isFinite(item?.updated_at) ? item.updated_at * 1000 : null,
          pinned: item?.pinned === true,
          modelType: item?.model_type ?? '',
        })
      }
      if (typeof onPage === 'function') onPage({ page, total: sessions.length, hasMore: data?.has_more === true })
      const last = batch[batch.length - 1]
      const nextCursor = last === undefined ? null : { pinned: last?.pinned === true, updatedAt: last?.updated_at }
      if (data?.has_more !== true) break
      if (fresh === 0) break
      if (nextCursor === null || nextCursor.updatedAt === undefined || nextCursor.updatedAt === null) break
      if (cursor !== null && cursor.pinned === nextCursor.pinned && cursor.updatedAt === nextCursor.updatedAt) break
      cursor = nextCursor
      if (sessions.length >= maxSessions) break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    return sessions
  }

  /** 某个会话的全部消息 + 会话头信息。 */
  async historyMessages(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('缺少 chat_session_id')
    const data = await this.request('/api/v0/chat/history_messages', {
      query: { chat_session_id: sessionId, cache_version: 'null', cache_reset_at: 'null' },
    })
    return {
      session: data?.chat_session ?? null,
      messages: Array.isArray(data?.chat_messages) ? data.chat_messages : [],
      cacheControl: data?.cache_control ?? null,
    }
  }
}
