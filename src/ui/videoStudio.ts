/**
 * videoStudio.ts —— 讲解视频工作台（视频化讲解 阶段②）
 *
 * 定位：完全独立的"第二个画布"。原有画布 / 分步交互 / 参数滑杆一行不动，
 * 这里自带一套 2D/3D 渲染器实例、自己的播放器和字幕条。
 *
 * 数据流（与主画布同源）：
 *   main.ts 把当前场景数据 + 参数交给 open()
 *     → 这里用自己的渲染器 setScene + 逐步 setStep
 *     → 播放器按节奏推进：切步骤 → 相机运镜 → 字幕条更新 → TTS 朗读
 *
 * 为什么不让主画布兼职播放器？——主画布的步骤是被用户"点着看"的，
 * 播放器的步骤是被时间"推着走"的。两种节奏塞进同一个状态机里，
 * 互相打断的 bug 会比功能本身还多。分开之后各自简单。
 */
import katex from 'katex';
import { SceneRenderer } from '../core/renderer';
import { Scene3DRenderer } from '../core/renderer3d';
import { isScene3D } from '../protocol/scene3d';
import type { Scene3D } from '../protocol/scene3d';
import type { Scene, StepDef } from '../protocol/scene';

type AnyScene = Scene | Scene3D;

export interface VideoStudioHandle {
  /** 打开工作台并装载一个场景（含 steps 时可播放，否则给出提示） */
  open(
    scene: AnyScene,
    params: Record<string, number>,
    title: string,
    /** 题目原文（可选）：显示在画面上方的题目栏里 */
    problem?: string,
  ): void;
}

/** 把 "文字 $公式$ 文字" 渲染成 HTML（与 main.ts 的逻辑一致，此处独立一份避免耦合） */
function renderMathText(text: string): string {
  const parts = text.split(/\$([^$]+)\$/g);
  return parts
    .map((seg, i) => {
      if (i % 2 === 1) {
        try {
          return katex.renderToString(seg, { throwOnError: false });
        } catch {
          return escapeHtml(seg);
        }
      }
      return escapeHtml(seg).replace(/\n/g, '<br>');
    })
    .join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 去掉 LaTeX 公式后的纯文字——喂给 TTS 用，公式读出来是一串符号噪音 */
function plainText(text: string): string {
  return text.replace(/\$[^$]*\$/g, '。').replace(/\s+/g, ' ').trim();
}

export function mountVideoStudio(): VideoStudioHandle {
  const root = document.getElementById('video-studio') as HTMLElement;
  buildDom(root);

  // ---- DOM 引用 ----
  const stage = root.querySelector('#vs-stage') as HTMLElement;
  const host2d = root.querySelector('#vs-host-2d') as HTMLElement;
  const host3d = root.querySelector('#vs-host-3d') as HTMLElement;
  const titleEl = root.querySelector('#vs-title') as HTMLElement;
  const problemEl = root.querySelector('#vs-problem') as HTMLElement;
  const subTitleEl = root.querySelector('#vs-sub-title') as HTMLElement;
  const subTextEl = root.querySelector('#vs-sub-text') as HTMLElement;
  const posEl = root.querySelector('#vs-pos') as HTMLElement;
  const barEl = root.querySelector('#vs-bar') as HTMLElement;
  const hintEl = root.querySelector('#vs-hint') as HTMLElement;
  const prevBtn = root.querySelector('#vs-prev') as HTMLButtonElement;
  const playBtn = root.querySelector('#vs-play') as HTMLButtonElement;
  const nextBtn = root.querySelector('#vs-next') as HTMLButtonElement;
  const closeBtn = root.querySelector('#vs-close') as HTMLButtonElement;
  const speedSel = root.querySelector('#vs-speed') as HTMLSelectElement;
  const voiceChk = root.querySelector('#vs-voice') as HTMLInputElement;

  // ---- 播放器状态 ----
  let scene2d: Scene | null = null;
  let scene3d: Scene3D | null = null;
  let space: '2d' | '3d' = '2d';
  let vsParams: Record<string, number> = {};
  let steps: StepDef[] = [];
  let idx = 0;
  let playing = false;
  let closed = true;
  let timer: number | null = null;

  // ---- 渲染器（懒创建：第一次打开才建，隐藏时不占资源）----
  let r2d: SceneRenderer | null = null;
  let r3d: Scene3DRenderer | null = null;

  function ensureRenderers() {
    if (!r2d) {
      r2d = new SceneRenderer(host2d);
    }
    if (!r3d) {
      r3d = new Scene3DRenderer(host3d);
    }
  }

  function showSpace(s: '2d' | '3d') {
    host2d.style.display = s === '2d' ? '' : 'none';
    host3d.style.display = s === '3d' ? '' : 'none';
  }

  // ---- TTS（浏览器自带语音合成，零成本）----
  function speak(text: string) {
    stopSpeak();
    if (!voiceChk.checked) return;
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(plainText(text));
    u.lang = 'zh-CN';
    u.rate = Number(speedSel.value);
    // 优先挑中文音色；不挑的话默认音色可能用英文腔读中文
    const zh = speechSynthesis
      .getVoices()
      .find((v) => v.lang.toLowerCase().startsWith('zh'));
    if (zh) u.voice = zh;
    speechSynthesis.speak(u);
  }

  function stopSpeak() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  /**
   * 等待当前步骤播完：
   * - 开语音：轮询朗读状态，读完后多留 350ms 呼吸；800ms 起步宽限 +
   *   8 秒硬上限，防"朗读还没开始/卡死"把播放器永远挂住
   * - 不开语音：按估算时长停留（每个中文字约 170ms，最少 2.8 秒）
   */
  function waitStep(text: string): Promise<void> {
    const chars = plainText(text).length;
    const minMs = Math.min(14000, Math.max(2800, chars * 170)) / Number(speedSel.value);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      if (voiceChk.checked && 'speechSynthesis' in window) {
        const cap = window.setTimeout(finish, minMs + 8000);
        const startedAt = performance.now();
        const probe = window.setInterval(() => {
          // 前 800ms 不判定：speechSynthesis 启动有延迟，刚 speak 完立刻查
          // speaking 可能还是 false，会把第 1 步瞬间跳过
          if (performance.now() - startedAt < 800) return;
          if (!speechSynthesis.speaking && !speechSynthesis.pending) {
            window.clearInterval(probe);
            window.clearTimeout(cap);
            window.setTimeout(finish, 350);
          }
        }, 200);
      } else {
        timer = window.setTimeout(finish, minMs);
      }
    });
  }

  // ---- 步骤推进 ----
  function renderStep() {
    if (steps.length === 0) return;
    idx = Math.max(0, Math.min(idx, steps.length - 1));
    const s = steps[idx];
    subTitleEl.textContent = s.title;
    subTextEl.innerHTML = renderMathText(s.text);
    posEl.textContent = `${idx + 1} / ${steps.length}`;
    barEl.style.width = `${((idx + 1) / steps.length) * 100}%`;
    prevBtn.disabled = idx === 0 || playing;
    nextBtn.disabled = idx === steps.length - 1 || playing;
    if (space === '3d') r3d?.setStep(idx);
    else r2d?.setStep(idx);
  }

  async function play() {
    if (steps.length === 0) return;
    playing = true;
    playBtn.textContent = '⏸ 暂停';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    // 从当前步开始连播到最后一步
    while (playing && idx < steps.length) {
      renderStep();
      speak(steps[idx].text);
      await waitStep(steps[idx].text);
      if (!playing) break;
      idx += 1;
    }
    if (idx >= steps.length) {
      // 播完了：停在最后一步，等用户按重播
      playing = false;
      playBtn.textContent = '↻ 重播';
      idx = steps.length - 1;
    }
    if (!playing) {
      playBtn.textContent = '▶ 播放';
      renderStep();
    }
  }

  function pause() {
    playing = false;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    stopSpeak();
    playBtn.textContent = '▶ 播放';
    renderStep();
  }

  function stopAll() {
    pause();
  }

  // ---- 事件 ----
  playBtn.addEventListener('click', () => (playing ? pause() : play()));
  prevBtn.addEventListener('click', () => {
    idx -= 1;
    renderStep();
  });
  nextBtn.addEventListener('click', () => {
    idx += 1;
    renderStep();
  });
  speedSel.addEventListener('change', () => {
    // 变速即时生效于下一段朗读；正在读的重读一遍当前步
    if (playing) {
      stopSpeak();
      speak(steps[idx]?.text ?? '');
    }
  });
  voiceChk.addEventListener('change', () => {
    if (!voiceChk.checked) stopSpeak();
  });
  closeBtn.addEventListener('click', () => {
    stopAll();
    closed = true;
    root.hidden = true;
    r3d?.setActive(false); // 挂起 3D 帧循环，省资源
  });
  document.addEventListener('keydown', (ev) => {
    if (closed || root.hidden) return;
    if (ev.key === 'Escape') closeBtn.click();
  });

  // ---- 组装 DOM（只在 mount 时执行一次）----
  function buildDom(r: HTMLElement) {
    r.innerHTML = `
      <div class="vs-inner">
        <div class="vs-head">
          <span class="vs-badge">讲解视频</span>
          <h2 id="vs-title"></h2>
          <button class="btn" id="vs-close">收起 ▴</button>
        </div>
        <div class="vs-stage-wrap">
          <div id="vs-problem" hidden></div>
          <div id="vs-stage">
            <div id="vs-host-2d"></div>
            <div id="vs-host-3d"></div>
          </div>
          <div class="vs-subtitle">
            <div id="vs-sub-title"></div>
            <div id="vs-sub-text"></div>
          </div>
          <div id="vs-hint" hidden></div>
        </div>
        <div class="vs-progress"><div id="vs-bar"></div></div>
        <div class="vs-controls">
          <button class="btn" id="vs-prev">上一步</button>
          <button class="btn primary" id="vs-play">▶ 播放</button>
          <button class="btn" id="vs-next">下一步</button>
          <span id="vs-pos" class="msg"></span>
          <span class="vs-spacer"></span>
          <!-- 低频设置收进 ⚙，控制条只留播放三键 -->
          <details class="vs-settings">
            <summary title="语速与语音设置">⚙ 设置</summary>
            <div class="vs-settings-pop">
              <label class="vs-opt">语速
                <select id="vs-speed">
                  <option value="0.8">0.8×</option>
                  <option value="1" selected>1×</option>
                  <option value="1.25">1.25×</option>
                  <option value="1.5">1.5×</option>
                </select>
              </label>
              <label class="vs-opt"><input type="checkbox" id="vs-voice" checked /> 语音讲解</label>
            </div>
          </details>
        </div>
        <p class="vs-note">播放会按步骤自动运镜并朗读讲解；导出视频文件在下一阶段提供。本画布独立于主画布，不影响原有操作。</p>
      </div>`;
  }

  return {
    open(scene, params, title, problem) {
      closed = false;
      root.hidden = false;
      titleEl.textContent = title;
      // 题目原文：有就展示，没有（内置场景没有题面）就整栏隐藏
      if (problem && problem.trim()) {
        problemEl.textContent = problem.trim();
        problemEl.hidden = false;
      } else {
        problemEl.hidden = true;
      }
      // 展开后滚到可见位置——板块在主工作区下方，不滚过去用户会以为没反应
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      vsParams = { ...params };
      steps = scene.steps ?? [];
      stopAll();

      if (isScene3D(scene)) {
        space = '3d';
        scene3d = scene;
        scene2d = null;
      } else {
        space = '2d';
        scene2d = scene;
        scene3d = null;
      }

      // 先把对应维度的宿主显示出来，再创建渲染器——
      // 顺序反了的话渲染器会量到 display:none 的 0 尺寸，画面缩成一点
      showSpace(space);
      ensureRenderers();
      if (space === '3d' && scene3d) {
        r3d!.setActive(true);
        r3d!.setScene(scene3d, vsParams);
      } else if (scene2d) {
        r2d!.setScene(scene2d, vsParams);
      }

      if (steps.length === 0) {
        hintEl.hidden = false;
        hintEl.textContent = '本题没有分步讲解数据（steps 为空），无法生成视频。换一道带 steps 的题目试试。';
        playBtn.disabled = true;
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        subTitleEl.textContent = '—';
        subTextEl.textContent = '';
        posEl.textContent = '';
        barEl.style.width = '0%';
        return;
      }
      hintEl.hidden = true;
      playBtn.disabled = false;
      idx = 0;
      renderStep();
    },
  };
}
