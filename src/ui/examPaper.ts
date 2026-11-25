/**
 * examPaper.ts —— 组卷：从题本勾选若干题，排版成一份可打印的试卷。
 *
 * 三条实现决策：
 *
 *   1. 导出走浏览器打印（window.print + @media print），不引入 jsPDF。
 *      浏览器"另存为 PDF"的效果就是最终交付物，CSS 排版比 jsPDF
 *      逐坐标画框省一个量级的工作量，分页也是浏览器自己处理。
 *
 *   2. 图用离屏渲染器现场截：题本里只存了场景 JSON，恢复一张静态图
 *      需要实例化渲染器 → setScene → toDataURL → dispose。
 *      离屏实例必须开 preserveDrawingBuffer（否则截图是空的），
 *      用完必须 dispose（WebGL context 全页限 ~16 个，不释放会全变黑）。
 *
 *   3. 题面与步骤走 renderMathText（和主界面同一套 KaTeX 渲染）。
 *      直接 innerHTML 塞原文会把 $...$ 当正文印出来；
 *      plainText 又会把公式替换成句号（那是给 TTS 用的），
 *      两条捷径都不行——所以复用主界面这条渲染路径。
 */

import { isScene3D } from '../protocol/scene3d';
import type { Scene } from '../protocol/scene';
import type { Scene3D } from '../protocol/scene3d';
import { parseScene } from '../protocol/parser';
import { parseScene3D } from '../protocol/parser3d';
import { SceneRenderer } from '../core/renderer';
import { Scene3DRenderer } from '../core/renderer3d';
import { renderMathText, escapeHtml } from './mathText';

export interface PaperItem {
  id: string;
  title: string;
  prompt: string;
  sceneJson: string;
}

interface PaperBlock extends PaperItem {
  /** 截图 dataURL；null = 图打不开（旧存档 / 3D 解析失败），只出题面 */
  image: string | null;
  /** 组卷时老师可以单独关掉某题的图——生成器在纯文字题上会硬造出不相关的图 */
  showImage: boolean;
  /** 教师版用的参考步骤 */
  steps: Array<{ title: string; text: string }>;
}

/** 试卷里图的尺寸（CSS 像素）。A4 版心约 700px 宽，图占左/中较合适 */
const IMG_W = 640;
const IMG_H = 400;

/** 把 params 定义数组转成默认值表（离屏渲染要用） */
function defaultsOf(scene: Scene | Scene3D): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of scene.params ?? []) out[p.name] = p.value;
  return out;
}

/** 从未解析的 JSON 里尽量掏出步骤（图挂了也要给教师版留步骤） */
function stepsOf(parsed: unknown): Array<{ title: string; text: string }> {
  const s = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(s)) return [];
  return s
    .filter(
      (x): x is { title: string; text: string } =>
        !!x && typeof x === 'object' && typeof (x as { title?: unknown }).title === 'string',
    )
    .map((x) => ({ title: x.title, text: typeof x.text === 'string' ? x.text : '' }));
}

/* ===============================================================
 * 卷面题面清洗
 *
 * 拍照识题的转录稿（stub.ts 的 TRANSCRIBE_PROMPT）是三段式结构：
 * 【已知】/【求证/求】/【图形结构】——那是给场景生成器看的，
 * 不是给学生看的。原样印到卷子上会出现两灾难：
 *   ① 【图形结构】整段模型自述（"图片中无几何图形，仅有文字描述…"）
 *   ② 公式是"普通文本"格式（sqrt(3)bc），和卷面已有的 a² 风格割裂
 * 另外转录稿会自带原题号（"2. 【求证/求】"），和卷面编号打架。
 * 这里在**渲染层**清洗：不改存档数据，老题本条目也能救回来。
 * =============================================================== */

/** 行首的孤立编号 + 紧跟段标题 → 视为转录稿自带的原题号，删掉 */
const DUP_NUM_RE = /^[ \t]*\d+\s*[.、．]\s*(?=【)/gm;

/** 段标题行：【已知】/【求证/求】/【求证】/【求】，允许带冒号。/gm：每一段都要换 */
const SECTION_LINE_RE = /^[ \t]*【?(已知|求证\/求|求证|求)】?[:：]?[ \t]*/gm;

/**
 * 裸数学美化：转录稿里公式是普通文本（sqrt(2)、2cosB），
 * 卷面上要让它们和 Unicode 上标（a²）一个风格。
 * 刻意不走 KaTeX——带中文的行渲染失败率太高，Unicode 替换零风险。
 */
export function prettifyBareMath(s: string): string {
  // sqrt(3) → √3；sqrt(a+b) → √(a+b)。内容是单个数字/字母时省括号更自然
  const out = s.replace(/sqrt\s*\(([^()]+)\)/gi, (_m, inner: string) => {
    const t = inner.trim();
    return /^[0-9a-zA-Z]$/.test(t) ? `√${t}` : `√(${t})`;
  });
  // 2cosB → 2cos B：函数名和变量名连在一起会被读成"cosB"一个词
  return out.replace(/(^|[^a-zA-Z])(cos|sin|tan|cot|log|ln)(?=[A-Z])/g, '$1$2 ');
}

/** 清洗卷面题面（纯文本，供测试与渲染共用） */
export function paperProblem(raw: string): string {
  let t = String(raw ?? '').replace(/\r/g, '');
  // ① 【图形结构】及其后全部内容：给生成器看的骨架描述，不上卷
  const cut = t.search(/【图形结构】/);
  if (cut >= 0) t = t.slice(0, cut);
  // ② 转录稿自带的原题号（"2. 【已知】"）——只删紧跟段标题的编号，
  //    条件列表里的"1. 在△ABC中"是有效内容，不能误伤
  t = t.replace(DUP_NUM_RE, '');
  // ③ 裸数学转 Unicode 风格
  t = prettifyBareMath(t);
  return t.trim();
}

/**
 * 卷面题面 → HTML。段标题换成带样式的小标签（占位符法：
 * 先用 \u0001/\u0002 包住标题词，renderMathText 的 escapeHtml 不会动它们，
 * 之后替换成 <span>——直接在替换阶段插 HTML 会被转义掉）。
 */
export function renderPaperPrompt(raw: string, fallbackTitle: string): string {
  const text = paperProblem(raw);
  if (!text) return escapeHtml(fallbackTitle);
  const marked = text.replace(SECTION_LINE_RE, (_m, w: string) =>
    `\u0001${w === '已知' ? '已知' : '求'}\u0002`,
  );
  return renderMathText(marked)
    .replace(/\u0001/g, '<span class="paper-sec">【')
    .replace(/\u0002/g, '】</span>');
}

/**
 * 组卷面板。独立于主界面：挂 body 下，打印时只显示它。
 * 返回 close 供外部（Esc）关闭。
 */
export function openExamPaper(items: PaperItem[]): { close(): void } {
  // ---------- 骨架 ----------
  const root = document.createElement('div');
  root.className = 'paper-root';
  document.body.appendChild(root);
  document.body.classList.add('paper-open');

  let blocks: PaperBlock[] = items.map((it) => ({
    ...it,
    image: null,
    showImage: true,
    steps: [],
  }));
  let teacherMode = false;

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function paint() {
    const d = new Date();
    const dateStr = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    root.innerHTML = `
      <div class="paper-toolbar no-print">
        <input id="paper-title" value="${esc(title)}" spellcheck="false" />
        <label class="paper-teacher"><input type="checkbox" id="paper-teacher-chk"${teacherMode ? ' checked' : ''}/> 教师版（含参考步骤）</label>
        <span class="paper-count">${blocks.length} 题</span>
        <button class="btn" id="paper-print">打印 / 另存为 PDF</button>
        <button class="btn" id="paper-close">关闭</button>
      </div>
      <div class="paper-scroll">
        <div class="paper-page">
          <div class="paper-head">
            <h1 id="paper-head-title">${esc(title)}</h1>
            <div class="paper-meta">
              <span>班级 ________　姓名 ________　学号 ________</span>
              <span>${dateStr} · MathMate 组卷</span>
            </div>
          </div>
          ${blocks
            .map(
              (b, i) => `
            <div class="paper-item" data-idx="${i}">
              <div class="paper-q">
                <div class="paper-q-text"><b>${i + 1}.</b> ${renderPaperPrompt(b.prompt, b.title)}</div>
                ${b.image && b.showImage ? `<img class="paper-img" src="${b.image}" alt="题图 ${i + 1}" />` : ''}
                ${!b.image ? '<div class="paper-img paper-img-missing no-print">（本题暂无图）</div>' : ''}
                ${b.image && !b.showImage ? '<div class="paper-img paper-img-missing no-print">（本题的图已被隐藏）</div>' : ''}
                ${teacherMode && b.steps.length ? `
                  <div class="paper-steps">
                    <div class="paper-steps-title">参考步骤</div>
                    ${b.steps.map((s, si) => `<div class="paper-step"><b>${si + 1}) ${renderMathText(s.title)}</b>${s.text ? `<div class="paper-step-body">${renderMathText(s.text)}</div>` : ''}</div>`).join('')}
                  </div>` : ''}
              </div>
              <div class="paper-item-tools no-print">
                <button class="btn" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn" data-act="down" ${i === blocks.length - 1 ? 'disabled' : ''}>↓</button>
                ${b.image ? `<button class="btn" data-act="img" title="生成器造的图不一定贴合题意，不贴合就不印">${b.showImage ? '藏图' : '显图'}</button>` : ''}
                <button class="btn" data-act="del">移除</button>
              </div>
            </div>`,
            )
            .join('')}
          ${blocks.length === 0 ? '<div class="paper-empty">题目都被移除了。关闭后回题本重新勾选。</div>' : ''}
        </div>
      </div>`;

    // 工具栏事件（每次 paint 重绑——工具栏也是重建的）
    const titleInput = root.querySelector<HTMLInputElement>('#paper-title');
    titleInput?.addEventListener('input', () => {
      title = titleInput.value || '数学练习';
      const h = root.querySelector<HTMLElement>('#paper-head-title');
      if (h) h.textContent = title;
    });
    root.querySelector<HTMLInputElement>('#paper-teacher-chk')?.addEventListener('change', (e) => {
      teacherMode = (e.target as HTMLInputElement).checked;
      paint();
    });
    root.querySelector<HTMLButtonElement>('#paper-print')?.addEventListener('click', () => window.print());
    root.querySelector<HTMLButtonElement>('#paper-close')?.addEventListener('click', () => close());
    root.querySelectorAll<HTMLButtonElement>('.paper-item-tools [data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.closest<HTMLElement>('.paper-item')?.dataset.idx ?? -1);
        if (idx < 0) return;
        const act = btn.dataset.act;
        if (act === 'del') blocks.splice(idx, 1);
        if (act === 'img') blocks[idx].showImage = !blocks[idx].showImage;
        if (act === 'up' && idx > 0) [blocks[idx - 1], blocks[idx]] = [blocks[idx], blocks[idx - 1]];
        if (act === 'down' && idx < blocks.length - 1)
          [blocks[idx + 1], blocks[idx]] = [blocks[idx], blocks[idx + 1]];
        paint();
      });
    });
  }

  let title = '数学练习';

  function onKey(e: KeyboardEvent) {
    // 投屏模式开着时别抢 Esc；打印对话框期间浏览器自己处理
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);

  function close() {
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('paper-open');
    root.remove();
  }

  paint();

  // ---------- 逐题截图（异步、顺序，避免并发挤爆 WebGL 上限） ----------
  void (async () => {
    for (let i = 0; i < blocks.length; i++) {
      try {
        const r = await renderOneAsync(blocks[i].sceneJson);
        if (!document.body.contains(root)) return; // 已经关掉了
        blocks[i] = { ...blocks[i], image: r.image, steps: r.steps };
        // 只补这一题的图，不整页重绘（避免打断正在输入的标题）
        const item = root.querySelector<HTMLElement>(`.paper-item[data-idx="${i}"]`);
        if (item) {
          const img = item.querySelector('.paper-img');
          if (img) {
            if (r.image) {
              const el = document.createElement('img');
              el.className = 'paper-img';
              el.src = r.image;
              el.alt = `题图 ${i + 1}`;
              img.replaceWith(el);
            }
          } else if (r.image) {
            const miss = item.querySelector('.paper-img-missing');
            if (miss) {
              const el = document.createElement('img');
              el.className = 'paper-img';
              el.src = r.image;
              el.alt = `题图 ${i + 1}`;
              miss.replaceWith(el);
            }
          }
          // 图到了才有「藏图」可言——工具栏是 paint 时按 blocks[i].image
          // 渲染的，那时图还没截好。这里手动补一颗，不然按钮要等下次
          // 任意重绘才出现（实测踩过：打开卷子看不到藏图按钮）
          if (r.image && !item.querySelector('[data-act="img"]')) {
            const tools = item.querySelector('.paper-item-tools');
            const del = tools?.querySelector('[data-act="del"]');
            if (tools && del) {
              const b = document.createElement('button');
              b.className = 'btn';
              b.dataset.act = 'img';
              b.title = '生成器造的图不一定贴合题意，不贴合就不印';
              b.textContent = '藏图';
              tools.insertBefore(b, del);
              b.addEventListener('click', () => {
                const idx = Number(item.dataset.idx ?? -1);
                if (idx < 0) return;
                blocks[idx].showImage = !blocks[idx].showImage;
                paint();
              });
            }
          }
          if (teacherMode && r.steps.length) {
            // 教师版步骤在首次 paint 时还没有——有图了才有 steps，重建一次最省事
            const cur = root.querySelector<HTMLInputElement>('#paper-title')?.value;
            title = cur || title;
            paint();
          }
        }
      } catch {
        // 单题截图失败不拦整卷
      }
    }
  })();

  return { close };
}

/**
 * 离屏渲染一张题图（异步：3D 场景要等 rAF 出帧后再截）。
 * 任何一步失败 image 返回 null——试卷不能因为一张图卡住，缺图的题照样出。
 */
async function renderOneAsync(
  sceneJson: string,
): Promise<{ image: string | null; steps: Array<{ title: string; text: string }> }> {
  const parsed = JSON.parse(sceneJson) as unknown;
  const steps = stepsOf(parsed);
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:-10000px;top:0;' +
    `width:${IMG_W}px;height:${IMG_H}px;overflow:hidden;`;
  document.body.appendChild(host);

  let renderer: SceneRenderer | Scene3DRenderer | null = null;
  const wait = (n: number) =>
    new Promise<void>((res) => {
      let k = 0;
      const step = () => (k++ >= n ? res() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });

  try {
    if (isScene3D(parsed)) {
      const scene = parseScene3D(JSON.stringify(parsed));
      if (!scene.ok) return { image: null, steps };
      const r3 = new Scene3DRenderer(host, { preserveDrawingBuffer: true });
      renderer = r3;
      r3.setScene(scene.scene, defaultsOf(scene.scene), true);
      await wait(2); // 3D 绘制在 rAF 循环里
      return { image: r3.domToDataURL(IMG_W, IMG_H), steps };
    }
    const scene = parseScene(JSON.stringify(parsed));
    if (!scene.ok) return { image: null, steps };
    const r2 = new SceneRenderer(host, { preserveDrawingBuffer: true });
    renderer = r2;
    r2.setScene(scene.scene, defaultsOf(scene.scene));
    await wait(1); // 等一帧：字体/标签 sprite 首次绘制更稳
    return { image: r2.domToDataURL(IMG_W, IMG_H), steps: scene.scene.steps ?? [] };
  } catch {
    return { image: null, steps };
  } finally {
    renderer?.dispose();
    host.remove();
  }
}
