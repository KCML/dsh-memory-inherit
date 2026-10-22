/**
 * 把 DeepSeek 的 chat_messages 还原成「一段能读的对话」，再包成
 * dsh-persona-select 认识的历史对话格式。
 *
 * 为什么要这么绕：DeepSeek 网页版把一条消息拆成 fragments（REQUEST / THINK /
 * RESPONSE / FILE / TOOL_* …），而且消息之间是树（有 parent_id 和分支）。
 * 我们要的是「用户看到的那条线」，所以从 chat_session.current_message_id 往上
 * 沿 parent 链走回根，就是当前分支。
 */

export const USER_OPEN = '<user_message>'
export const USER_CLOSE = '</user_message>'
export const ASSISTANT_OPEN = '<assistant_message>'
export const ASSISTANT_CLOSE = '</assistant_message>'
export const THINK_OPEN = '<thinking>'
export const THINK_CLOSE = '</thinking>'

const USER_FRAGMENTS = new Set(['REQUEST'])
const ASSISTANT_FRAGMENTS = new Set(['RESPONSE', 'TEMPLATE_RESPONSE'])

/** fragments 里的 content 可能是字符串，也可能是 [{type:'text', text:'…'}]。 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part === null || typeof part !== 'object') return ''
        if (typeof part.text === 'string') return part.text
        if (typeof part.content === 'string') return part.content
        return ''
      })
      .filter((piece) => piece !== '')
      .join('\n')
  }
  if (content !== null && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (typeof content.content === 'string') return content.content
  }
  return ''
}

function fragmentsOf(message) {
  return Array.isArray(message?.fragments) ? message.fragments : []
}

function roleOf(message) {
  const declared = typeof message?.role === 'string' ? message.role.toUpperCase() : ''
  if (declared === 'USER') return 'user'
  if (declared === 'ASSISTANT') return 'assistant'
  const types = fragmentsOf(message).map((fragment) => String(fragment?.type ?? '').toUpperCase())
  if (types.some((type) => USER_FRAGMENTS.has(type))) return 'user'
  if (types.some((type) => ASSISTANT_FRAGMENTS.has(type) || type === 'THINK')) return 'assistant'
  return ''
}

/** 一条消息 → { id, parentId, role, text, thinking }。老格式（只有 content）也认。 */
export function extractMessage(message) {
  const id = typeof message?.message_id === 'string' ? message.message_id : null
  const parentId = typeof message?.parent_id === 'string' ? message.parent_id : null
  const role = roleOf(message)
  const userParts = []
  const assistantParts = []
  const thinkParts = []

  for (const fragment of fragmentsOf(message)) {
    const type = String(fragment?.type ?? '').toUpperCase()
    const text = contentToText(fragment?.content)
    if (text === '') continue
    if (USER_FRAGMENTS.has(type)) userParts.push(text)
    else if (ASSISTANT_FRAGMENTS.has(type)) assistantParts.push(text)
    else if (type === 'THINK') thinkParts.push(text)
    // 其余类型（FILE / TOOL_* / TIP / SEARCH）不是对话正文，丢掉
  }

  // 老格式/兜底：没有 fragments 时用 message.content
  if (userParts.length === 0 && assistantParts.length === 0 && thinkParts.length === 0) {
    const flat = contentToText(message?.content)
    if (flat !== '') {
      if (role === 'user') userParts.push(flat)
      else assistantParts.push(flat)
    }
  }

  const text = (role === 'user' ? userParts : assistantParts.length > 0 ? assistantParts : userParts).join('\n\n')
  return {
    id,
    parentId,
    role: role === '' ? (text === '' ? '' : 'assistant') : role,
    text: text.trim(),
    thinking: thinkParts.join('\n\n').trim(),
  }
}

/**
 * 从当前分支往上走回根，得到「用户看到的那条线」。
 * 没有 current_message_id 或链断了，就退回到数组顺序。
 */
export function activeChain(messages, currentMessageId) {
  const list = Array.isArray(messages) ? messages : []
  const byId = new Map()
  for (const message of list) {
    const id = typeof message?.message_id === 'string' ? message.message_id : null
    if (id !== null && !byId.has(id)) byId.set(id, message)
  }
  if (typeof currentMessageId === 'string' && byId.has(currentMessageId)) {
    const chain = []
    const guard = new Set()
    let cursor = currentMessageId
    while (typeof cursor === 'string' && byId.has(cursor) && !guard.has(cursor)) {
      guard.add(cursor)
      const message = byId.get(cursor)
      chain.push(message)
      const parentId = typeof message?.parent_id === 'string' ? message.parent_id : null
      cursor = parentId === null ? null : parentId
    }
    if (chain.length > 0) return chain.reverse()
  }
  return list
}

/** 消息数组 → 干净的对话轮次（跳过空消息、合并连续同角色）。 */
export function toTurns(messages, { includeThinking = false } = {}) {
  const turns = []
  for (const message of messages) {
    const extracted = extractMessage(message)
    if (extracted.role === '' || extracted.text === '') continue
    const turn = { role: extracted.role, text: extracted.text }
    if (includeThinking && extracted.role === 'assistant' && extracted.thinking !== '') {
      turn.thinking = extracted.thinking
    }
    const previous = turns[turns.length - 1]
    if (previous !== undefined && previous.role === turn.role) {
      previous.text = `${previous.text}\n\n${turn.text}`
      if (turn.thinking !== undefined) previous.thinking = previous.thinking === undefined ? turn.thinking : `${previous.thinking}\n\n${turn.thinking}`
      continue
    }
    turns.push(turn)
  }
  return turns
}

export function conversationOf({ id, title, updatedAt, currentMessageId, messages }, options = {}) {
  const chain = activeChain(messages, currentMessageId)
  return {
    id,
    title: typeof title === 'string' && title !== '' ? title : '(无标题)',
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    turns: toTurns(chain, options),
  }
}

function formatDate(timestamp) {
  if (!Number.isFinite(timestamp)) return ''
  try {
    return new Date(timestamp).toISOString().slice(0, 10)
  } catch {
    return ''
  }
}

/** 单轮 → 带标签的文本块。 */
function turnBlock(turn, { includeAssistant = true, includeThinking = false } = {}) {
  if (turn.role === 'user') return `${USER_OPEN}\n${turn.text}\n${USER_CLOSE}`
  if (!includeAssistant) return ''
  const parts = []
  if (includeThinking && typeof turn.thinking === 'string' && turn.thinking !== '') {
    parts.push(`${THINK_OPEN}\n${turn.thinking}\n${THINK_CLOSE}`)
  }
  parts.push(`${ASSISTANT_OPEN}\n${turn.text}\n${ASSISTANT_CLOSE}`)
  return parts.join('\n\n')
}

/**
 * 多段对话 → 一个历史对话框的正文。
 * 超过 maxChars 时按「整块」截断，绝不让半个标签被切开。
 */
export function renderHistory(conversations, { includeAssistant = true, includeThinking = false, maxChars = 0 } = {}) {
  const blocks = []
  const many = conversations.length > 1
  for (const conversation of conversations) {
    if (conversation.turns.length === 0) continue
    const pieces = []
    if (many) {
      const date = formatDate(conversation.updatedAt)
      pieces.push(`【旧对话：${conversation.title}${date === '' ? '' : ` · ${date}`}】`)
    }
    for (const turn of conversation.turns) {
      const block = turnBlock(turn, { includeAssistant, includeThinking })
      if (block !== '') pieces.push(block)
    }
    if (pieces.length > 0) blocks.push(pieces.join('\n\n'))
  }
  if (maxChars > 0) {
    const kept = []
    let size = 0
    let dropped = 0
    for (const block of blocks) {
      if (size + block.length + 2 > maxChars) {
        dropped += 1
        continue
      }
      kept.push(block)
      size += block.length + 2
    }
    if (dropped > 0) kept.push(`（为控制长度，另有 ${dropped} 段较早的旧对话没有导入）`)
    return kept.join('\n\n')
  }
  return blocks.join('\n\n')
}

/** 给人（和 agent）读的完整语料，Markdown。 */
export function renderCorpus(conversations) {
  const out = []
  for (const conversation of conversations) {
    const date = formatDate(conversation.updatedAt)
    out.push(`## ${conversation.title}${date === '' ? '' : ` · ${date}`}`)
    out.push('')
    for (const turn of conversation.turns) {
      if (turn.role === 'user') {
        out.push('**我**：')
      } else {
        out.push('**DeepSeek**：')
      }
      if (typeof turn.thinking === 'string' && turn.thinking !== '') {
        out.push(`> 思考：${turn.thinking.replace(/\n/g, '\n> ')}`)
        out.push('')
      }
      out.push(turn.text)
      out.push('')
    }
  }
  return out.join('\n')
}

export function statsOf(conversations) {
  let turns = 0
  let chars = 0
  for (const conversation of conversations) {
    turns += conversation.turns.length
    for (const turn of conversation.turns) chars += turn.text.length
  }
  return { conversations: conversations.length, turns, chars }
}
