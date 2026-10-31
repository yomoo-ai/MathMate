/**
 * notebook.ts —— 「我的题本」（阶段 5：把解过的题存下来）
 *
 * 三条设计原则，都来自踩过的坑：
 *
 *   1. 只存「能重建画面的最小数据」：题目原文 + 场景 JSON。
 *      不存渲染结果、不存图片——localStorage 一共才 5MB，
 *      一张手机照片的 base64 就 1MB 起步，存三张就满了。
 *      场景 JSON 一条几 KB，存几十上百道没问题。
 *
 *   2. 读出来一律重新过 parseScene 校验（在 main.ts 里做）。
 *      存档可能来自旧版本协议：以前 `Vec2Like` 不支持数组、不支持点 id 引用，
 *      那时候存下的 JSON 直接塞给渲染器会让整个页面白屏。
 *      宁可提示「这条打不开」，也不能炸。
 *
 *   3. 同题覆盖不追加：反复生成同一道题只留最新一条，
 *      否则题本会被重复项塞满，找东西反而更难。
 */

const STORE_KEY = 'mm-notebook-v1';
/** 存档格式版本：将来协议大改时 +1，用来提示「这是旧版存的」 */
const SCHEMA_VERSION = 1;
/** 上限条数：超出后丢掉最老的，防止把 localStorage 撑爆 */
const MAX_ENTRIES = 80;

export type NotebookSource = 'text' | 'photo';

export interface NotebookEntry {
  id: string;
  savedAt: number;
  /** 场景标题，列表里显示 */
  title: string;
  /** 原始题目文字。同一道题再次生成时，用它做去重键 */
  prompt: string;
  /** 场景 JSON 原文（字符串）。恢复时交给 parseScene 重新校验 */
  sceneJson: string;
  source: NotebookSource;
  /** 保存时体检还剩几条提示（0 = 完全干净） */
  issueCount: number;
  /** 存档格式版本 */
  v: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 读取全部存档。
 * 任何一步坏掉都返回空数组——题本坏了不能连累整个页面。
 */
export function loadEntries(): NotebookEntry[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // 逐条校验必需字段：缺字段的条目会让后面的渲染和恢复全部报错
    return arr.filter(
      (e): e is NotebookEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as NotebookEntry).id === 'string' &&
        typeof (e as NotebookEntry).sceneJson === 'string' &&
        typeof (e as NotebookEntry).prompt === 'string',
    );
  } catch {
    return [];
  }
}

function persist(entries: NotebookEntry[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch (e) {
    // 配额满（QuotaExceededError）。正常不会，但存了百来道大题的极端情况要有个交代
    console.warn('[题本] 写入失败，可能是浏览器存储已满：', e);
  }
}

/** 存一条（同题覆盖），返回写入后的完整列表 */
export function saveEntry(input: {
  title: string;
  prompt: string;
  sceneJson: string;
  source: NotebookSource;
  issueCount: number;
}): NotebookEntry[] {
  const entries = loadEntries();
  const key = input.prompt.trim();
  const idx = entries.findIndex((e) => e.prompt.trim() === key);

  const entry: NotebookEntry = {
    id: idx >= 0 ? entries[idx].id : newId(),
    savedAt: Date.now(),
    v: SCHEMA_VERSION,
    ...input,
  };

  // 已存在就把它挪到最前（最近使用的排最上面）
  if (idx >= 0) entries.splice(idx, 1);
  entries.unshift(entry);
  persist(entries);
  return entries;
}

export function removeEntry(id: string): NotebookEntry[] {
  const next = loadEntries().filter((e) => e.id !== id);
  persist(next);
  return next;
}

export function clearEntries(): NotebookEntry[] {
  persist([]);
  return [];
}

export interface NotebookController {
  /** 用最新数据重绘列表 */
  refresh(entries: NotebookEntry[]): void;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

/**
 * 把题本挂到容器上。事件只绑一次（委托到根节点），
 * 之后 refresh 只换 innerHTML——反复绑监听器是内存泄漏的经典写法。
 */
export function mountNotebook(
  root: HTMLElement,
  handlers: {
    onOpen(entry: NotebookEntry): void;
    onDelete(id: string): void;
    onClear(): void;
  },
): NotebookController {
  let current: NotebookEntry[] = [];

  root.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'close') {
      root.hidden = true;
      return;
    }
    if (action === 'clear') {
      if (current.length === 0) return;
      // 删除是不可逆的，必问一句
      if (confirm(`确定清空全部 ${current.length} 道题？删了就找不回来了。`)) {
        handlers.onClear();
      }
      return;
    }

    const id = btn.closest<HTMLElement>('[data-id]')?.dataset.id ?? '';
    const entry = current.find((e) => e.id === id);
    if (!entry) return;

    if (action === 'open') handlers.onOpen(entry);
    if (action === 'del') {
      if (confirm(`删除「${entry.title}」？`)) handlers.onDelete(entry.id);
    }
  });

  return {
    refresh(entries: NotebookEntry[]) {
      current = entries;
      const list = root.querySelector<HTMLElement>('#nb-list');
      const count = root.querySelector<HTMLElement>('#nb-count');
      const clearBtn = root.querySelector<HTMLButtonElement>('[data-action="clear"]');
      if (!list) return;

      if (count) count.textContent = entries.length ? `${entries.length} 道` : '';
      if (clearBtn) clearBtn.disabled = entries.length === 0;

      if (entries.length === 0) {
        list.innerHTML =
          '<div class="nb-empty">还没有存过题。<br />生成一道题之后会自动出现在这里。</div>';
        return;
      }

      list.innerHTML = entries
        .map(
          (e) => `
        <div class="nb-item" data-id="${escapeHtml(e.id)}">
          <div class="nb-row">
            <span class="nb-title" title="${escapeHtml(e.prompt.slice(0, 300))}">${escapeHtml(e.title)}</span>
            <span class="nb-src">${e.source === 'photo' ? '拍照' : '文字'}</span>
          </div>
          <div class="nb-row nb-meta">
            <span>${fmtTime(e.savedAt)}</span>
            <span class="${e.issueCount > 0 ? 'nb-warn' : 'nb-ok'}">
              ${e.issueCount > 0 ? `⚠ ${e.issueCount} 处提示` : '✓ 体检通过'}
            </span>
          </div>
          <div class="nb-row nb-actions">
            <button class="btn" data-action="open">打开</button>
            <button class="btn" data-action="del">删除</button>
          </div>
        </div>`,
        )
        .join('');
    },

    open() {
      root.hidden = false;
    },
    close() {
      root.hidden = true;
    },
    toggle() {
      root.hidden = !root.hidden;
    },
    isOpen() {
      return !root.hidden;
    },
  };
}
