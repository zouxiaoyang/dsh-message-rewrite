/**
 * dsh-message-rewrite 客户端半：Codex 风格"原地编辑历史用户消息 → 同会话截断重跑"。
 *
 * 做法（尽量不依赖官方 UI 内部实现，只依赖稳定 DOM 契约）：
 *   - 官方消息列表由 @deepseek-ai/dsh-client-ui-chat 渲染，用户消息行带
 *     `data-chat-flow-kind="user"` 与 `data-chat-anchor-key`（rc.1 实测保留）。
 *   - 插件作为 `conversation.session.header.utilities` slot occupant 存在，
 *     拿到当前 sessionId；随后扫描消息区 DOM，给每条用户消息行追加"✎ 编辑"。
 *   - 点击编辑 → 行内气泡切换为 textarea → 发送 → POST /dsh-rewrite/rewrite
 *     { sessionId, userSeq, text }（同源 client-request RPC）。
 *   - 行 ↔ seq 映射：调用 host /dsh-rewrite/list 取该 session 全部可编辑用户
 *     消息（按 surface 顺序），与 DOM 中用户行按出现顺序一一对应。
 *
 * 兼容 codex-ui：codex-ui 的消息列表来自官方 chat 组件，仅叠加样式；本插件
 * 只往官方行内追加一个按钮，不依赖任何 dcu-* 私有类名。视觉用官方 CSS
 * 变量（--fg-muted 等），浅/深色主题自动适配。
 */
window.__ModuleLoader__.load({
  id: "@deepseek-ai/message-rewrite",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var RPC = "/dsh-rewrite";
    var STYLE_ID = "dsh-message-rewrite-style";
    var NS = "dsh-message-rewrite";

    // ---------- 样式 ----------
    function injectStyles() {
      if (document.getElementById(STYLE_ID)) return;
      var css = [
        ".dsh-mr-actions{display:inline-flex;align-items:center;gap:4px;opacity:0;transition:opacity .12s ease}",
        "[data-chat-flow-kind=user]:hover .dsh-mr-actions,.dsh-mr-row-edit .dsh-mr-actions{opacity:1}",
        ".dsh-mr-edit-btn{min-height:22px;padding:1px 7px;border:0;border-radius:6px;background:transparent;color:var(--fg-muted,#667085);font:inherit;font-size:11.5px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;gap:3px}",
        ".dsh-mr-edit-btn:hover{color:var(--fg-default,#202124);background:var(--bg-hover,rgba(0,0,0,.05))}",
        "body[data-ds-dark-theme] .dsh-mr-edit-btn{color:var(--fg-muted,#9aa3ad)}",
        "body[data-ds-dark-theme] .dsh-mr-edit-btn:hover{color:var(--fg-default,#e8eaed);background:rgba(255,255,255,.08)}",
        ".dsh-mr-edit-btn svg{width:12px;height:12px;flex:none}",
        ".dsh-mr-edit-btn:disabled{cursor:not-allowed;opacity:.4}",
        // 编辑态：隐藏原气泡内容，只显示编辑框
        "[data-chat-flow-kind=user].dsh-mr-editing>[data-chat-flow-content]{display:none}",
        "[data-chat-flow-kind=user].dsh-mr-editing>[data-message-rewrite-host]{display:block}",
        ".dsh-mr-host{display:none;width:min(100%,720px);margin:2px 0 0 auto}",
        // 被 rewrite 截断（shadow）的旧行：隐藏
        "[data-chat-flow-kind][data-message-rewrite-discarded]{display:none!important}",
        // "编辑后"消息气泡（UI 不渲染 replace 新节点，插件补绘）
        ".dsh-mr-bubble{display:flex;flex-direction:column;align-items:flex-end;gap:3px;margin:2px 0 8px auto;width:fit-content;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%)}",
        ".dsh-mr-bubble-top{display:flex;align-items:center;gap:8px;padding-right:4px}",
        ".dsh-mr-bubble-mark{font-size:11px;color:var(--fg-muted,#8892a0);display:inline-flex;align-items:center;gap:2px}",
        ".dsh-mr-bubble-edit-btn{display:none;min-height:20px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--fg-muted,#8892a0);font:inherit;font-size:11px;line-height:20px;cursor:pointer}",
        ".dsh-mr-bubble:hover .dsh-mr-bubble-edit-btn{display:inline-flex;align-items:center;gap:2px}",
        ".dsh-mr-bubble-edit-btn:hover{color:var(--fg-default,#202124);background:var(--bg-hover,rgba(0,0,0,.06))}",
        "body[data-ds-dark-theme] .dsh-mr-bubble-edit-btn:hover{color:var(--fg-default,#e8eaed);background:rgba(255,255,255,.1)}",
        ".dsh-mr-bubble-text{background:var(--dsw-specific-bubble,#4f6ef7);color:var(--dsw-alias-label-primary,#fff);white-space:pre-wrap;word-break:break-word;border-radius:22px;padding:10px 16px;font-size:var(--dsh-content-font-size,14px);line-height:1.55;box-shadow:0 0 0 1.5px var(--accent,#4f6ef7) inset}",
        "body[data-ds-dark-theme] .dsh-mr-bubble-text{background:var(--dsw-specific-bubble,#3b5bdb);color:#fff}",
        ".dsh-mr-bubble .dsh-mr-editor{width:min(100%,720px)}",
        ".dsh-mr-bubble.dsh-mr-bubble-editing .dsh-mr-bubble-text{display:none}",
        // ---- 再次编辑：居中精致浮层 ----
        ".dsh-mr-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(10,14,22,.36);backdrop-filter:blur(8px) saturate(1.2);-webkit-backdrop-filter:blur(8px) saturate(1.2);animation:dshMrFade .18s ease-out}",
        "body[data-ds-dark-theme] .dsh-mr-overlay{background:rgba(0,0,0,.52)}",
        "@keyframes dshMrFade{from{opacity:0}to{opacity:1}}",
        ".dsh-mr-modal{--mr-bg:#ffffff;--mr-fg:#1b2230;--mr-fg2:#5c6573;--mr-fg3:#8a93a3;--mr-line:rgba(18,26,44,.09);--mr-line2:rgba(18,26,44,.16);--mr-field:#f5f7fb;--mr-accent:#4f6ef7;--mr-accent2:#7a93ff;--mr-err:#e5484d;--mr-shadow:0 1px 2px rgba(12,18,32,.04),0 26px 70px -10px rgba(12,20,45,.30);display:flex;flex-direction:column;width:min(640px,100%);max-height:min(600px,calc(100vh - 96px));background:var(--mr-bg);color:var(--mr-fg);border:1px solid var(--mr-line);border-radius:20px;box-shadow:var(--mr-shadow);overflow:hidden;animation:dshMrPop .24s cubic-bezier(.18,.9,.28,1.15)}",
        "body[data-ds-dark-theme] .dsh-mr-modal{--mr-bg:#1b2029;--mr-fg:#e8ecf4;--mr-fg2:#9aa4b3;--mr-fg3:#66707e;--mr-line:rgba(255,255,255,.08);--mr-line2:rgba(255,255,255,.15);--mr-field:#131823;--mr-accent:#6d8bff;--mr-accent2:#8da5ff;--mr-err:#ff7a80;--mr-shadow:0 1px 2px rgba(0,0,0,.35),0 30px 90px -8px rgba(0,0,0,.6)}",
        "@keyframes dshMrPop{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}",
        ".dsh-mr-modal-head{display:flex;align-items:center;gap:11px;padding:15px 20px 13px;border-bottom:1px solid var(--mr-line)}",
        ".dsh-mr-modal-ic{width:32px;height:32px;flex:none;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,var(--mr-accent),var(--mr-accent2));box-shadow:0 5px 14px -3px color-mix(in srgb,var(--mr-accent) 60%,transparent)}",
        ".dsh-mr-modal-ic svg{width:15px;height:15px}",
        ".dsh-mr-modal-tt{font-size:14.5px;font-weight:650;letter-spacing:.1px;line-height:1.3}",
        ".dsh-mr-modal-st{font-size:11.5px;color:var(--mr-fg3);margin-top:2px;line-height:1.4}",
        ".dsh-mr-modal-x{margin-left:auto;width:30px;height:30px;flex:none;border:0;border-radius:9px;background:transparent;color:var(--mr-fg3);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}",
        ".dsh-mr-modal-x:hover{background:var(--mr-line);color:var(--mr-fg)}",
        ".dsh-mr-modal-x svg{width:14px;height:14px}",
        ".dsh-mr-modal-body{padding:18px 20px 6px;overflow-y:auto;flex:1}",
        ".dsh-mr-modal-ta{box-sizing:border-box;width:100%;min-height:170px;resize:vertical;padding:14px 16px;border:1.5px solid var(--mr-line2);border-radius:14px;background:var(--mr-field);color:inherit;font:inherit;font-size:14px;line-height:1.68;outline:none;caret-color:var(--mr-accent);transition:border-color .16s ease,box-shadow .16s ease}",
        ".dsh-mr-modal-ta:focus{border-color:var(--mr-accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--mr-accent) 18%,transparent)}",
        ".dsh-mr-modal-ta::placeholder{color:var(--mr-fg3)}",
        ".dsh-mr-modal-err{display:flex;align-items:center;gap:7px;margin:10px 2px 2px;font-size:12.5px;color:var(--mr-err);animation:dshMrShake .32s ease}",
        "@keyframes dshMrShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}45%{transform:translateX(4px)}70%{transform:translateX(-3px)}}",
        ".dsh-mr-modal-err svg{width:13px;height:13px;flex:none}",
        ".dsh-mr-modal-foot{display:flex;align-items:center;gap:10px;padding:13px 20px 16px;border-top:1px solid var(--mr-line)}",
        ".dsh-mr-modal-hint{margin-right:auto;font-size:11.5px;color:var(--mr-fg3);display:flex;align-items:center;gap:5px;white-space:nowrap}",
        ".dsh-mr-modal-hint kbd{font-family:inherit;font-size:10.5px;padding:2px 5.5px;border-radius:5px;border:1px solid var(--mr-line2);background:var(--mr-field);color:var(--mr-fg2)}",
        ".dsh-mr-modal-btns{display:flex;gap:9px;flex:none}",
        ".dsh-mr-modal-btn{border:1px solid var(--mr-line2);background:transparent;color:var(--mr-fg2);border-radius:10px;padding:8px 18px;font:inherit;font-size:12.5px;font-weight:550;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .15s,border-color .15s,color .15s,transform .06s}",
        ".dsh-mr-modal-btn:hover{background:var(--mr-line);color:var(--mr-fg)}",
        ".dsh-mr-modal-btn:active{transform:scale(.97)}",
        ".dsh-mr-modal-btn.pri{border-color:transparent;color:#fff;background:linear-gradient(135deg,var(--mr-accent),var(--mr-accent2));box-shadow:0 5px 16px -5px color-mix(in srgb,var(--mr-accent) 65%,transparent)}",
        ".dsh-mr-modal-btn.pri:hover{filter:brightness(1.08);color:#fff}",
        ".dsh-mr-modal-btn.pri:disabled{cursor:wait;opacity:.7;filter:none}",
        ".dsh-mr-modal-btn .dsh-mr-spin{display:inline-block;width:12px;height:12px;flex:none;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:dshMrSpin .7s linear infinite}",
        "@keyframes dshMrSpin{to{transform:rotate(360deg)}}",
        ".dsh-mr-modal-char{font-size:11px;color:var(--mr-fg3);margin-left:auto;font-variant-numeric:tabular-nums}",
      ].join("\n");
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = css;
      document.head.appendChild(style);
    }

    // ---------- 工具 ----------
    function postRpc(method, value) {
      return new Promise(function (resolve) {
        fetch(RPC + "/" + method, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "client-request",
            rpcId: NS + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
            method: method,
            payload: { value: value },
          }),
        })
          .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
          .then(function (msg) {
            // server-response: { type, rpcId, result: { ok, value | error } }
            if (msg && msg.type === "server-response" && msg.result) {
              var r = msg.result;
              if (r.ok) resolve({ ok: true, value: r.value });
              else {
                var e = r.error || {};
                resolve({ ok: false, code: e.code || "rpc-error", message: e.message || JSON.stringify(e) });
              }
            } else {
              resolve({ ok: false, code: "bad-response", message: "RPC 响应格式异常" });
            }
          })
          .catch(function (err) {
            resolve({ ok: false, code: "network", message: String(err && err.message || err) });
          });
      });
    }

    function textOf(content) {
      if (!Array.isArray(content)) return "";
      return content.filter(function (b) { return b && b.type === "text"; })
        .map(function (b) { return b.text; }).join("\n");
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    /** 取 DOM 用户消息行的可见文本（排除我们自己注入的按钮区）。 */
    function rowTextOf(row) {
      var clone = row.cloneNode(true);
      var acts = clone.querySelector(".dsh-mr-actions");
      if (acts) acts.remove();
      var host = clone.querySelector(".dsh-mr-host");
      if (host) host.remove();
      return clone.innerText || clone.textContent || "";
    }

    /** 空白规范化，用于文本近似比较。 */
    function normalizeWs(s) {
      return String(s).replace(/\s+/g, " ").trim();
    }

    // ---------- 状态 ----------
    var active = false; // 当前是否有编辑框打开
    var busy = false;   // rewrite 请求进行中

    function userRowKey(row) { return row.getAttribute("data-chat-anchor-key") || ""; }
    function isUserRow(row) { return row.getAttribute("data-chat-flow-kind") === "user"; }

    /**
     * 给一条用户消息行挂上编辑按钮（幂等：行上已有且 uuid 一致的 .dsh-mr-actions
     * 则跳过；uuid 不一致（虚拟滚动复用 DOM 行）则先移除旧的再重挂）。
     * @param row DOM 行
     * @param sessionId 所属会话 id
     * @param seq 该行对应的 session 事件 seq（host list 提供）
     * @param text 当前文本
     * @param sessionBusy agent 是否运行中（禁用编辑）
     */
    function mountEditControl(row, sessionId, seq, text, sessionBusy) {
      var rowUuid = uuidOfKey(userRowKey(row));
      var existing = row.querySelector(":scope > .dsh-mr-actions");
      if (existing) {
        if (existing.getAttribute("data-mr-uuid") === rowUuid) {
          // 已挂载：无需更新（按钮不再随 busy 禁用）
          return;
        }
        existing.remove(); // 挂错/旧 uuid → 移除重挂
        // 若该行正处于编辑态，一并清理
        if (row.classList.contains("dsh-mr-editing")) {
          row.classList.remove("dsh-mr-editing");
          var oldHost = row.querySelector(":scope > .dsh-mr-host");
          if (oldHost) oldHost.remove();
          active = false;
        }
      }

      // 编辑按钮容器 —— 追加到行尾（flex 行右对齐通常自然靠右）
      var actions = document.createElement("div");
      actions.className = "dsh-mr-actions";
      actions.setAttribute("data-mr-uuid", rowUuid || "");
      actions.setAttribute("data-mr-session", sessionId);
      actions.setAttribute("data-mr-seq", String(seq));

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dsh-mr-edit-btn";
      btn.title = "编辑这条消息，从这之后重新生成";
      btn.setAttribute("aria-label", "编辑这条消息");
      // 注意：不再因 sessionBusy 置 disabled——busy 时点击仍可打开编辑框，
      // 提交时若 agent 忙会得到 host 的 agent-busy 明确提示（避免"点了没反应"）
      btn.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.3a1.6 1.6 0 0 1 2.3 2.3L6 12.2 2.8 13.2 3.8 10z"/></svg>' +
        "<span>\u270e\u7f16\u8f91</span>";
      actions.appendChild(btn);
      row.appendChild(actions);

      btn.addEventListener("click", function () {
        // busy（rewrite 在途）/ sessionBusy（agent 运行）不拦截打开——
        // 用户可先编辑，提交时得到明确提示。sessionBusy 时按钮已置 disabled
        // 作为视觉提示，此处仅处理 active 冲突。
        if (active) {
          var otherEditing = document.querySelector(".dsh-mr-bubble.dsh-mr-bubble-editing, [data-chat-flow-kind=user].dsh-mr-editing");
          if (otherEditing && otherEditing !== row) {
            if (otherEditing.classList.contains("dsh-mr-bubble-editing")) {
              otherEditing.classList.remove("dsh-mr-bubble-editing");
              otherEditing.innerHTML = "";
            } else {
              otherEditing.classList.remove("dsh-mr-editing");
              var oldHost = otherEditing.querySelector(":scope > .dsh-mr-host");
              if (oldHost) oldHost.style.display = "none";
            }
            active = false;
          } else if (otherEditing === row) {
            return;
          }
        }
        openEditor(row, sessionId, seq, text);
      });
    }

    /** 打开编辑浮层（首次编辑入口）。 */
    function openEditor(row, sessionId, seq, text) {
      openEditModal(sessionId, seq, text);
    }

    function closeEditor(row) {
      // 行内编辑已废弃（统一浮层）；兼容旧调用
      closeModal();
    }

    function errorText(code) {
      switch (code) {
        case "invalid-text": return "消息内容不能为空";
        case "agent-busy": return "Agent 正在运行，请先等待本轮结束";
        case "rewrite-conflict": return "已有正在进行的改写";
        case "message-not-found": return "该消息已不在当前会话可见范围";
        case "session-not-found": return "会话不可用";
        default: return "改写失败";
      }
    }

    function showError(p, msg) { if (p) { p.textContent = msg; p.style.display = ""; } }
    function hideError(p) { if (p) { p.textContent = ""; p.style.display = "none"; } }

    // ---------- 会话 id ----------
    var _sessionId = null;
    var sessionsService = null; // 由 apply 注入（供 fork 后切会话）
    function currentSessionId() { return _sessionId; }

    // ---------- 核心：扫描 + 挂载 ----------
    /**
     * 扫描页面消息区：调 host /dsh-rewrite/list（不带 sessionId = 遍历全部
     * live agents），把 DOM 用户行与 host 消息用 uuid 精确对应并挂按钮。
     *
     * 对应依据（2026-09-05 实测确认）：
     *   - 官方 UI 用户行 data-chat-anchor-key 形如 "{turn}:input-message{uuid}"
     *   - host list 返回的每条消息 id 就是该 uuid（session user/message 事件
     *     的 data.id）→ 提取 DOM key 的 uuid 与 host item.id 相等即精确匹配，
     *     彻底避免虚拟滚动 + 重复文本造成的错位。
     */
    function uuidOfKey(key) {
      if (!key) return null;
      var m = String(key).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      return m ? m[1].toLowerCase() : null;
    }

    function rescan() {
      postRpc("list", {}).then(function (res) {
        if (!res.ok) return;
        var sessions = (res.value && res.value.sessions) || [];
        // 先统一收集 rewrite 信息：discard turn 集合 + 气泡渲染数据。
        // 只隐藏"被编辑消息那一轮"（targetTurn）的旧行——该消息之后用户
        // 后续新发的对话轮次全部保留（不隐藏）。
        var discardTurns = {};  // turn -> true
        var rewriteList = [];   // 全部 rewrite 记录（含 sid/targetId/text 等）
        sessions.forEach(function (session) {
          (session.rewrites || []).forEach(function (rw) {
            if (rw && Number.isSafeInteger(rw.targetTurn)) {
              discardTurns[String(rw.targetTurn)] = true;
            }
            if (rw && rw.targetId) {
              rewriteList.push({
                sessionId: session.sessionId,
                targetId: rw.targetId,
                targetSeq: rw.targetSeq,
                newTurn: rw.newTurn,
                text: rw.text || '',
                seq: rw.seq,
              });
            }
          });
        });
        // 给所有消息行打 discarded 标记（含 user/assistant/tool 行）
        markDiscardedRows(discardTurns);
        // 渲染"编辑后"消息气泡（UI 不渲染 replace 节点，需插件补）
        renderRewriteBubbles(rewriteList);
        // 挂编辑按钮
        sessions.forEach(function (session) {
          var sid = session.sessionId;
          var items = session.items || [];
          // 空会话无可编辑消息：跳过
          if (items.length === 0) return;
          // id -> item 索引（uuid 小写比较）
          var byId = {};
          items.forEach(function (it) {
            if (it.id) byId[String(it.id).toLowerCase()] = it;
          });
          // 收集 DOM 用户行
          var rows = [];
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            var el = walker.currentNode;
            if (el.nodeType !== 1) continue;
            if (el.hasAttribute("data-chat-flow-kind") && isUserRow(el) && el.hasAttribute("data-chat-anchor-key")) {
              rows.push(el);
            }
          }
          rows.forEach(function (row) {
            var uuid = uuidOfKey(userRowKey(row));
            var item = uuid ? byId[uuid] : undefined;
            if (!item) {
              // uuid 未在本 session 的 host 列表。若行上挂着属于本 session 的
              // 旧按钮（data-mr-session 相同且 uuid 不同 = 文本错位时代残留）
              // 则移除；属于其他 session 的不动。
              var stale = row.querySelector(":scope > .dsh-mr-actions");
              if (stale && stale.getAttribute("data-mr-session") === sid) stale.remove();
              return;
            }
            mountEditControl(row, sid, item.seq, item.text, session.busy);
          });
        });
      });
    }

    /** 给 turn 属于被编辑轮次（discardTurns）内的消息行打隐藏标记。 */
    function markDiscardedRows(discardTurns) {
      var keys = Object.keys(discardTurns);
      if (!keys.length) {
        // 无任何 rewrite：清除全部历史标记（避免残留隐藏）
        var old = document.querySelectorAll("[data-message-rewrite-discarded]");
        for (var i = 0; i < old.length; i++) delete old[i].dataset.messageRewriteDiscarded;
        return;
      }
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      var seen = [];
      while (walker.nextNode()) {
        var el = walker.currentNode;
        if (el.nodeType !== 1) continue;
        if (!el.hasAttribute("data-chat-flow-kind") || !el.hasAttribute("data-chat-anchor-key")) continue;
        if (!el.hasAttribute("data-chat-turn")) continue;
        var turnRaw = el.getAttribute("data-chat-turn");
        var turn = parseInt(turnRaw, 10);
        if (!Number.isSafeInteger(turn)) continue;
        var discarded = Object.prototype.hasOwnProperty.call(discardTurns, String(turn));
        if (discarded) el.setAttribute("data-message-rewrite-discarded", "");
        else el.removeAttribute("data-message-rewrite-discarded");
        seen.push(el);
      }
    }

    /**
     * 渲染"编辑后"的用户消息气泡。
     * rc.1 官方 UI 不渲染 surface replace 产生的新 user 节点（replace 只进
     * 模型 surface / 客户端投影，聊天列表忽略它），所以插件在被编辑消息的
     * 原始行之后补一个官方风格的用户气泡，展示编辑后的文本。
     * 气泡支持"再次编辑"（Codex 式编辑链）：hover 出现 ✎，点击行内编辑。
     *
     * 锚点策略（虚拟滚动下 DOM 只含视口行）：
     *   1. 优先找被编辑消息原行（uuid == targetId）→ 插它后面；
     *   2. 找不到（行被虚拟列表回收）→ 找 newTurn 的第一条可见行 → 插它前面。
     * 幂等：按 data-mr-bubble=seq 去重。编辑链旧气泡（被再次编辑）移除。
     */
    function renderRewriteBubbles(rewrites, sessionsById) {
      // 增量更新：保留已有气泡（含编辑态），只处理新增/变化；被链式替换的旧
      // 气泡（某 rewrite 的 targetSeq 指向它）以及不在列表里的气泡移除——
      // 只显示编辑链末端的气泡。
      var superseded = {};
      rewrites.forEach(function (rw) {
        if (rw.targetSeq) superseded[String(rw.targetSeq)] = true;
      });
      var validSeqs = {};
      rewrites.forEach(function (rw) {
        if (!superseded[String(rw.seq)]) validSeqs[String(rw.seq)] = true;
      });
      var olds = document.querySelectorAll("[data-mr-bubble]");
      for (var i = 0; i < olds.length; i++) {
        var ob = olds[i];
        var oseq = ob.getAttribute("data-mr-bubble");
        if (!validSeqs[oseq]) { if (ob.parentNode) ob.parentNode.removeChild(ob); }
      }
      // 若没有编辑中的气泡但 active 仍为 true（上次重建丢失导致卡死），复位
      if (active && !document.querySelector(".dsh-mr-bubble.dsh-mr-bubble-editing, [data-chat-flow-kind=user].dsh-mr-editing")) {
        active = false;
      }

      rewrites.forEach(function (rw) {
        // 被链式取代的 rewrite 不再渲染
        if (superseded[String(rw.seq)]) return;
        // 已存在且未在编辑中的气泡：仅当文本变化时更新文本（避免打断 hover）
        var existing = document.querySelector('[data-mr-bubble="' + rw.seq + '"]');
        if (existing) {
          if (!existing.classList.contains("dsh-mr-bubble-editing")) {
            var txtEl = existing.querySelector(".dsh-mr-bubble-text");
            if (txtEl && txtEl.textContent !== rw.text) txtEl.textContent = rw.text;
          }
          return;
        }
        // 新建气泡
        var bubble = document.createElement("div");
        bubble.setAttribute("data-mr-bubble", String(rw.seq));
        bubble.setAttribute("data-mr-session", rw.sessionId || "");
        bubble.className = "dsh-mr-bubble";

        // 锚点 1：被编辑消息原行（uuid == targetId）
        var anchor = null;
        var insertMode = "after";
        var uuid = String(rw.targetId || "").toLowerCase();
        if (uuid) {
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            var el = walker.currentNode;
            if (el.nodeType !== 1) continue;
            if (!el.hasAttribute("data-chat-anchor-key")) continue;
            var m = uuidOfKey(el.getAttribute("data-chat-anchor-key"));
            if (m === uuid) { anchor = el; break; }
          }
        }
        // 锚点 2：newTurn 的第一条行（若锚点1 不在 DOM）
        if (!anchor && Number.isSafeInteger(rw.newTurn)) {
          var firstOfTurn = null;
          var walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker2.nextNode()) {
            var el2 = walker2.currentNode;
            if (el2.nodeType !== 1) continue;
            if (!el2.hasAttribute("data-chat-flow-kind") || !el2.hasAttribute("data-chat-anchor-key")) continue;
            if (el2.getAttribute("data-chat-turn") === String(rw.newTurn)) { firstOfTurn = el2; break; }
          }
          if (firstOfTurn) {
            anchor = firstOfTurn;
            insertMode = "before";
          }
        }
        if (!anchor) return; // 虚拟滚动未加载相关行：等下次 rescan

        if (insertMode === "before") anchor.insertAdjacentElement("beforebegin", bubble);
        else anchor.insertAdjacentElement("afterend", bubble);
        buildBubbleView(bubble, rw);
      });
    }

    /** 气泡查看态：✎ 已编辑 + 文本 + hover 再次编辑按钮。 */
    function buildBubbleView(bubble, rw) {
      bubble.innerHTML = "";
      var row1 = document.createElement("div");
      row1.className = "dsh-mr-bubble-top";
      var mark = document.createElement("span");
      mark.className = "dsh-mr-bubble-mark";
      mark.textContent = "\u270e \u5df2\u7f16\u8f91";
      var editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "dsh-mr-bubble-edit-btn";
      editBtn.textContent = "\u270e \u518d\u6b21\u7f16\u8f91";
      editBtn.setAttribute("aria-label", "再次编辑这条消息");
      row1.appendChild(mark);
      row1.appendChild(editBtn);
      var text = document.createElement("div");
      text.className = "dsh-mr-bubble-text";
      text.textContent = rw.text;
      bubble.appendChild(row1);
      bubble.appendChild(text);

      editBtn.addEventListener("click", function () {
        // 浮层模式：直接打开（openEditModal 内部处理已有浮层）
        openEditModal(bubble.getAttribute("data-mr-session") || _sessionId || "", rw.seq, rw.text);
      });
    }

    /** 打开居中的编辑浮层（首次编辑 / 再次编辑共用）。 */
    var mrOverlay = null;
    function openEditModal(sessionId, seq, text) {
      if (mrOverlay) closeModal();
      active = true;

      var overlay = document.createElement("div");
      overlay.className = "dsh-mr-overlay";
      var modal = document.createElement("div");
      modal.className = "dsh-mr-modal";
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      mrOverlay = overlay;

      // ---- header ----
      var head = document.createElement("div");
      head.className = "dsh-mr-modal-head";
      var ic = document.createElement("div");
      ic.className = "dsh-mr-modal-ic";
      ic.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.3a1.7 1.7 0 0 1 2.4 2.4L6.2 12.2 3 13l.8-3.2z"/><path d="M10.2 3.4l2.4 2.4"/></svg>';
      var ttWrap = document.createElement("div");
      ttWrap.style.minWidth = "0";
      var tt = document.createElement("div");
      tt.className = "dsh-mr-modal-tt";
      tt.textContent = "\u7f16\u8f91\u6d88\u606f";
      var st = document.createElement("div");
      st.className = "dsh-mr-modal-st";
      st.textContent = "\u4fee\u6539\u540e\u5c06\u4ece\u8fd9\u6761\u6d88\u606f\u91cd\u65b0\u751f\u6210\uff0c\u540c\u4f1a\u8bdd\u4e2d\u622a\u65ad\u65e7\u56de\u590d";
      ttWrap.appendChild(tt);
      ttWrap.appendChild(st);
      var xBtn = document.createElement("button");
      xBtn.type = "button";
      xBtn.className = "dsh-mr-modal-x";
      xBtn.setAttribute("aria-label", "\u5173\u95ed");
      xBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
      head.appendChild(ic);
      head.appendChild(ttWrap);
      head.appendChild(xBtn);
      modal.appendChild(head);

      // ---- body ----
      var body = document.createElement("div");
      body.className = "dsh-mr-modal-body";
      var ta = document.createElement("textarea");
      ta.className = "dsh-mr-modal-ta";
      ta.value = text;
      ta.spellcheck = false;
      ta.setAttribute("aria-label", "\u7f16\u8f91\u6d88\u606f\u5185\u5bb9");
      body.appendChild(ta);
      var errP = document.createElement("div");
      errP.className = "dsh-mr-modal-err";
      errP.style.display = "none";
      errP.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 5v3.4M8 11h.01"/></svg><span></span>';
      body.appendChild(errP);
      modal.appendChild(body);

      // ---- footer ----
      var foot = document.createElement("div");
      foot.className = "dsh-mr-modal-foot";
      var hint = document.createElement("div");
      hint.className = "dsh-mr-modal-hint";
      hint.innerHTML = '<kbd>Esc</kbd>\u53d6\u6d88 &nbsp;\u00b7&nbsp; <kbd>\u2318</kbd><kbd>Enter</kbd>\u53d1\u9001';
      var charCount = document.createElement("span");
      charCount.className = "dsh-mr-modal-char";
      var btns = document.createElement("div");
      btns.className = "dsh-mr-modal-btns";
      var cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "dsh-mr-modal-btn";
      cancelBtn.textContent = "\u53d6\u6d88";
      var sendBtn = document.createElement("button");
      sendBtn.type = "button";
      sendBtn.className = "dsh-mr-modal-btn pri";
      sendBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>\u53d1\u9001\u5e76\u91cd\u65b0\u751f\u6210';
      btns.appendChild(cancelBtn);
      btns.appendChild(sendBtn);
      foot.appendChild(hint);
      foot.appendChild(charCount);
      foot.appendChild(btns);
      modal.appendChild(foot);

      function updateCount() {
        charCount.textContent = ta.value.length + " \u5b57";
      }
      updateCount();
      ta.addEventListener("input", updateCount);

      function showError(msg) {
        errP.querySelector("span").textContent = msg;
        errP.style.display = "flex";
      }
      function hideError() {
        errP.style.display = "none";
      }

      function close() {
        if (mrOverlay === overlay) mrOverlay = null;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        active = false;
      }

      xBtn.addEventListener("click", close);
      cancelBtn.addEventListener("click", close);
      overlay.addEventListener("mousedown", function (ev) {
        if (ev.target === overlay) close();
      });
      ta.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") { ev.preventDefault(); close(); }
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); sendBtn.click(); }
      });

      sendBtn.addEventListener("click", function () {
        var draft = ta.value.trim();
        if (draft === "") { showError("\u6d88\u606f\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a"); return; }
        if (!sessionId) { showError("\u65e0\u6cd5\u786e\u5b9a\u5f53\u524d\u4f1a\u8bdd"); return; }
        busy = true;
        sendBtn.disabled = true;
        sendBtn.innerHTML = '<span class="dsh-mr-spin"></span>\u91cd\u65b0\u751f\u6210\u4e2d\u2026';
        hideError();
        postRpc("rewrite", { sessionId: sessionId, userSeq: seq, text: draft }).then(function (res) {
          busy = false;
          if (!res.ok) {
            sendBtn.disabled = false;
            sendBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>\u53d1\u9001\u5e76\u91cd\u65b0\u751f\u6210';
            showError(errorText(res.code) + (res.message ? "\uff08" + res.message + "\uff09" : ""));
            return;
          }
          // 成功：浮层关闭。若 host 走了 fork 分支（编辑中间消息、M 后有新
          // 对话），切到新会话；否则原地截断，UI 由 rescan 重建。
          close();
          var fv = res.value;
          if (fv && fv.forked && fv.sessionId) {
            var ss = sessionsService;
            try {
              if (ss && typeof ss.open === "function") {
                ss.open(fv.sessionId);
              } else if (ss && ss.list && typeof ss.list.getSnapshot === "function") {
                // 退路：有些版本 open 在别处 —— 尽力直接调
                ss.open && ss.open(fv.sessionId);
              }
            } catch (e2) { /* 切会话失败不阻塞 */ }
          }
        });
      });

      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }

    /** 关闭当前浮层（供外部清理调用）。 */
    function closeModal() {
      if (mrOverlay && mrOverlay.parentNode) mrOverlay.parentNode.removeChild(mrOverlay);
      mrOverlay = null;
      active = false;
    }

    // 节流 + 去重：DOM 变化频繁，用 requestAnimationFrame 合并
    var rafPending = false;
    function scheduleRescan() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        rescan();
      });
    }

    // ---------- apply（由 __ModuleLoader__ 调用）----------
    function apply(ctx) {
      injectStyles();

      // 尽力订阅"当前会话"（用于编辑提交时校验；拿不到也没关系，
      // host list/rewrite 已支持按需定位，按钮上直接存 sessionId）
      var sessionsSvc = null;
      try { sessionsSvc = ctx && (ctx.sessions || (ctx.get && ctx.get("sessions"))); } catch (e) { /* ignore */ }
      sessionsService = sessionsSvc;
      if (sessionsSvc && sessionsSvc.list && sessionsSvc.list.getSnapshot) {
        try {
          var cur = sessionsSvc.list.getSnapshot().current;
          if (cur) _sessionId = cur;
        } catch (e) { /* ignore */ }
        if (sessionsSvc.list.subscribe) {
          try {
            sessionsSvc.list.subscribe(function () {
              try {
                var c2 = sessionsSvc.list.getSnapshot().current;
                if (c2 && c2 !== _sessionId) { _sessionId = c2; }
              } catch (e2) { /* ignore */ }
              scheduleRescan();
            });
          } catch (e3) { /* ignore */ }
        }
      }

      // 用 MutationObserver 监听消息区变化（新消息、切会话、滚动加载历史）
      var observer = new MutationObserver(function () { scheduleRescan(); });
      observer.observe(document.body, { childList: true, subtree: true });

      // 初始扫描 + 定期兜底（防 observer 漏挂）
      scheduleRescan();
      var timer = setInterval(function () {
        if (document.hidden) return;
        scheduleRescan();
      }, 2000);

      // 暴露给宿主做清理
      exports._dispose = function () {
        observer.disconnect();
        clearInterval(timer);
        var style = document.getElementById(STYLE_ID);
        if (style) style.remove();
      };
    }

    module.exports.apply = apply;
    module.exports.inject = ['sessions', 'connection'];
    return module.exports;
  },
});
