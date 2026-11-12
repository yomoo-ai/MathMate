/**
 * knowledgePanel.ts —— 图右侧的「本题知识点」抽屉。
 *
 * 为什么是抽屉而不是浮窗：立体图几乎总有顶点落在右上角，浮窗一开就挡住
 * 正在讲的那个点。抽屉让画布真的让出宽度，图整体重排取景，一个顶点都不会被遮。
 *
 * 状态机：收起（只剩一条竖标签）→ 展开（骨架屏 / 列表 / 出错兜底）。
 * 三种内容态都必须有东西可看：宁可显示"从条件反推的 3 个名词"，
 * 也不要让用户点开一个空抽屉。
 */

import type { Scene } from '../protocol/scene';
import type { Scene3D } from '../protocol/scene3d';
import { renderMathText } from './mathText';
import {
  fallbackKnowledge,
  knowledgeKey,
  normalizeKnowledge,
  requestKnowledge,
  MAX_POINTS,
  type KnowledgePoint,
} from '../llm/knowledge';
import { buildFactSheet } from '../llm/factSheet';
import { hasLlmKey } from '../llm/stub';

type AnyScene = Scene | Scene3D;

export interface KnowledgePanelOpts {
  /** 展开/收起后通知外部重排画布 */
  onLayoutChange: () => void;
}

export interface KnowledgePanelApi {
  setScene(args: {
    problem: string;
    scene: AnyScene;
    steps: Array<{ title: string }>;
    params: Record<string, number>;
  }): void;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /**
   * 搬到别的宿主（视频工作台）。同一组 DOM 搬家，不复制——
   * 知识点缓存（state.keys）天然共享，同一道题不会调两次模型。
   */
  moveTo(host: HTMLElement): void;
  /** 搬回挂载时的原位 */
  moveBack(): void;
}

interface State {
  keys: Map<string, KnowledgePoint[]>;
  loadingKey: string | null;
  currentKey: string;
  points: KnowledgePoint[];
  note: string;
  error: string;
  /** 没有 error 也允许重试（例如"还没填 Key"——填完该能再点一次） */
  canRetry: boolean;
}

export function mountKnowledgePanel(
  container: HTMLElement,
  opts: KnowledgePanelOpts,
): KnowledgePanelApi {
  const state: State = {
    keys: new Map(),
    loadingKey: null,
    currentKey: '',
    points: [],
    note: '',
    error: '',
    canRetry: false,
  };
  /** 场景切换令牌：异步回来时场景已经换了，就丢掉结果 */
  let token = 0;
  /** 当前场景的原料，重试时要用 */
  let last: {
    problem: string;
    scene: AnyScene;
    steps: Array<{ title: string }>;
    params: Record<string, number>;
  } | null = null;

  // ---------------- DOM ----------------
  const drawer = document.createElement('div');
  drawer.className = 'kp-drawer';
  drawer.dataset.open = 'false';

  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'kp-tab';
  tab.title = '本题用到的知识点';
  tab.textContent = '知识点';

  const panel = document.createElement('div');
  panel.className = 'kp-panel';

  const head = document.createElement('div');
  head.className = 'kp-head';
  const title = document.createElement('span');
  title.className = 'kp-title';
  title.textContent = '本题知识点';
  const count = document.createElement('span');
  count.className = 'kp-count';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'kp-icon';
  closeBtn.title = '收起';
  closeBtn.textContent = '×';
  head.append(title, count, closeBtn);

  const list = document.createElement('div');
  list.className = 'kp-list';

  const foot = document.createElement('div');
  foot.className = 'kp-foot';

  panel.append(head, list, foot);
  drawer.append(tab, panel);
  container.appendChild(drawer);
  /** 原始宿主：moveBack 要回这里 */
  const home = container;

  // ---------------- 渲染 ----------------
  function setOpen(on: boolean) {
    const was = drawer.dataset.open === 'true';
    drawer.dataset.open = on ? 'true' : 'false';
    tab.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (was !== on) opts.onLayoutChange();
  }

  function renderEmpty(msg: string) {
    list.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'kp-hint';
    p.textContent = msg;
    list.appendChild(p);
  }

  function renderSkeleton() {
    list.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const sk = document.createElement('div');
      sk.className = 'kp-skeleton';
      sk.innerHTML = '<i></i><i></i><i></i>';
      list.appendChild(sk);
    }
  }

  function renderPoints() {
    list.innerHTML = '';
    if (state.points.length === 0) {
      renderEmpty(state.note || '这道题暂时没有可整理的知识点。');
      return;
    }
    state.points.forEach((pt, i) => {
      const card = document.createElement('div');
      card.className = 'kp-card';

      const top = document.createElement('div');
      top.className = 'kp-card-top';
      const idx = document.createElement('span');
      idx.className = 'kp-idx';
      idx.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'kp-name';
      name.textContent = pt.name;
      top.append(idx, name);
      card.appendChild(top);

      if (pt.formula) {
        const f = document.createElement('div');
        f.className = 'kp-formula';
        f.innerHTML = renderMathText(pt.formula);
        card.appendChild(f);
      }
      if (pt.use) {
        const u = document.createElement('div');
        u.className = 'kp-use';
        u.innerHTML = `<b>本题</b>${renderMathText(pt.use)}`;
        card.appendChild(u);
      }
      if (pt.pitfall) {
        const w = document.createElement('div');
        w.className = 'kp-pit';
        w.innerHTML = `<b>易错</b>${renderMathText(pt.pitfall)}`;
        card.appendChild(w);
      }
      list.appendChild(card);
    });
  }

  function renderFoot() {
    foot.innerHTML = '';
    // 空列表时说明文字已经放在正文里了，页脚再重复一遍会很啰嗦
    if (state.note && state.points.length > 0) {
      const note = document.createElement('span');
      note.className = 'kp-note';
      note.textContent = state.note;
      foot.appendChild(note);
    }
    if (state.error || state.canRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn';
      retry.textContent = '重新整理';
      retry.addEventListener('click', () => {
        if (last) void load(last, true);
      });
      foot.appendChild(retry);
    }
  }

  function paint() {
    count.textContent = state.points.length ? `${state.points.length} 条` : '';
    renderPoints();
    renderFoot();
  }

  // ---------------- 加载 ----------------
  async function load(
    args: NonNullable<typeof last>,
    force = false,
  ): Promise<void> {
    last = args;
    const { problem, scene, steps } = args;
    const key = knowledgeKey(problem, scene);
    state.currentKey = key;
    state.error = '';
    state.canRetry = false;

    const cached = state.keys.get(key);
    if (cached && !force) {
      state.points = cached;
      state.note = '';
      paint();
      return;
    }

    const fallback = fallbackKnowledge(scene);
    // 没有题面（内置演示场景）：不花调用，直接给反推的名词
    if (!problem.trim()) {
      state.points = fallback;
      state.note = '演示场景没有题面，这里是从图上条件反推的知识点。';
      paint();
      return;
    }

    // 没填 Key：那次请求注定失败，别发。
    // 发出去的结果是学生第一眼看到一段红字"还没有填 API Key"——
    // 他会以为产品坏了，而不是"我还没配置"。所以这里静默给反推条目，
    // 页脚留一个「重新整理」，填完 Key 直接点一下就能取到完整知识点。
    if (!hasLlmKey()) {
      state.points = fallback;
      state.note = '上面是从图上条件反推的条目。填好 API Key 后点「重新整理」，可以取到含公式与用法的完整知识点。';
      state.canRetry = true;
      paint();
      return;
    }

    const my = ++token;
    state.loadingKey = key;
    state.points = [];
    state.note = '正在根据本题条件整理……';
    renderSkeleton();
    renderFoot();

    try {
      const facts = buildFactSheet(scene, args.params);
      const points = await requestKnowledge(
        problem,
        facts,
        steps.map((s) => s.title),
      );
      if (my !== token) return; // 场景已换，丢掉
      state.keys.set(key, points);
      state.points = points;
      state.note = '';
    } catch (err) {
      if (my !== token) return;
      state.points = fallback;
      state.error = (err as Error).message;
      // 原因要露出来：没填 Key 和"模型这次抽风"对用户是两件完全不同的事，
      // 只写"没整理出来"他会一直点重试
      const brief =
        state.error.length > 46 ? `${state.error.slice(0, 46)}…` : state.error;
      state.note = `${brief}（下面是按图上的条件反推的条目）`;
    } finally {
      if (my === token) {
        state.loadingKey = null;
        paint();
      }
    }
  }

  tab.addEventListener('click', () => setOpen(drawer.dataset.open !== 'true'));
  closeBtn.addEventListener('click', () => setOpen(false));

  return {
    setScene(args) {
      // 换题时保持当前开合状态：学生正在看知识点，换个题不该把抽屉弹回去
      void load(args);
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(drawer.dataset.open !== 'true'),
    isOpen: () => drawer.dataset.open === 'true',
    moveTo(host) {
      drawer.classList.add('in-video');
      host.appendChild(drawer);
    },
    moveBack() {
      drawer.classList.remove('in-video');
      home.appendChild(drawer);
    },
  };
}

/** 回归用：把清洗逻辑再导一次，避免测试直接依赖 llm 层内部路径 */
export { normalizeKnowledge, MAX_POINTS };
