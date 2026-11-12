/**
 * shell.ts —— 课件外壳：把 CoursewareSpec 渲染成一堂能投屏的课
 *
 * ===== 它只做四件事 =====
 *   1. 摆版式：左侧主情境 + 右侧分析栏 + 底部步骤卡与播放器
 *   2. 联动：拖参数（或任意视图里的动点），所有视图与数字一起变
 *   3. 演课：四步卡片 + 自动演示时间轴 + 验证按钮（有最优解的课件才有）
 *   4. 换肤：深色炫酷（默认）↔ 浅色投屏，画布内配色跟着整组切
 *
 * ===== 为什么外壳不复用 main.ts 的 DOM =====
 * main.ts 的界面是"给老师生成任意题"用的：左边一列 JSON、知识抽屉、题本。
 * 课件是"给学生走一遍固定探究"用的：没有输入框，没有报错日志，只有图和步骤。
 * 两套版式的信息密度相反，硬塞进同一个 DOM 会互相挤压。
 * 但底层完全共用：同一个 SceneRenderer（2D）、同一份 Scene 协议。
 *
 * 将来合并进 MathMate 时，只需在 scene-picker 里加一项，
 * 把 mountCourseware() 的 root 换成主画布容器即可。
 */
import './shell.css';
import 'katex/dist/katex.min.css';
import { SceneRenderer } from '../core/renderer';
import { Scene3DRenderer } from '../core/renderer3d';
import { evalAny } from '../protocol/expr';
import { escapeHtml, renderMathText } from '../ui/mathText';
import type { Scene3D } from '../protocol/scene3d';
import type { Scene } from '../protocol/scene';
import type { CoursewareSpec } from './spec';

/** 同一板块里可切换的其他课件（顶部导航胶囊） */
export interface CwSibling {
  id: string;
  title: string;
}

// ---------------------------------------------------------------
// 两套画布配色：深色炫酷（默认）/ 浅色投屏。
// 关键取舍：投影机会压对比度，所以浅色档特意保持旧的"工程白"，
// 深色档才做夜蓝 + 亮网格——上课就用浅色，自己看就用深色。
// ---------------------------------------------------------------
const CANVAS_DARK = {
  bg: '#0d1526',
  grid: '#223052',
  axis: '#3c4c6e',
  tick: '#7f8db0',
  label: '#e8ecf6',
};
const CANVAS_LIGHT = {
  bg: '#f7f6f3',
  grid: '#d8d5cc',
  axis: '#6b6960',
  tick: '#6b6960',
  label: '#2c2c2a',
};

type AnyRenderer = SceneRenderer | Scene3DRenderer;

export function mountCourseware(
  root: HTMLElement,
  spec: CoursewareSpec,
  siblings: CwSibling[] = [],
) {
  let params: Record<string, number> = { ...spec.params };
  let stepIndex = 0;
  // 深链可指定主题（?theme=light）：备课时把"投屏版"状态直接发出去
  let dark = new URLSearchParams(location.search).get('theme') !== 'light';

  const P = spec.primary.name;

  // 每个并排视图一个渲染器（按容器实例化，互不干扰）
  const renderers = new Map<string, AnyRenderer>();

  const navHtml = siblings.length
    ? `<nav class="cw-nav">${siblings
        .map(
          (s) =>
            `<button class="cw-nav-pill${s.id === spec.id ? ' on' : ''}" data-id="${s.id}">${escapeHtml(s.title)}</button>`,
        )
        .join('')}</nav>`
    : '';

  root.innerHTML = `
    <div class="cw${dark ? ' cw--dark' : ''}">
      <header class="cw-top">
        <div class="cw-crumb">
          <span class="cw-subject">${escapeHtml(spec.subject)}</span>
          <span class="cw-sep">/</span>
          <span>${escapeHtml(spec.chapter)}</span>
          <span class="cw-code">${escapeHtml(spec.code)}</span>
        </div>
        <h1 class="cw-title">${escapeHtml(spec.title)}</h1>
        <p class="cw-sub">${escapeHtml(spec.subtitle)}</p>
        <div class="cw-top-actions">
          ${navHtml}
          <button class="cw-icon-btn" id="cw-theme" title="深色炫酷 / 浅色投屏">${dark ? '浅色投屏' : '炫酷深色'}</button>
          <button class="cw-icon-btn" id="cw-full" title="全屏">全屏</button>
        </div>
      </header>

      <div class="cw-body">
        <section class="cw-card cw-stage">
          <div class="cw-head">
            <span class="cw-badge">01</span>
            <div class="cw-head-txt">
              <b>${escapeHtml(spec.panes[0].title)}</b>
              <i>${escapeHtml(spec.panes[0].hint)}</i>
            </div>
          </div>
          <div class="cw-canvas" id="cw-pane-${spec.panes[0].key}"></div>
          <div class="cw-under">
            <div class="cw-question">${escapeHtml(spec.question)}</div>
            <label class="cw-slider">
              <span>${escapeHtml(spec.primary.label)}</span>
              <input type="range" id="cw-p" min="${spec.primary.min}" max="${spec.primary.max}" step="${spec.primary.step}" />
            </label>
          </div>
        </section>

        <aside class="cw-side">
          <section class="cw-card">
            <div class="cw-head">
              <span class="cw-badge">02</span>
              <div class="cw-head-txt">
                <b>路径分析</b>
                <i>随拖动实时更新</i>
              </div>
            </div>
            <div class="cw-metrics" id="cw-metrics"></div>
          </section>

          <section class="cw-card cw-grow">
            <div class="cw-head">
              <span class="cw-badge">${escapeHtml(spec.panes[1]?.badge ?? '03')}</span>
              <div class="cw-head-txt">
                <b>${escapeHtml(spec.panes[1]?.title ?? '')}</b>
                <i>${escapeHtml(spec.panes[1]?.hint ?? '')}</i>
              </div>
            </div>
            <div class="cw-canvas" id="cw-pane-${spec.panes[1]?.key ?? 'proof'}"></div>
          </section>

          <section class="cw-card cw-hint">
            <div class="cw-hint-top"><b>想一想</b>${spec.best ? '<button class="cw-btn" id="cw-verify">验证</button>' : ''}</div>
            <p>${renderMathText(spec.hint)}</p>
          </section>
        </aside>
      </div>

      <footer class="cw-foot">
        <div class="cw-steps" id="cw-steps">
          ${spec.steps
            .map(
              (s, i) => `
            <button class="cw-step" data-i="${i}">
              <span class="cw-step-no">${escapeHtml(s.no)}</span>
              <span class="cw-step-thumb">${s.thumb}</span>
              <span class="cw-step-txt">
                <b>${escapeHtml(s.title)}</b>
                <i>${escapeHtml(s.caption)}</i>
              </span>
            </button>`,
            )
            .join('')}
        </div>

        <div class="cw-player">
          <button class="cw-play" id="cw-play" title="播放 / 暂停">▶</button>
          <span class="cw-time" id="cw-time"></span>
          <input type="range" id="cw-seek" class="cw-seek" min="0" max="1000" value="0" />
          <div class="cw-speeds" id="cw-speeds">
            <button data-s="0.5">0.5x</button><button data-s="1" class="on">1x</button><button data-s="2">2x</button>
          </div>
          <button class="cw-icon-btn" id="cw-reset">重置</button>
          <div class="cw-caption" id="cw-caption"></div>
        </div>
      </footer>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;

  // -------------------------------------------------------------
  // 建视图：2D 走 SceneRenderer，3D 走 Scene3DRenderer
  // -------------------------------------------------------------
  for (const pane of spec.panes) {
    const host = $(`#cw-pane-${pane.key}`);
    if (!host) continue;
    const r: AnyRenderer =
      pane.kind === '3d' ? new Scene3DRenderer(host) : new SceneRenderer(host);
    applyCanvasTheme(r, dark);
    if (pane.kind === '3d') {
      (r as Scene3DRenderer).setScene(pane.scene(params) as Scene3D, params);
    } else {
      (r as SceneRenderer).setScene(pane.scene(params) as Scene, params);
    }
    // 拖动时：本体视图自己已重绘，把"别的视图"和数字补上即可
    r.onParamChange = (name, value) => {
      params[name] = value;
      for (const [key, other] of renderers) {
        if (key === pane.key) continue;
        syncParam(other, spec, key, params);
      }
      const slider = $<HTMLInputElement>('#cw-p');
      if (slider && name === P) slider.value = String(value);
      renderMetrics();
      // 用户一动，演示就停：否则播放器会和手指抢参数
      if (playing) stopPlay();
    };
    renderers.set(pane.key, r);
  }

  /** 单个参数同步到某个视图：2D 走增量 setParam（拖拽不闪），3D 整体重建 */
  function syncParam(r: AnyRenderer, spec: CoursewareSpec, paneKey: string, params: Record<string, number>) {
    const pane = spec.panes.find((p) => p.key === paneKey);
    if (!pane) return;
    if (pane.kind === '3d') {
      (r as Scene3DRenderer).setScene(pane.scene(params) as Scene3D, params, false);
    } else {
      for (const [name, value] of Object.entries(params)) {
        (r as SceneRenderer).setParam(name, value);
      }
    }
  }

  /** 画布配色跟随主题；2D/3D 各有 setBg */
  function applyCanvasTheme(r: AnyRenderer, dark: boolean) {
    const c = dark ? CANVAS_DARK : CANVAS_LIGHT;
    if (r instanceof Scene3DRenderer) {
      r.setBg(c.bg, { edge: dark ? '#9aa6c0' : undefined, label: dark ? c.label : undefined });
    } else {
      r.setBg(c.bg, { grid: c.grid, axis: c.axis, tick: c.tick, label: c.label });
    }
  }

  function reapplyTheme() {
    for (const r of renderers.values()) applyCanvasTheme(r, dark);
    // 2D/3D 的 setBg 内部都会重建场景；但重建不恢复"当前步骤"的语义
    // 由 setStep 补一次（幂等，代价一次遍历）。
    for (const r of renderers.values()) r.setStep(stepIndex);
    renderMetrics();
  }

  // -------------------------------------------------------------
  // 数字面板：数值 + 条形对比（值变化时短暂发光，"数字是活的"）
  // -------------------------------------------------------------
  let lastValues: string[] = [];
  function renderMetrics() {
    const box = $('#cw-metrics');
    const rows = spec.readouts
      .map((r) => {
        let v = NaN;
        try {
          const got = evalAny(r.expr, { ...params });
          if (typeof got === 'number') v = got;
        } catch {
          /* 表达式写错就显示 —，不打断页面 */
        }
        const text = Number.isFinite(v) ? v.toFixed(2) + (r.unit ?? '') : '—';
        const w = Number.isFinite(v) ? Math.max(2, Math.min(100, (v / r.barMax) * 100)) : 0;
        const changed = lastValues.length > 0 && lastValues[spec.readouts.indexOf(r)] !== text;
        return `
          <div class="cw-metric">
            <span class="cw-metric-k">${escapeHtml(r.label)}</span>
            <span class="cw-metric-v${changed ? ' flash' : ''}">${text}</span>
            <span class="cw-metric-bar"><i style="width:${w}%;background:${r.color ?? 'var(--accent)'}"></i></span>
          </div>`;
      })
      .join('');
    box.innerHTML = rows;
    lastValues = spec.readouts.map((r) => {
      try {
        const got = evalAny(r.expr, { ...params });
        return typeof got === 'number' ? got.toFixed(2) + (r.unit ?? '') : '—';
      } catch {
        return '—';
      }
    });
  }

  // -------------------------------------------------------------
  // 步骤
  // -------------------------------------------------------------
  function setStep(i: number) {
    stepIndex = Math.max(0, Math.min(spec.steps.length - 1, i));
    for (const r of renderers.values()) r.setStep(stepIndex);
    root.querySelectorAll<HTMLElement>('.cw-step').forEach((el) => {
      el.classList.toggle('on', Number(el.dataset.i) === stepIndex);
    });
  }

  root.querySelectorAll<HTMLElement>('.cw-step').forEach((el) => {
    el.addEventListener('click', () => {
      if (playing) stopPlay();
      const i = Number(el.dataset.i);
      const st = spec.steps[i];
      if (st.params) {
        params = { ...params, ...st.params };
        applyAll();
      }
      setStep(i);
    });
  });

  /** 参数整体变化后：所有视图重建 + 数字刷新 */
  function applyAll() {
    for (const pane of spec.panes) {
      const r = renderers.get(pane.key);
      if (!r) continue;
      if (pane.kind === '3d') (r as Scene3DRenderer).setScene(pane.scene(params) as Scene3D, params, false);
      else (r as SceneRenderer).setScene(pane.scene(params) as Scene, params);
    }
    for (const r of renderers.values()) r.setStep(stepIndex);
    const slider = $<HTMLInputElement>('#cw-p');
    if (slider) slider.value = String(params[P] ?? 0);
    renderMetrics();
  }

  // -------------------------------------------------------------
  // 滑杆（课件唯一自由度）
  // -------------------------------------------------------------
  const slider = $<HTMLInputElement>('#cw-p');
  slider.value = String(params[P] ?? 0);
  slider.addEventListener('input', () => {
    if (playing) stopPlay();
    const v = Number(slider.value);
    params[P] = v;
    for (const [key, r] of renderers) syncParam(r, spec, key, params);
    renderMetrics();
  });

  // -------------------------------------------------------------
  // 主题切换：深色炫酷 ↔ 浅色投屏（画布内配色一起换）
  // -------------------------------------------------------------
  const themeBtn = $<HTMLButtonElement>('#cw-theme');
  themeBtn.addEventListener('click', () => {
    dark = !dark;
    root.querySelector('.cw')!.classList.toggle('cw--dark', dark);
    themeBtn.textContent = dark ? '浅色投屏' : '炫酷深色';
    reapplyTheme();
  });

  // -------------------------------------------------------------
  // 课件导航（同板块的其他探究案）
  // -------------------------------------------------------------
  root.querySelectorAll<HTMLElement>('.cw-nav-pill').forEach((b) => {
    b.addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.set('id', b.dataset.id ?? '');
      location.href = url.toString();
    });
  });

  // -------------------------------------------------------------
  // 自动演示播放器
  // -------------------------------------------------------------
  const playBtn = $<HTMLButtonElement>('#cw-play');
  const timeEl = $('#cw-time');
  const seek = $<HTMLInputElement>('#cw-seek');
  const capEl = $('#cw-caption');
  let playing = false;
  let playT = 0;
  let lastTs = 0;
  let speed = 1;
  let raf = 0;

  const mmss = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function paintCaption() {
    const list = spec.captions.filter((c) => c.at <= playT);
    const cur = list[list.length - 1];
    capEl.innerHTML = cur ? renderMathText(cur.text) : '';
  }

  function applyAt(t: number) {
    const s = spec.track(t);
    params = { ...params, ...s.params };
    for (const [key, r] of renderers) syncParam(r, spec, key, params);
    if (s.step !== stepIndex) setStep(s.step);
    renderMetrics();
    seek.value = String(Math.round((t / spec.duration) * 1000));
    timeEl.textContent = `${mmss(t)} / ${mmss(spec.duration)}`;
    paintCaption();
  }

  function tick(ts: number) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    playT += ((ts - lastTs) / 1000) * speed;
    lastTs = ts;
    if (playT >= spec.duration) {
      playT = spec.duration;
      applyAt(playT);
      stopPlay();
      return;
    }
    applyAt(playT);
    raf = requestAnimationFrame(tick);
  }

  function startPlay() {
    if (playT >= spec.duration) playT = 0;
    playing = true;
    lastTs = 0;
    playBtn.textContent = '❚❚';
    raf = requestAnimationFrame(tick);
  }

  function stopPlay() {
    playing = false;
    cancelAnimationFrame(raf);
    playBtn.textContent = '▶';
  }

  playBtn.addEventListener('click', () => (playing ? stopPlay() : startPlay()));

  seek.addEventListener('input', () => {
    stopPlay();
    playT = (Number(seek.value) / 1000) * spec.duration;
    applyAt(playT);
  });

  root.querySelectorAll<HTMLElement>('#cw-speeds button').forEach((b) => {
    b.addEventListener('click', () => {
      speed = Number(b.dataset.s);
      root
        .querySelectorAll('#cw-speeds button')
        .forEach((x) => x.classList.toggle('on', x === b));
    });
  });

  $<HTMLButtonElement>('#cw-reset').addEventListener('click', () => {
    stopPlay();
    playT = 0;
    params = { ...spec.params };
    stepIndex = 0;
    applyAll();
    applyAt(0);
  });

  // -------------------------------------------------------------
  // 验证：把参数平滑移到最优值，并给出结论（没有最优解的课件没有这个按钮）
  // -------------------------------------------------------------
  if (spec.best) {
    $<HTMLButtonElement>('#cw-verify').addEventListener('click', () => {
      stopPlay();
      const target = spec.best![P];
      if (!Number.isFinite(target)) return;
      const from = params[P] ?? 0;
      const t0 = performance.now();
      const dur = 700;
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        const v = from + (target - from) * e;
        params[P] = v;
        for (const [key, r] of renderers) syncParam(r, spec, key, params);
        slider.value = String(v);
        renderMetrics();
        if (k < 1) requestAnimationFrame(step);
        else toast(spec.bestNote ?? '已到达目标状态');
      };
      requestAnimationFrame(step);
    });
  }

  function toast(msg: string) {
    const el = document.createElement('div');
    el.className = 'cw-toast';
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }

  // -------------------------------------------------------------
  // 全屏与键盘
  // -------------------------------------------------------------
  $<HTMLButtonElement>('#cw-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });

  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowRight') setStep(stepIndex + 1);
    else if (e.key === 'ArrowLeft') setStep(stepIndex - 1);
    else if (e.key === ' ') {
      e.preventDefault();
      playing ? stopPlay() : startPlay();
    }
  });

  // 首屏
  renderMetrics();
  setStep(0);
  timeEl.textContent = `00:00 / ${mmss(spec.duration)}`;

  return { applyAll, setStep, spec };
}
