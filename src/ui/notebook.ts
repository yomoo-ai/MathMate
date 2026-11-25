/**
 * notebook.ts —— 「我的题本」（阶段 5：把解过的题存下来）
 *
 * 五条设计原则，都来自踩过的坑：
 *
 *   1. 只存「能重建画面的最小数据」：题目原文 + 场景 JSON。
 *      不存渲染结果、不存图片——localStorage 一共才 5MB，
 *      一张手机照片的 base64 就 1MB 起步，存三张就满了。
 *      场景 JSON 一条几 KB，存两百道没问题。
 *
 *   2. 读出来一律重新过 parseScene 校验（在 main.ts 里做）。
 *      存档可能来自旧版本协议：以前 `Vec2Like` 不支持数组、不支持点 id 引用，
 *      那时候存下的 JSON 直接塞给渲染器会让整个页面白屏。
 *      宁可提示「这条打不开」，也不能炸。
 *
 *   3. 同题覆盖不追加：反复生成同一道题只留最新一条，
 *      否则题本会被重复项塞满，找东西反而更难。
 *
 *   4. 章节标签有三层来源（程序反推 → LLM 补充 → 手动修改），
 *      手动改过的永远优先——用户整理了半小时的标签，
 *      不能被下一次生成悄悄冲掉（chapterManual 就是这道闸）。
 *
 *   5. 备份是 localStorage 的救命绳：换浏览器/清数据都会全丢，
 *      导出 JSON 一次 10 秒钟的事。导入逐条校验，坏档只跳过不炸。
 */

import { CHAPTERS } from '../llm/chapters';

const STORE_KEY = 'mm-notebook-v1';
/** 存档格式版本：将来协议大改时 +1，用来提示「这是旧版存的」 */
const SCHEMA_VERSION = 1;
/** 上限条数：超出后丢掉最老的，防止把 localStorage 撑爆（题库定位从 80 提到 200） */
const MAX_ENTRIES = 200;

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
  /** 章节标签（人教版粗分）。空串 = 未分类 */
  chapter?: string;
  /** 用户手动改过标签 → 自动补写不再覆盖它 */
  chapterManual?: boolean;
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
  /** 程序反推 / LLM 给的章节。手动改过的旧标签不被覆盖 */
  chapter?: string;
}): NotebookEntry[] {
  const entries = loadEntries();
  const key = input.prompt.trim();
  const idx = entries.findIndex((e) => e.prompt.trim() === key);

  // 覆盖旧条目时：手动改过的章节是用户的心血，永远保留；
  // 否则优先用这次带来的（LLM 比上次的程序反推更准），再退回旧值
  const old = idx >= 0 ? entries[idx] : null;
  const chapter = old?.chapterManual
    ? old.chapter
    : input.chapter || old?.chapter || '';

  const entry: NotebookEntry = {
    id: idx >= 0 ? entries[idx].id : newId(),
    savedAt: Date.now(),
    v: SCHEMA_VERSION,
    // 先铺 input 再定 chapter：保证 chapter 字段不被 input 里可能缺省的值冲掉。
    // chapterManual 必须从旧条目带过来——它是"手动标签闸"，重建对象时丢了
    // 这一个字段，用户的手动整理就会被下一次生成冲掉（回归有过红灯）
    ...input,
    chapter,
    chapterManual: old?.chapterManual,
  };

  // 已存在就把它挪到最前（最近使用的排最上面）
  if (idx >= 0) entries.splice(idx, 1);
  entries.unshift(entry);
  persist(entries);
  return entries;
}

/** 手动改章节：标记 chapterManual，此后自动来源不再覆盖 */
export function setChapter(id: string, chapter: string): NotebookEntry[] {
  const entries = loadEntries();
  const e = entries.find((x) => x.id === id);
  if (e) {
    e.chapter = chapter;
    e.chapterManual = true;
    persist(entries);
  }
  return entries;
}

/**
 * 自动补章节：知识点的 LLM 调用回来后，把更准的章节补给刚存的那条。
 * 只填空缺——已有标签（反推的也好手动的也好）不动，避免反复横跳。
 */
export function autoFillChapter(prompt: string, chapter: string): NotebookEntry[] {
  if (!chapter) return loadEntries();
  const entries = loadEntries();
  const key = prompt.trim();
  const e = entries.find((x) => x.prompt.trim() === key);
  if (e && !e.chapter && !e.chapterManual) {
    e.chapter = chapter;
    persist(entries);
  }
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

// ---------------------------------------------------------------
// 备份：导出 / 导入 JSON 文件
// ---------------------------------------------------------------

/** 把题本下载成一个 JSON 文件。返回文件名；题本为空返回 null */
export function exportBackup(): string | null {
  const entries = loadEntries();
  if (entries.length === 0) return null;
  const payload = {
    kind: 'mathmate-notebook-backup',
    v: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    entries,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  a.href = url;
  a.download = `mathmate-题本-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return a.download;
}

/**
 * 备份导入的核心：接收已解析的 JSON 结构，逐条校验、去重、合并。
 * 与文件读取（async）解耦——回归测试直接喂内存数据，不用绕异步。
 */
export function importBackupEntries(rawArr: unknown): {
  added: number;
  skipped: number;
  invalid: number;
} {
  if (!Array.isArray(rawArr)) throw new Error('文件里没有题目列表（缺 entries 数组）。');

  const incoming = rawArr.filter(
    (e): e is NotebookEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as NotebookEntry).prompt === 'string' &&
      typeof (e as NotebookEntry).sceneJson === 'string',
  );
  const invalid = rawArr.length - incoming.length;

  const entries = loadEntries();
  const known = new Set(entries.map((e) => e.prompt.trim()));
  let added = 0;
  let skipped = 0;
  for (const item of incoming) {
    const key = item.prompt.trim();
    if (known.has(key)) {
      skipped++;
      continue;
    }
    known.add(key);
    entries.unshift({
      ...item,
      // 补齐旧备份可能缺的字段
      id: typeof item.id === 'string' ? item.id : newId(),
      savedAt: typeof item.savedAt === 'number' ? item.savedAt : Date.now(),
      source: item.source === 'photo' ? 'photo' : 'text',
      issueCount: typeof item.issueCount === 'number' ? item.issueCount : 0,
      v: SCHEMA_VERSION,
    });
    added++;
  }
  persist(entries);
  return { added, skipped, invalid };
}

/**
 * 从备份文件导入。逐条校验（同 loadEntries 的标准），
 * 按「题目原文」去重——已有的条目不动，只收新题。
 * 返回 {added, skipped, invalid} 供 UI 提示。
 */
export async function importBackupFile(
  file: File,
): Promise<{ added: number; skipped: number; invalid: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('文件不是合法的 JSON，没法读。');
  }
  // 兼容两种格式：裸数组（手搓的）和带 kind 的完整备份
  const rawArr: unknown =
    Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown })?.entries;
  return importBackupEntries(rawArr);
}

// ---------------------------------------------------------------
// UI
// ---------------------------------------------------------------

export interface NotebookController {
  /** 用最新数据重绘列表 */
  refresh(entries: NotebookEntry[]): void;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

/** 章节下拉的公共选项（含「未分类」） */
function chapterOptions(selected: string): string {
  const all = [...CHAPTERS, '__none__'];
  return all
    .map((c) => {
      const val = c === '__none__' ? '' : c;
      const label = c === '__none__' ? '未分类' : c;
      return `<option value="${val}"${val === (selected || '') ? ' selected' : ''}>${label}</option>`;
    })
    .join('');
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
    /** 勾选集合变化（跨筛选保留，靠 id 记） */
    onSelectionChange(count: number): void;
    /** 点「生成试卷」，传勾选的条目（按列表顺序） */
    onMakePaper(entries: NotebookEntry[]): void;
    /** 手动改章节 */
    onChapterChange(id: string, chapter: string): void;
  },
): NotebookController {
  let current: NotebookEntry[] = [];
  let filter = ''; // '' = 全部；'__none__' = 未分类
  const selected = new Set<string>();

  /** 按当前筛选取出可见条目 */
  const visible = (): NotebookEntry[] =>
    current.filter((e) => {
      if (filter === '') return true;
      if (filter === '__none__') return !e.chapter;
      return e.chapter === filter;
    });

  /** 筛选栏 chips + 计数（始终基于全量 current 统计） */
  function filterHtml(): string {
    const counts = new Map<string, number>();
    for (const e of current) {
      const c = e.chapter || '__none__';
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const chips: string[] = [
      `<button class="nb-chip${filter === '' ? ' active' : ''}" data-filter="">全部 ${current.length}</button>`,
    ];
    for (const c of CHAPTERS) {
      const n = counts.get(c) ?? 0;
      if (n === 0 && filter !== c) continue; // 没题的章节不占位置
      chips.push(
        `<button class="nb-chip${filter === c ? ' active' : ''}" data-filter="${c}">${c} ${n}</button>`,
      );
    }
    const none = counts.get('__none__') ?? 0;
    if (none > 0 || filter === '__none__') {
      chips.push(
        `<button class="nb-chip${filter === '__none__' ? ' active' : ''}" data-filter="__none__">未分类 ${none}</button>`,
      );
    }
    return chips.join('');
  }

  const listEl = (): HTMLElement =>
    root.querySelector<HTMLElement>('#nb-list') as HTMLElement;

  /** 更新底部选中条：数量、组卷按钮可用性 */
  function syncSelectBar(): void {
    const bar = root.querySelector<HTMLElement>('#nb-select-bar');
    if (!bar) return;
    const n = current.filter((e) => selected.has(e.id)).length;
    bar.hidden = n === 0;
    const label = bar.querySelector<HTMLElement>('#nb-select-count');
    if (label) label.textContent = `已选 ${n} 题`;
    const btn = bar.querySelector<HTMLButtonElement>('[data-action="paper"]');
    if (btn) btn.disabled = n === 0;
  }

  root.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;

    const chip = target.closest<HTMLElement>('[data-filter]');
    if (chip) {
      filter = chip.dataset.filter ?? '';
      refreshImpl(current);
      return;
    }

    const btn = target.closest<HTMLElement>('[data-action]');
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
        selected.clear();
        handlers.onClear();
      }
      return;
    }
    if (action === 'export') {
      const name = exportBackup();
      if (!name) alert('题本是空的，没什么可备份。');
      return;
    }
    if (action === 'import') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return;
        try {
          const r = await importBackupFile(f);
          refreshImpl(loadEntries());
          alert(
            r.added > 0
              ? `导入完成：新增 ${r.added} 道${r.skipped ? `，跳过重复 ${r.skipped} 道` : ''}。`
              : `没有新增题（${r.skipped} 道都已存在${r.invalid ? `，${r.invalid} 条格式不对被跳过` : ''}）。`,
          );
        } catch (err) {
          alert((err as Error).message);
        }
      };
      input.click();
      return;
    }
    if (action === 'paper') {
      // 按列表顺序（不是勾选顺序）出卷，卷子要有稳定题序
      const items = current.filter((e) => selected.has(e.id));
      if (items.length === 0) return;
      handlers.onMakePaper(items);
      return;
    }
    if (action === 'deselect') {
      selected.clear();
      syncSelectBar();
      refreshImpl(current);
      return;
    }

    const id = btn.closest<HTMLElement>('[data-id]')?.dataset.id ?? '';
    const entry = current.find((e) => e.id === id);
    if (!entry) return;

    if (action === 'open') handlers.onOpen(entry);
    if (action === 'del') {
      if (confirm(`删除「${entry.title}」？`)) {
        selected.delete(entry.id);
        handlers.onDelete(entry.id);
      }
    }
  });

  // 勾选与章节下拉走 change 事件（checkbox 的 click 语义混乱，不用）
  root.addEventListener('change', (ev) => {
    const target = ev.target as HTMLElement;
    const check = target.closest<HTMLInputElement>('input[data-check]');
    if (check) {
      const id = check.closest<HTMLElement>('[data-id]')?.dataset.id ?? '';
      if (check.checked) selected.add(id);
      else selected.delete(id);
      syncSelectBar();
      handlers.onSelectionChange(selected.size);
      return;
    }
    const sel = target.closest<HTMLSelectElement>('select.nb-chap');
    if (sel) {
      const id = sel.closest<HTMLElement>('[data-id]')?.dataset.id ?? '';
      handlers.onChapterChange(id, sel.value);
    }
  });

  /**
   * 真正的重绘实现（事件委托与 controller 共用同一个函数——
   * 事件绑定发生在 controller 对象创建之前，方法名在那时还不可见）
   */
  function refreshImpl(entries: NotebookEntry[]): void {
      current = entries;
      // 勾选清理：条目已删掉的勾也一并消失
      const ids = new Set(entries.map((e) => e.id));
      for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);

      const list = listEl();
      const count = root.querySelector<HTMLElement>('#nb-count');
      const filterEl = root.querySelector<HTMLElement>('#nb-filter');
      const clearBtn = root.querySelector<HTMLButtonElement>('[data-action="clear"]');
      if (!list) return;

      if (count) count.textContent = entries.length ? `${entries.length} 道` : '';
      if (clearBtn) clearBtn.disabled = entries.length === 0;
      if (filterEl) filterEl.innerHTML = filterHtml();

      const show = visible();
      if (entries.length === 0) {
        list.innerHTML =
          '<div class="nb-empty">还没有存过题。<br />生成一道题之后会自动出现在这里。</div>';
        syncSelectBar();
        return;
      }
      if (show.length === 0) {
        list.innerHTML =
          '<div class="nb-empty">这个分类下还没有题。<br />点上面的章节筛选换一个看看。</div>';
        syncSelectBar();
        return;
      }

      list.innerHTML = show
        .map((e) => {
          return `
        <div class="nb-item" data-id="${escapeHtml(e.id)}">
          <input type="checkbox" class="nb-check" data-check title="选入试卷"${selected.has(e.id) ? ' checked' : ''} />
          <div class="nb-body">
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
              <select class="nb-chap" title="章节归类">${chapterOptions(e.chapter || '')}</select>
              <button class="btn" data-action="open">打开</button>
              <button class="btn" data-action="del">删除</button>
            </div>
          </div>
        </div>`;
        })
        .join('');
      syncSelectBar();
  }

  return {
    refresh: refreshImpl,

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
