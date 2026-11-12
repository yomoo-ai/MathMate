/**
 * keyField.ts —— API Key 输入框的「填一次就记住」交互
 *
 * 原来只有一个 password 输入框：填完是一串黑点，刷新后还是黑点，
 * 用户没法判断"到底存上了没有"，于是每次都重贴一遍。
 *
 * 这里把它包成三态：
 *   ① 未填 —— 露出输入框，下面一行说明「填一次就会记住」
 *   ② 已存 —— 输入框收起，换成 sk-••••••1a2f + 绿点「已保存在本机」+ 更换 / 清除
 *   ③ 更换 —— 露出空输入框，粘贴后失焦（或回车）即回到 ②
 *
 * Key 仍然只写 localStorage，不上传服务器；其他模块（stub.ts / narration.ts）
 * 一直是从 localStorage 读的，所以这里只要保持同步即可。
 */

/** 复制 Key 时常带进全角空格 / 弯引号 / 零宽字符，Key 本身是纯 ASCII，全删掉 */
const NON_ASCII = /[^\x20-\x7E]/g;

export interface KeyFieldOptions {
  input: HTMLInputElement;
  /** localStorage 里的键名，如 mm-api-key */
  storageKey: string;
  /** 未保存时的说明文字 */
  emptyHint: string;
  /** 已保存时的说明文字 */
  savedHint: string;
  /** 保存 / 清除后回调（当前页要用新 Key 重算状态时用） */
  onChange?: (key: string) => void;
}

export interface KeyFieldHandle {
  value(): string;
  has(): boolean;
  clear(): void;
  /** 外部想把焦点送进输入框时调用（例如「还没配置 Key」提示条） */
  reveal(): void;
}

/** 掩码：保留头 3 位和后 4 位，中间打点，够认人又不露全串 */
export function maskKey(key: string): string {
  if (key.length <= 10) return '••••••';
  return `${key.slice(0, 3)}••••••${key.slice(-4)}`;
}

export function mountKeyField(options: KeyFieldOptions): KeyFieldHandle {
  const { input, storageKey, emptyHint, savedHint, onChange } = options;

  // ---- 结构：把 input 包进 .key-field，再补一条摘要行和一条说明 ----
  const field = document.createElement('div');
  field.className = 'key-field';
  input.parentNode?.insertBefore(field, input);
  field.appendChild(input);

  const summary = document.createElement('div');
  summary.className = 'key-summary';
  summary.hidden = true;

  const dot = document.createElement('span');
  dot.className = 'key-dot';
  dot.setAttribute('aria-hidden', 'true');

  const mask = document.createElement('span');
  mask.className = 'key-mask';

  const note = document.createElement('span');
  note.className = 'key-note';
  note.textContent = '已保存在本机';

  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.className = 'key-link';
  replaceBtn.textContent = '更换';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'key-link is-danger';
  clearBtn.textContent = '清除';

  summary.append(dot, mask, note, replaceBtn, clearBtn);

  const hint = document.createElement('div');
  hint.className = 'key-hint';

  field.append(summary, hint);

  // ---- 状态 ----
  let saved = (localStorage.getItem(storageKey) ?? '').trim();
  /** 是否处于「更换」编辑态 */
  let editing = false;

  function render() {
    if (saved && !editing) {
      mask.textContent = maskKey(saved);
      summary.hidden = false;
      input.hidden = true;
      field.classList.add('is-saved');
      hint.textContent = savedHint;
    } else {
      summary.hidden = true;
      input.hidden = false;
      field.classList.remove('is-saved');
      hint.textContent = emptyHint;
    }
  }

  function commit(raw: string) {
    const key = raw.replace(NON_ASCII, '').trim();
    if (key) {
      saved = key;
      localStorage.setItem(storageKey, key);
    }
    editing = false;
    render();
    onChange?.(saved);
  }

  // ---- 事件 ----
  input.addEventListener('input', () => {
    // 边打边清洗：全角空格之类会让请求 401，被当成"Key 不对"
    const clean = input.value.replace(NON_ASCII, '');
    if (clean !== input.value) input.value = clean;
    if (clean.trim()) {
      // 立刻落盘：即使没失焦就关掉页面也不会丢
      saved = clean.trim();
      localStorage.setItem(storageKey, saved);
      onChange?.(saved);
    }
  });

  input.addEventListener('blur', () => {
    const value = input.value.trim();
    if (value) {
      commit(value);
      input.value = value; // 保留在框里，切回摘要态时值仍在
      input.hidden = true;
    } else {
      // 留空 = 放弃更换，回到原来的 Key（或未填态）
      editing = false;
      input.value = saved;
      render();
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      input.value = saved;
      editing = false;
      render();
    }
  });

  replaceBtn.addEventListener('click', () => {
    editing = true;
    input.value = '';
    render();
    input.focus();
  });

  clearBtn.addEventListener('click', () => {
    saved = '';
    localStorage.removeItem(storageKey);
    input.value = '';
    editing = true; // 清完直接停在输入态，方便重新填
    render();
    input.focus();
    onChange?.('');
  });

  // 摘要行本身不吞点击；点掩码 = 更换，省一次瞄准
  mask.addEventListener('click', () => replaceBtn.click());

  render();

  return {
    value: () => saved,
    has: () => saved.length > 0,
    clear: () => clearBtn.click(),
    reveal: () => {
      if (saved) replaceBtn.click();
      else input.focus();
    },
  };
}
