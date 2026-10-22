window.__ModuleLoader__.load({
  id: 'dsh-memory-inherit',
  factory: function memoryInheritFactory(require) {
    'use strict';
    let React = null;
    try {
      React = require('react');
    } catch {
      React = null;
    }
    const h = React !== null && typeof React.createElement === 'function' ? React.createElement : null;

    const API = '/memory-inherit';
    const NAV_LABEL = '记忆继承';

    if (h === null) {
      try {
        console.error('[dsh-memory-inherit] 拿不到 react，设置页不会出现；宿主侧功能不受影响。');
      } catch {
      }
      return { inject: [], apply() {} };
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px', fontSize: 13, lineHeight: 1.6 },
      card: {
        border: '1px solid var(--dsh-border, rgba(128,128,128,.28))',
        borderRadius: 10,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      h2: { margin: 0, fontSize: 14, fontWeight: 600 },
      sub: { margin: 0, opacity: 0.7, fontSize: 12 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: 1,
        minWidth: 220,
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
      },
      button: {
        padding: '6px 12px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
      },
      primary: {
        padding: '6px 12px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'var(--dsh-accent, #4f6ef7)',
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
      },
      list: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        maxHeight: 260,
        overflowY: 'auto',
        border: '1px solid var(--dsh-border, rgba(128,128,128,.2))',
        borderRadius: 8,
        padding: 6,
      },
      item: { display: 'flex', gap: 8, alignItems: 'center', padding: '2px 4px', borderRadius: 4 },
      title: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { opacity: 0.6, fontSize: 11, fontVariantNumeric: 'tabular-nums' },
      ok: { color: '#2f9e6a' },
      warn: { color: '#c98a1a' },
      err: { color: '#d0453b' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11 },
    };

    async function call(path, init) {
      const response = await fetch(API + path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || (payload !== null && payload.ok === false)) {
        throw new Error(payload?.message ?? `请求失败（HTTP ${response.status}）`);
      }
      return payload ?? {};
    }

    function formatDate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      try {
        return new Date(value).toLocaleString();
      } catch {
        return '';
      }
    }

    function Page() {
      const [state, setState] = React.useState(null);
      const [token, setToken] = React.useState('');
      const [selected, setSelected] = React.useState([]);
      const [mode, setMode] = React.useState('full');
      const [thinking, setThinking] = React.useState(false);
      const [maxChars, setMaxChars] = React.useState(60000);
      const [name, setName] = React.useState('旧账号记忆');
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [touched, setTouched] = React.useState(false);

      const refresh = React.useCallback(async () => {
        try {
          const next = await call('/state');
          setState(next);
          if (!touched) setSelected(Array.isArray(next.sessions) ? next.sessions.filter((s) => !s.error).map((s) => s.id) : []);
          return next;
        } catch (error) {
          setNotice({ kind: 'err', text: `读取状态失败：${error.message}` });
          return null;
        }
      }, [touched]);

      React.useEffect(() => {
        void refresh();
      }, []);

      React.useEffect(() => {
        if (state === null || state.running !== true) return undefined;
        const timer = setInterval(() => {
          void refresh();
        }, 1500);
        return () => clearInterval(timer);
      }, [state?.running, refresh]);

      async function saveToken() {
        const value = token.trim();
        if (value === '') return;
        setBusy('token');
        setNotice(null);
        try {
          const result = await call('/token', { method: 'PUT', body: JSON.stringify({ token: value }) });
          setToken('');
          setNotice(
            result.warning !== null && result.warning !== undefined
              ? { kind: 'warn', text: result.warning }
              : { kind: 'ok', text: `token 已保存并验证：${result.account?.name ?? ''}${result.account?.mobile ? ` · ${result.account.mobile}` : ''}` },
          );
          await refresh();
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      }

      async function clearToken() {
        setBusy('token');
        try {
          await call('/token', { method: 'DELETE' });
          setNotice({ kind: 'ok', text: 'token 已清除' });
          await refresh();
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      }

      async function runSync() {
        setBusy('sync');
        setNotice({ kind: 'warn', text: '开始拉取…（会话多的账号要等一会儿）' });
        try {
          const result = await call('/sync', { method: 'POST', body: JSON.stringify({ maxSessions: 500 }) });
          const s = result.summary ?? {};
          setNotice({
            kind: 'ok',
            text: `拉取完成：${s.sessions ?? 0} 个会话，${s.turns ?? 0} 轮，${s.chars ?? 0} 字${s.failed ? `（${s.failed} 个失败，见日志）` : ''}`,
          });
          setTouched(false);
          await refresh();
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      }

      async function runImport() {
        if (selected.length === 0) {
          setNotice({ kind: 'warn', text: '先勾选要继承的会话' });
          return;
        }
        setBusy('import');
        try {
          const result = await call('/import', {
            method: 'POST',
            body: JSON.stringify({ name, ids: selected, mode, includeThinking: thinking, maxChars }),
          });
          const persona = result.persona ?? {};
          setNotice({
            kind: 'ok',
            text: `${persona.created ? '已新建' : '已更新'}人设「${persona.name}」：${result.sessions} 段对话，${persona.chars} 字。去对话页的「人设」里选中它即可。`,
          });
          await refresh();
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      }

      const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
      const account = state?.account ?? null;
      const store = state?.personaStore ?? { installed: false, personas: [] };
      const allSelected = sessions.length > 0 && selected.length === sessions.filter((s) => !s.error).length;

      return h(
        'div',
        { style: S.root, 'data-plugin': 'dsh-memory-inherit' },
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '记忆继承'),
          h(
            'p',
            { style: S.sub },
            '把 DeepSeek 网页版账号里的历史对话拉下来，转成「历史对话」写进 dsh-persona-select 的一条人设；注入由它负责，只在新对话第一步生效一次。',
          ),
          h(
            'p',
            { style: S.sub },
            state === null
              ? '读取中…'
              : state.configured
                ? `已保存 token${account ? `：${account.name}${account.mobile ? ` · ${account.mobile}` : ''}` : '（未验证）'}`
                : '还没有保存 token',
          ),
          h(
            'div',
            { style: S.row },
            h('input', {
              style: S.input,
              type: 'password',
              autoComplete: 'off',
              placeholder: '粘贴 chat.deepseek.com 的 userToken（F12 → Console → JSON.parse(localStorage.userToken).value）',
              value: token,
              onChange: (event) => setToken(event.target.value),
            }),
            h('button', { type: 'button', style: S.primary, disabled: busy !== '' || token.trim() === '', onClick: saveToken }, busy === 'token' ? '保存中…' : '保存'),
            h('button', { type: 'button', style: S.button, disabled: busy !== '' || !state?.configured, onClick: clearToken }, '清除'),
          ),
        ),
        state !== null && state.personaStore?.pluginInstalled === false
          ? h(
              'div',
              { style: { ...S.card, borderColor: '#c98a1a' } },
              h('h2', { style: { ...S.h2, ...S.warn } }, '缺一块拼图：dsh-persona-select'),
              h(
                'p',
                { style: S.sub },
                '本插件只负责把旧对话转成「历史对话」，真正的注入是 dsh-persona-select 做的。没装它的话，数据写进去也不会出现在对话里。',
              ),
              h('p', { style: { ...S.sub, ...S.mono } }, 'github.com/gosutry/dsh-persona-select'),
            )
          : null,
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '拉取'),
          h(
            'div',
            { style: S.row },
            h(
              'button',
              { type: 'button', style: S.primary, disabled: busy !== '' || !state?.configured || state?.running, onClick: runSync },
              state?.running ? '正在拉取…' : busy === 'sync' ? '拉取中…' : '拉取全部对话',
            ),
            h(
              'span',
              { style: S.meta },
              state?.lastSyncAt ? `上次拉取：${formatDate(state.lastSyncAt)}` : '还没有拉取过',
            ),
          ),
          state?.progress ? h('p', { style: S.sub }, `${state.progress.message ?? ''}（${state.progress.done ?? 0}/${state.progress.total ?? 0}）`) : null,
          h('p', { style: S.sub }, '原文存在 ~/.dsh/memory-inherit/raw/，可读语料在同一目录的 corpus/，可以自己翻，也可以让 agent 读来蒸馏。'),
        ),
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('h2', { style: S.h2 }, `会话（${sessions.length}）`),
            h(
              'button',
              {
                type: 'button',
                style: S.button,
                onClick: () => {
                  setTouched(true);
                  setSelected(allSelected ? [] : sessions.filter((s) => !s.error).map((s) => s.id));
                },
              },
              allSelected ? '全不选' : '全选',
            ),
          ),
          sessions.length === 0
            ? h('p', { style: S.sub }, '还没有会话。先保存 token，再点「拉取全部对话」。')
            : h(
                'div',
                { style: S.list },
                sessions.map((session) =>
                  h(
                    'label',
                    { key: session.id, style: S.item },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.includes(session.id),
                      onChange: (event) => {
                        setTouched(true);
                        setSelected((previous) =>
                          event.target.checked ? [...previous, session.id] : previous.filter((id) => id !== session.id),
                        );
                      },
                    }),
                    h('span', { style: S.title, title: session.title }, session.title),
                    h('span', { style: S.meta }, `${session.turns} 轮 · ${session.chars} 字 · ${formatDate(session.updatedAt)}`),
                  ),
                ),
              ),
        ),
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '导入为人设'),
          h(
            'div',
            { style: S.row },
            h('input', { style: S.input, value: name, maxLength: 40, onChange: (event) => setName(event.target.value) }),
          ),
          h(
            'div',
            { style: S.row },
            h(
              'label',
              { style: S.row },
              h('input', { type: 'radio', checked: mode === 'full', onChange: () => setMode('full') }),
              h('span', null, '完整对话（含 AI 回复）'),
            ),
            h(
              'label',
              { style: S.row },
              h('input', { type: 'radio', checked: mode === 'user-only', onChange: () => setMode('user-only') }),
              h('span', null, '只要我发的'),
            ),
            h(
              'label',
              { style: S.row },
              h('input', { type: 'checkbox', checked: thinking, onChange: (event) => setThinking(event.target.checked) }),
              h('span', null, '带上思考过程'),
            ),
            h(
              'label',
              { style: S.row },
              h('span', { style: S.meta }, '字数上限'),
              h('input', {
                style: { ...S.input, minWidth: 90, flex: 'none', width: 90 },
                type: 'number',
                min: 500,
                max: 400000,
                step: 1000,
                value: maxChars,
                onChange: (event) => setMaxChars(Number(event.target.value) || 0),
              }),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h(
              'button',
              { type: 'button', style: S.primary, disabled: busy !== '' || selected.length === 0, onClick: runImport },
              busy === 'import' ? '写入中…' : `导入 ${selected.length} 段对话`,
            ),
            h('span', { style: S.meta }, store.installed ? `persona-select：${store.personas.length} 条人设` : '没找到 persona-select 的数据目录（装了插件再来）'),
          ),
        ),
        store.personas.length > 0
          ? h(
              'div',
              { style: S.card },
              h('h2', { style: S.h2 }, '已有的人设'),
              store.personas.map((persona) =>
                h(
                  'div',
                  { key: persona.id, style: S.row },
                  h('span', { style: S.title }, persona.name),
                  h('span', { style: S.meta }, `${persona.chars} 字 · ${formatDate(persona.updatedAt)}`),
                ),
              ),
            )
          : null,
        notice !== null
          ? h('p', { style: { ...S.sub, ...(S[notice.kind] ?? {}) } }, notice.text)
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'memory-inherit', order: 32, label: () => NAV_LABEL, inject: () => ({}) },
              Page,
            ),
          );
        } catch (error) {
          try {
            console.error('[dsh-memory-inherit] 挂载设置页失败：', error?.message ?? String(error));
          } catch {
          }
        }
      },
    };
  },
});
