/**
 * chatPanel.ts —— 右下角气泡 + 抽屉式答疑面板。
 *
 * 为什么是气泡 + 底部抽屉：答疑要"边看图边问"。抽屉升起时图仍占上半部分，
 * 学生抬眼就能看到被问的那条棱；而气泡默认不占地方，不打扰做题。
 *
 * 三条自我约束：
 *   1. 上下文**每次提问现取**（getContext），不用打开面板时的快照——
 *      学生往往先翻到第 3 步再问"这一步为什么"，用旧步号就答偏了；
 *   2. 流式阶段只用纯文本刷新（KaTeX 每次重排会把 60 帧渲染变成卡顿），
 *      收尾才做一次公式排版；
 *   3. 联动指令只在收尾时执行一次，且必须过白名单（见 actProtocol）。
 */

import { askTutor, type ChatContext } from '../llm/chatAgent';
import {
  describeAction,
  sanitizeAction,
  stripActStream,
  type ChatAction,
  type ChatMessage,
} from '../llm/actProtocol';
import { renderMathText } from './mathText';

export interface ChatPanelOpts {
  /** 挂载点：画布列（面板是舞台的纵向兄弟，展开时舞台让出高度） */
  mount: HTMLElement;
  /** 气泡挂这里：画布舞台，这样收起时它贴在图的右下角 */
  bubbleHost: HTMLElement;
  /** 每次提问时现取上下文 */
  getContext: () => ChatContext;
  /** 执行联动（undo=true 表示撤销高亮） */
  onAction: (act: ChatAction, undo: boolean) => void;
}

export interface ChatPanelApi {
  /** 换题：清空对话与气泡状态 */
  reset(): void;
  open(): void;
  close(): void;
}

const QUICK = ['这一步为什么要这么做', '用到的定理是什么', '还有别的解法吗'];

export function mountChatPanel(opts: ChatPanelOpts): ChatPanelApi {
  const history: ChatMessage[] = [];
  let turns = 0;
  let busy = false;
  let abort: AbortController | null = null;

  // ---------------- DOM ----------------
  const bubble = document.createElement('button');
  bubble.type = 'button';
  bubble.className = 'chat-bubble';
  bubble.title = '就这道题提问';
  bubble.innerHTML = '<span class="chat-bubble-dot"></span>问一问';

  const panel = document.createElement('div');
  panel.className = 'chat-panel';
  panel.dataset.open = 'false';
  /** 内容层：面板高度在动画，内容层保持固定最小高度，被裁切而不是被压扁 */
  const inner = document.createElement('div');
  inner.className = 'chat-inner';

  const grip = document.createElement('div');
  grip.className = 'chat-grip';
  grip.title = '拖动改高度';

  const head = document.createElement('div');
  head.className = 'chat-head';
  const hTitle = document.createElement('span');
  hTitle.className = 'chat-title';
  hTitle.textContent = '问一问';
  const hSub = document.createElement('span');
  hSub.className = 'chat-sub';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'chat-link';
  clearBtn.textContent = '清空';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'kp-icon';
  closeBtn.title = '收起';
  closeBtn.textContent = '×';
  head.append(hTitle, hSub, clearBtn, closeBtn);

  const list = document.createElement('div');
  list.className = 'chat-list';

  const quick = document.createElement('div');
  quick.className = 'chat-quick';

  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';
  const input = document.createElement('textarea');
  input.className = 'chat-input';
  input.rows = 1;
  input.placeholder = '接着问点什么…（Enter 发送，Shift+Enter 换行）';
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'btn primary chat-send';
  sendBtn.textContent = '发送';
  inputRow.append(input, sendBtn);

  inner.append(grip, head, list, quick, inputRow);
  panel.append(inner);
  opts.mount.append(panel);
  opts.bubbleHost.append(bubble);

  // ---------------- 开合 ----------------
  function setOpen(on: boolean) {
    panel.dataset.open = on ? 'true' : 'false';
    bubble.hidden = on;
    // 拖动改过高度会留下内联 height，它会盖住"收起时高度 0"的类规则，
    // 所以收起时清掉内联值，让抽屉真的能缩回去
    if (!on) panel.style.height = '';
    if (on) {
      // 打开时滚到最新，并把焦点给输入框（但手机上别弹键盘，用 media query 判断成本高，先只 focus 桌面）
      list.scrollTop = list.scrollHeight;
      if (window.matchMedia('(min-width: 900px)').matches) input.focus();
    }
  }

  bubble.addEventListener('click', () => setOpen(true));
  closeBtn.addEventListener('click', () => setOpen(false));

  // 拖动改高度：从 32% 到 72%，太矮看不下回答，太高把图挤没
  let dragging = false;
  let dragStartY = 0;
  let dragStartH = 0;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true;
    dragStartY = e.clientY;
    dragStartH = panel.getBoundingClientRect().height;
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const host = opts.mount.getBoundingClientRect().height || 600;
    const next = Math.min(host * 0.72, Math.max(host * 0.32, dragStartH + (dragStartY - e.clientY)));
    panel.style.height = `${Math.round(next)}px`;
  });
  grip.addEventListener('pointerup', () => {
    dragging = false;
  });

  // ---------------- 消息渲染 ----------------
  function clearList() {
    list.innerHTML = '';
  }

  function addUser(text: string) {
    const row = document.createElement('div');
    row.className = 'chat-row user';
    const b = document.createElement('div');
    b.className = 'chat-msg user';
    b.textContent = text;
    row.appendChild(b);
    list.appendChild(row);
  }

  function addAssistant(): {
    el: HTMLElement;
    setStream: (text: string) => void;
    finish: (text: string, chips: string[], onChip?: () => void) => void;
    fail: (msg: string) => void;
  } {
    const row = document.createElement('div');
    row.className = 'chat-row';
    const avatar = document.createElement('span');
    avatar.className = 'chat-avatar';
    avatar.textContent = '师';
    const wrap = document.createElement('div');
    wrap.className = 'chat-wrap';
    const b = document.createElement('div');
    b.className = 'chat-msg bot';
    const acts = document.createElement('div');
    acts.className = 'chat-acts';
    wrap.append(b, acts);
    row.append(avatar, wrap);
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;

    let pending = '';
    let raf = 0;
    /**
     * 一旦收尾或报错就锁住流式通道。
     * 不加这个闸门会出一个很别扭的 bug：错误信息刚写进气泡，紧接着
     * 上一帧排好的 rAF 又把"正在想…"盖回去，用户看到的是粉底色的"正在想…"。
     */
    let closed = false;
    const stopStream = () => {
      closed = true;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    return {
      el: b,
      setStream(text: string) {
        if (closed) return;
        pending = text;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (closed) return;
          b.textContent = pending;
          list.scrollTop = list.scrollHeight;
        });
      },
      finish(text: string, chips: string[], onChip?: () => void) {
        stopStream();
        b.innerHTML = renderMathText(text);
        for (const c of chips) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'chat-act-chip';
          chip.textContent = c;
          if (onChip) {
            chip.title = '点一下撤销这次联动';
            chip.addEventListener('click', () => {
              onChip();
              chip.disabled = true;
              chip.classList.add('done');
            });
          }
          acts.appendChild(chip);
        }
        list.scrollTop = list.scrollHeight;
      },
      fail(msg: string) {
        stopStream();
        b.classList.add('error');
        b.textContent = msg;
        list.scrollTop = list.scrollHeight;
      },
    };
  }

  function renderQuick() {
    quick.innerHTML = '';
    for (const q of QUICK) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'chat-quick-chip';
      c.textContent = q;
      c.addEventListener('click', () => void send(q));
      quick.appendChild(c);
    }
  }

  function refreshHead() {
    hSub.textContent = turns > 0 ? `已问 ${turns} 轮` : '';
  }

  // ---------------- 发送 ----------------
  async function send(textRaw?: string): Promise<void> {
    const question = (textRaw ?? input.value).trim();
    if (!question || busy) return;
    if (!textRaw) input.value = '';
    busy = true;
    sendBtn.disabled = true;
    bubble.dataset.busy = 'true';

    addUser(question);
    const bot = addAssistant();
    bot.setStream('正在想…');

    let ctx: ChatContext;
    try {
      ctx = opts.getContext();
    } catch {
      busy = false;
      sendBtn.disabled = false;
      bubble.dataset.busy = 'false';
      bot.fail('拿不到当前题目信息，先重新生成一次场景再问。');
      return;
    }

    abort = new AbortController();
    let acc = '';
    try {
      const res = await askTutor(
        ctx,
        history,
        question,
        (delta) => {
          acc += delta;
          bot.setStream(stripActStream(acc).text || '正在想…');
        },
        abort.signal,
      );
      const clean = res.text || acc.replace(/<<[\s\S]*$/, '').trim();
      if (!clean) throw new Error('模型这次没有给出内容，再问一次试试。');

      // 白名单过滤：越界/不存在的 id 一律丢弃
      const act = sanitizeAction(res.action, ctx.steps.length, ctx.ids);
      const chips = act ? describeAction(act, act.jump ? ctx.steps[act.jump - 1]?.title : undefined) : [];
      bot.finish(clean, chips, act ? () => opts.onAction(act, true) : undefined);
      if (act) opts.onAction(act, false);

      history.push({ role: 'user', content: question });
      history.push({ role: 'assistant', content: clean });
      turns += 1;
      refreshHead();
    } catch (err) {
      const msg = (err as Error).message || '请求失败';
      bot.fail(msg);
    } finally {
      abort = null;
      busy = false;
      sendBtn.disabled = false;
      bubble.dataset.busy = 'false';
    }
  }

  sendBtn.addEventListener('click', () => void send());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  clearBtn.addEventListener('click', () => {
    abort?.abort();
    history.length = 0;
    turns = 0;
    clearList();
    refreshHead();
    renderQuick();
    list.appendChild(emptyHint());
  });

  function emptyHint(): HTMLElement {
    const h = document.createElement('p');
    h.className = 'chat-hint';
    h.textContent = '就这道题随便问：某一步为什么这么做、某个结论怎么来的、还有没有别的解法。';
    return h;
  }

  clearList();
  list.appendChild(emptyHint());
  renderQuick();
  refreshHead();

  return {
    reset() {
      abort?.abort();
      history.length = 0;
      turns = 0;
      busy = false;
      sendBtn.disabled = false;
      clearList();
      list.appendChild(emptyHint());
      refreshHead();
      renderQuick();
      setOpen(false);
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}
