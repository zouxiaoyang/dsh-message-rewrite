// dsh-message-rewrite 宿主半：原地编辑历史用户消息 → 同会话截断重跑。
// 机制（适配 DSH 内核 0.1.2-rc.1 / dsh-agent-loop）：
//   1. client 调 RPC /dsh-rewrite/rewrite { sessionId, userSeq, text }
//   2. host 校验 agent idle、目标消息可见；
//   3. 构造新 user message（source.rewrite 标注 targetSeq/targetTurn），
//      agent.followup(message) 放入 inbox 并唤醒 driver；
//   4. 在 agent/pre-step（waterfall、prepend）里拦截：当 driver 准备把该
//      消息 append 成普通 user/message 时，包一层 session.append —— 使这次
//      append 携带 surfaceOp:{op:"replace", start:目标seq, end:尾部节点}，
//      把被编辑消息及其后的旧回复从消息表面替换掉（审计日志仍追加保留）。
//
// 依赖内核 API（0.1.2-rc.1 实测存在）：
//   - ctx.on("agent/pre-step", ({agent,messages,signal}, next), {prepend:true})
//   - agent.session.append(type, data, {surfaceOp, sourceEventSeqs})
//   - agent.followup(message) / agent.status / agent.session.surface.nodes
//   - createUserMessage from @deepseek-ai/dsh-llm
//
// CJS 规范（AGENTS.md）：dsh 内部包一律在 apply() 内延迟 require。
'use strict';

module.exports.name = 'dsh-message-rewrite';
module.exports.inject = ['connection', 'agents'];

function messageIdOf(value) {
  if (typeof value !== 'object' || value === null || !('id' in value)) return undefined;
  return typeof value.id === 'string' ? value.id : undefined;
}

/** 替换 content 中所有 text block 为单一新文本（保留图片等非文本块）。 */
function replaceText(content, text) {
  const output = [];
  let written = false;
  for (const block of content) {
    if (block.type === 'text') {
      if (!written) output.push({ type: 'text', text });
      written = true;
    } else {
      output.push(block);
    }
  }
  if (!written) output.unshift({ type: 'text', text });
  return output;
}

/** 从事件日志里找某 seq 所属的 turn（最近的 turn/start）。 */
function owningTurn(events, seq) {
  for (let index = seq; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'turn/start') return event.data.turn;
  }
  return undefined;
}

/**
 * 计算一次 rewrite 应 shadow（截断）的 surface seq 列表。
 * 规则：从 targetSeq 开始向后收集，直到遇到下一条真正的用户主动消息
 * （source.kind === 'user'）为止——该消息及其后的后续轮次全部保留。
 * @returns seq 数组（至少含 targetSeq 本身）
 */
function computeShadowedSeqs(surfaceNodes, events, targetSeq) {
  const startIndex = surfaceNodes.indexOf(targetSeq);
  if (startIndex < 0) return [targetSeq];
  const shadowed = [targetSeq];
  for (let i = startIndex + 1; i < surfaceNodes.length; i++) {
    const seq = surfaceNodes[i];
    const ev = events[seq];
    if (ev && ev.type === 'user/message' && ev.data && ev.data.source) {
      if (ev.data.source.kind === 'user') break; // 下一条用户主动消息：保留其后
    }
    shadowed.push(seq);
  }
  return shadowed;
}

const ok = (value) => ({ ok: true, value });
const err = (code, message) => ({ ok: false, error: { code, message } });

module.exports.apply = function apply(ctx) {
  /** 同一 session 同一时刻只允许一个 rewrite 在途。 */
  const pendingBySession = new Map(); // sessionId -> pending

  function rejectPending(pending, error) {
    const key = String(pending.agent.id);
    if (pendingBySession.get(key) !== pending) return;
    pendingBySession.delete(key);
    const e = error instanceof Error ? error : new Error(String(error));
    pending.committed.reject(e);
  }

  function resolvePending(pending) {
    const key = String(pending.agent.id);
    if (pendingBySession.get(key) !== pending) return;
    pendingBySession.delete(key);
    pending.committed.resolve(pending.messageId);
  }

  // 全局 pre-step 拦截：若本次 step 即将 append 的消息正是某 pending
  // rewrite 的目标消息，把那次 append 变成 surface replace。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const input = messages.find((message) => {
      for (const pending of pendingBySession.values()) {
        if (pending.messageId === message.id) return true;
      }
      return false;
    });
    console.log(`[dsh-message-rewrite] pre-step fired: pending=${pendingBySession.size} messages=${messages ? messages.length : 0} input=${input ? input.id : 'none'} msgIds=${messages ? messages.map((m) => (m && m.id ? String(m.id).slice(0, 12) : typeof m)) : 'n/a'}`);
    const decision = await next();
    if (input === undefined) return decision;

    let pending;
    for (const p of pendingBySession.values()) {
      if (p.messageId === input.id) { pending = p; break; }
    }
    if (pending === undefined || pending.agent !== agent) return decision;

    if (decision.kind === 'reject' || !decision.messages.some((message) => message.id === input.id)) {
      rejectPending(pending, new Error('the rewrite message was rejected before admission'));
      return decision;
    }
    if (signal.aborted) {
      rejectPending(pending, signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      return { kind: 'reject' };
    }

    const surfaceNodes = agent.session.surface.nodes;
    const startIndex = surfaceNodes.indexOf(pending.targetSeq);
    if (startIndex < 0) {
      rejectPending(pending, new Error('the selected message is no longer visible'));
      return { kind: 'reject' };
    }
    // 只截断"被编辑消息所属轮次"：targetSeq 到（不含）下一条用户主动消息。
    // 用户后续新发的对话轮次全部保留。
    const shadowed = computeShadowedSeqs(surfaceNodes, agent.session.snapshotEvents(), pending.targetSeq);
    const end = shadowed[shadowed.length - 1];
    if (end === undefined) {
      rejectPending(pending, new Error('the selected history tail is empty'));
      return { kind: 'reject' };
    }

    installReplacementAppend(agent.session, pending, shadowed, end, signal);
    return decision;
  }, { prepend: true });

  ctx.on('agent/disposed', ({ agent }) => {
    for (const pending of pendingBySession.values()) {
      if (pending.agent === agent) rejectPending(pending, new Error('the session was disposed during rewrite'));
    }
  });

  /** 包一层 session.append：当 append 的正是 pending 消息时改为 surface replace。 */
  function installReplacementAppend(session, pending, shadowed, end, signal) {
    const original = session.append;
    let active = true;
    const restore = () => {
      if (!active) return;
      active = false;
      signal.removeEventListener('abort', onAbort);
      delete session.append;
    };
    const onAbort = () => {
      restore();
      rejectPending(pending, signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    const replacementAppend = function (type, data, ...args) {
      if (type !== 'user/message' || messageIdOf(data) !== pending.messageId) {
        return Reflect.apply(original, this, [type, data, ...args]);
      }
      restore();
      try {
        const event = Reflect.apply(original, this, [type, data, {
          surfaceOp: { op: 'replace', start: pending.targetSeq, end },
          sourceEventSeqs: [...shadowed],
        }]);
        resolvePending(pending);
        return event;
      } catch (error) {
        rejectPending(pending, error);
        throw error;
      }
    };
    Object.defineProperty(session, 'append', {
      configurable: true,
      writable: true,
      value: replacementAppend,
    });
  }

  // ---------- RPC：client 调用入口 ----------
  /** 列出（可选指定）session 当前 surface 上的全部用户消息（供 client 逐行挂编辑按钮）。
   *  sessionId 缺省时遍历全部 live agents（客户端拿不到 current session 时兜底）。 */
  async function handleList(payload) {
    const request = (payload && payload.value) || payload || {};
    const sessionId = request.sessionId;
    const agents = [];
    if (typeof sessionId === 'string' && sessionId !== '') {
      const agent = ctx.agents && ctx.agents.get(sessionId);
      if (agent === undefined) return err('session-not-found', 'this session is not available');
      agents.push(agent);
    } else {
      // 兜底：遍历全部 live agent（通常一个；GUI 的会话都是普通 agent）
      const all = (ctx.agents && typeof ctx.agents.list === 'function') ? ctx.agents.list() : [];
      for (const a of all) {
        try {
          if (a && a.session && a.session.surface) agents.push(a);
        } catch (e) { /* skip */ }
      }
    }
    if (agents.length === 0) return err('session-not-found', 'no live sessions available');
    const results = [];
    for (const agent of agents) {
      const sid = String(agent.id);
      const surfaceNodes = agent.session.surface.nodes;
      const items = [];
      const rewrites = []; // 编辑后产生的新消息（用于 client 隐藏被截断的旧轮次）
      let userIndex = 0;
      for (const seq of surfaceNodes) {
        const event = agent.session.snapshotEvents()[seq];
        if (!event || event.type !== 'user/message') continue;
        const data = event.data;
        if (!data || !data.source || data.source.kind !== 'user') continue;
        const text = Array.isArray(data.content)
          ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
          : '';
        if (data.source.rewrite) {
          // rewrite 产生的新消息：可继续编辑（编辑链），也加入 items；
          // 同时记录元数据供 client 隐藏被截断的旧轮次。
          // 被 shadow 的旧节点：优先用 replace 事件自带的 sourceEventSeqs，
          // 否则退化用"到下一条用户消息前"的启发式计算。
          const ownTurn = owningTurn(agent.session.snapshotEvents(), seq);
          const targetEv = agent.session.snapshotEvents()[data.source.rewrite.targetSeq];
          const shadowSeqs = Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length
            ? event.sourceEventSeqs
            : computeShadowedSeqs(surfaceNodes, agent.session.snapshotEvents(), data.source.rewrite.targetSeq);
          rewrites.push({
            seq,
            targetSeq: data.source.rewrite.targetSeq,
            targetTurn: data.source.rewrite.targetTurn,
            newTurn: ownTurn,
            text,
            targetId: targetEv && targetEv.data && targetEv.data.id ? targetEv.data.id : null,
            shadowSeqs,
          });
        }
        items.push({
          seq,
          index: userIndex,
          id: typeof data.id === 'string' ? data.id : (typeof data.messageId === 'string' ? data.messageId : null),
          text,
          hasImage: Array.isArray(data.content) && data.content.some((b) => b && b.type === 'image'),
          isRewrite: !!data.source.rewrite,
          rewriteTarget: data.source.rewrite ? data.source.rewrite.targetSeq : null,
        });
        userIndex += 1;
      }
      results.push({ sessionId: sid, items, rewrites, busy: agent.status !== 'idle' });
    }
    return ok({ sessions: results });
  }

  /** 诊断：dump 某 session 事件（含 surfaceOp / source / type）。 */
  async function handleDebug(payload) {
    const request = (payload && payload.value) || payload || {};
    const sessionId = request.sessionId;
    const agent = ctx.agents && ctx.agents.get(sessionId);
    if (agent === undefined) return err('session-not-found', 'this session is not available');
    const events = agent.session.snapshotEvents();
    const surfaceNodes = agent.session.surface.nodes;
    const want = typeof request.want === 'string' ? request.want : 'tail';
    const limit = request.limit || 400;
    let slice;
    if (want === 'turns') {
      slice = events.filter((ev) => ev.type === 'user/message').slice(-limit).map((ev) => ({
        seq: ev.seq,
        id: ev.data && ev.data.id ? String(ev.data.id).slice(0, 8) : null,
        turn: owningTurn(events, ev.seq),
        text: Array.isArray(ev.data && ev.data.content) ? ev.data.content.map((b) => b.type === 'text' ? b.text.slice(0, 20) : '').join('|') : '',
      }));
    } else if (want === 'users') {
      // 只返回 user/message 事件（全量）
      slice = events.filter((ev) => ev.type === 'user/message').map((ev) => ({
        seq: ev.seq,
        surfaceOp: ev.surfaceOp || null,
        srcSeqs: ev.sourceEventSeqs || null,
        data: {
          source: ev.data && ev.data.source,
          id: ev.data && ev.data.id ? String(ev.data.id).slice(0, 12) : null,
          contentText: Array.isArray(ev.data && ev.data.content) ? ev.data.content.map((b) => b.type === 'text' ? b.text.slice(0, 40) : '[' + b.type + ']').join('|') : null,
        },
      })).slice(-limit);
    } else {
      slice = events.slice(-limit).map((ev) => ({
        seq: ev.seq,
        type: ev.type,
        surfaceOp: ev.surfaceOp || null,
        srcSeqs: ev.sourceEventSeqs || null,
        data: ev.type === 'user/message'
          ? { source: ev.data && ev.data.source, contentText: Array.isArray(ev.data && ev.data.content) ? ev.data.content.map((b) => b.type === 'text' ? b.text.slice(0, 30) : '[' + b.type + ']').join('|') : null }
          : undefined,
      }));
    }
    return ok({
      sessionId,
      surfaceNodes: surfaceNodes.slice(-40),
      surfaceSize: surfaceNodes.length,
      shadowedGone: !surfaceNodes.includes(122299) && !surfaceNodes.includes(122301) && !surfaceNodes.includes(125641),
      events: slice,
      totalEvents: events.length,
    });
  }

  /**
   * 判断 M(seq=userSeq) 之后是否还有更新的用户消息（surface 顺序）。
   * 有 → 编辑中间消息，需开新分支；无 → M 是最后一条用户消息，可原地截断。
   */
  function hasLaterUserMessage(agent, userSeq) {
    const nodes = agent.session.surface.nodes;
    const startIdx = nodes.indexOf(userSeq);
    if (startIdx < 0) return false;
    for (let i = startIdx + 1; i < nodes.length; i++) {
      const event = agent.session.snapshotEvents()[nodes[i]];
      if (event && event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') {
        return true;
      }
    }
    return false;
  }

  /**
   * fork 路径：M 后有更新的用户对话 → 新会话复制到 M 所在轮之前，
   * 在新会话里发送编辑后的消息并重跑。原会话保持不变。
   */
  async function forkRewrite(agent, userSeq, editedText, createUserMessageFn) {
    const events = agent.session.snapshotEvents();
    const targetTurn = owningTurn(events, userSeq);
    if (targetTurn === undefined) return err('message-not-found', 'the selected user message has no owning turn');
    // 找 M 所在轮 turn/start 的位置：新会话 seed 到它之前
    let cut = 0;
    for (let i = userSeq; i >= 0; i--) {
      const ev = events[i];
      if (ev && ev.type === 'turn/start' && ev.data && ev.data.turn === targetTurn) { cut = i; break; }
    }
    const seed = events.slice(0, cut);
    const childId = 'session-' + (require('node:crypto').randomUUID());
    const cwd = agent.session.header.cwd;
    // 新会话模型路由：优先取来源 agent 已用模型（requestHeader），失败则默认
    let selection = { provider: undefined, model: undefined };
    try {
      const header = agent.session.requestHeader && agent.session.requestHeader();
      if (header && header.config) selection = { provider: header.config.provider, model: header.config.model };
    } catch (e) { /* ignore */ }
    if (!selection.provider) {
      try {
        const adm = ctx.get && ctx.get('agentDefaultModel');
        if (adm && typeof adm.currentSelection === 'function') selection = adm.currentSelection() || selection;
      } catch (e2) { /* ignore */ }
    }
    try {
      await ctx.agents.create({
        sessionId: childId,
        seed,
        inheritedEventCount: seed.length,
        meta: {
          ...(cwd !== undefined ? { cwd } : {}),
          parentSession: agent.id,
          isSeeded: true,
        },
        ...(selection && selection.provider ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
      });
    } catch (e) {
      console.error('[dsh-message-rewrite] fork create failed:', e instanceof Error ? e.message : String(e));
      return err('fork-failed', 'failed to fork session: ' + (e instanceof Error ? e.message : String(e)));
    }
    const childAgent = ctx.agents.get(childId);
    if (childAgent === undefined) return err('fork-failed', 'forked session is not live');
    // 新会话里发编辑后的文本（普通用户消息，无 rewrite 标记）
    const plain = createUserMessageFn({ content: [{ type: 'text', text: editedText }], source: { kind: 'user' } });
    try {
      console.log(`[dsh-message-rewrite] fork-rewrite: ${childId} <- followup msg=${plain.id}`);
      childAgent.followup(plain);
    } catch (e) {
      console.error('[dsh-message-rewrite] fork followup failed:', e instanceof Error ? e.message : String(e));
      return err('fork-failed', 'failed to start fork: ' + (e instanceof Error ? e.message : String(e)));
    }
    return ok({ forked: true, sessionId: childId, messageId: plain.id });
  }

  async function handleRewrite(payload) {
    const request = (payload && payload.value) || payload || {};
    const sessionId = request.sessionId;
    const userSeq = request.userSeq;
    const text = typeof request.text === 'string' ? request.text.trim() : '';

    if (typeof sessionId !== 'string' || sessionId === '') return err('invalid-request', 'sessionId is required');
    if (!Number.isSafeInteger(userSeq) || userSeq < 0) return err('invalid-request', 'userSeq must be a non-negative integer');
    if (text === '') return err('invalid-text', 'message text cannot be empty');

    // 延迟加载 dsh-llm（ESM，动态 import）
    let createUserMessage;
    try {
      const llm = await import('@deepseek-ai/dsh-llm');
      createUserMessage = llm.createUserMessage;
    } catch (e) {
      return err('internal', 'cannot load @deepseek-ai/dsh-llm: ' + (e instanceof Error ? e.message : String(e)));
    }

    const agent = ctx.agents && ctx.agents.get(sessionId);
    if (agent === undefined) return err('session-not-found', 'this session is not available');
    if (agent.status !== 'idle') return err('agent-busy', 'the agent is still running');
    if (pendingBySession.has(String(sessionId))) return err('rewrite-conflict', 'another rewrite is already pending for this session');

    const events = agent.session.snapshotEvents();
    const source = events[userSeq];
    if (!source || source.type !== 'user/message' || !source.data || !source.data.source || source.data.source.kind !== 'user') {
      return err('message-not-found', 'the selected user message is no longer visible');
    }
    if (!agent.session.surface.nodes.includes(userSeq)) {
      return err('message-not-found', 'the selected user message is no longer visible');
    }
    const targetTurn = owningTurn(events, userSeq);
    if (targetTurn === undefined) return err('message-not-found', 'the selected user message has no owning turn');

    const message = createUserMessage({
      content: replaceText(source.data.content, text),
      source: {
        kind: 'user',
        rewrite: { targetSeq: userSeq, targetTurn },
      },
    });

    // 分流：M 之后若还有更新的用户对话 → fork 新分支（保留原会话后续内容）；
    // 否则原地截断重跑。
    if (hasLaterUserMessage(agent, userSeq)) {
      console.log(`[dsh-message-rewrite] rewrite: session=${sessionId} userSeq=${userSeq} has LATER user messages -> fork path`);
      return forkRewrite(agent, userSeq, text, createUserMessage);
    }

    const committed = Promise.withResolvers();
    const pending = {
      agent,
      targetSeq: userSeq,
      messageId: message.id,
      committed,
    };
    pendingBySession.set(String(sessionId), pending);

    try {
      console.log(`[dsh-message-rewrite] rewrite: session=${sessionId} userSeq=${userSeq} -> followup msg=${message.id} status=${agent.status}`);
      agent.followup(message);
      console.log('[dsh-message-rewrite] rewrite: followup sent, waiting committed...');
      await committed.promise;
      console.log('[dsh-message-rewrite] rewrite: committed (surface replaced)');
      return ok({ userSeq: pending.targetSeq, messageId: pending.messageId });
    } catch (error) {
      console.error('[dsh-message-rewrite] rewrite failed:', error instanceof Error ? error.message : String(error));
      rejectPending(pending, error);
      return err('rewrite-conflict', error instanceof Error ? error.message : 'rewrite failed');
    }
  }

  // 注册 RPC channel（client fetch /dsh-rewrite/rewrite）
  const rpc = ctx && ctx.connection && ctx.connection.rpc;
  if (rpc && typeof rpc.handle === 'function') {
    rpc.handle('/dsh-rewrite', async (endpoint, payload, _signal) => {
      if (endpoint === 'rewrite') return handleRewrite(payload);
      if (endpoint === 'list') return handleList(payload);
      if (endpoint === 'debug') return handleDebug(payload);
      if (endpoint === 'canEdit') {
        const request = (payload && payload.value) || payload || {};
        const agent = ctx.agents && ctx.agents.get(request.sessionId);
        if (!agent) return { ok: true, value: { editable: false, reason: 'session-not-found' } };
        const source = agent.session.snapshotEvents()[request.userSeq];
        const editable = !!source && source.type === 'user/message' && !!source.data && !!source.data.source && source.data.source.kind === 'user'
          && agent.session.surface.nodes.includes(request.userSeq);
        return { ok: true, value: { editable, busy: agent.status !== 'idle' } };
      }
      return { ok: false, error: 'unknown endpoint: ' + endpoint };
    }, { authority: 'loopback' });
    console.log('[dsh-message-rewrite] 已注册 RPC channel /dsh-rewrite');
  } else {
    console.error('[dsh-message-rewrite] 无 rpc.handle 可用，rewrite 功能不可用');
  }
};
