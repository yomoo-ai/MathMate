/**
 * videoStudio.ts —— 讲解视频工作台（阶段一：动作脚本 + 板书）
 *
 * 定位：完全独立的"第二个画布"。原有画布 / 分步交互 / 参数滑杆一行不动，
 * 这里自带一套 2D/3D 渲染器实例、自己的播放器和板书栏。
 *
 * ===== 这一版的播放模型变了 =====
 * 旧版：一句话 → 换高亮 → 换字幕 → 等语音读完。本质是"翻页"，一页一个重点。
 * 新版：一句话 → 演一组几何动作（作线 / 标角 / 标长度）→ 往板书添几行推导。
 *       动作演完**留在图上**，讲到第五句时前四句的痕迹都还在。
 *       这才是"在黑板上讲题"，而不是"放 PPT"。
 *
 * 数据流：
 *   main.ts 把场景 + 参数交给 open()
 *     → buildNarration 生成动作脚本（失败降级为本地合成）
 *     → compileTimeline 编译成时间轴（每个动作有开始时间与时长）
 *     → play() 逐句推进：每句用 rAF 逐帧采样 sampleBeat(i, t)，
 *       把覆盖图形交给渲染器、把板书行交给 DOM
 *     → 语音（TTS）与动画并行，谁长等谁
 *
 * 为什么每句单独计时而不是一条全局时间轴：TTS 长度不可预知
 * （同样的字，不同音色能差 30%），全局时间轴会和语音越走越错位。
 */
import { SceneRenderer } from '../core/renderer';
import { Scene3DRenderer } from '../core/renderer3d';
import { isScene3D } from '../protocol/scene3d';
import type { Scene3D } from '../protocol/scene3d';
import type { Scene, StepDef } from '../protocol/scene';
import { buildNarration, fallbackNarration } from '../llm/narration';
import type { Narration } from '../llm/narration';
import { compileTimeline, sampleBeat } from './timeline';
import type { Timeline, TurnCue } from './timeline';
import { isBoardScene } from '../core/visualMode';
import { buildAnnotations3D, pickAnnotations3D } from '../core/annotations3d';
import type { AnnotationMark3D } from '../core/annotations3d';
import { escapeHtml, plainText, renderMathText } from './mathText';

type AnyScene = Scene | Scene3D;

/**
 * 视频用的视野：在原 view 外各扩一圈。
 *
 * 原 view 是照着"只画几何图形"定的，边常常正好压在画面边界上。
 * 视频要往边上写度数、长度、字母，不留余量就会被裁掉。
 * 只影响视频画布，主画布用的是原始 scene，一点没变。
 */
function videoView(scene: Scene): Scene['view'] {
  const v = scene.view;
  const mx = (v.xMax - v.xMin) * 0.08;
  const my = (v.yMax - v.yMin) * 0.1;
  return {
    xMin: v.xMin - mx,
    xMax: v.xMax + mx,
    yMin: v.yMin - my,
    yMax: v.yMax + my,
  };
}

export interface VideoStudioHandle {
  /** 打开工作台并装载一个场景（含 steps 时可播放，否则给出提示） */
  open(
    scene: AnyScene,
    params: Record<string, number>,
    title: string,
    /** 题目原文（可选）：播放时作为开场卡片展示 */
    problem?: string,
  ): void;
  /** 工作台当前是否打开 */
  isOpen(): boolean;
  /** 讲稿是否已生成（生成过才有「按句跳转」这回事） */
  hasNarration(): boolean;
  /**
   * 讲稿句子（答疑上下文用）。视频里的「步骤」就是讲稿的一句话，
   * 学生在第 5 句暂停问"这句什么意思"，模型看到的应该就是第 5 句。
   * 还没生成过讲稿返回 null——此时答疑退回主画布的解题步骤。
   */
  narrationSteps(): Array<{ title: string; text: string }> | null;
  /** 当前句下标（0 起） */
  currentCue(): number;
  /** 暂停并跳到第 n 句（n 从 1 起，来自答疑联动指令） */
  jumpToCue(n: number): void;
  /** 在视频自己的渲染器上做 / 撤销高亮（答疑 focus 联动），不碰主画布 */
  applyFocus(ids: string[], undo: boolean): void;
  /** 正在播放就暂停（打开学习面板时调用，别让讲解自己往下走） */
  pauseIfPlaying(): void;
  /** 视频画布：学习面板搬进来时的宿主 */
  panelHost(): HTMLElement;
}

export interface VideoStudioOpts {
  /** 工作台关闭后回调（学习面板要搬回主画布） */
  onClose?: () => void;
  /**
   * Esc 分层退出：返回 true 表示这一层已经处理了 Esc（比如先收起聊天面板），
   * 工作台就不再往下关。不加这层，Esc 一步关掉整个视频，播放位置直接丢失。
   */
  escLayer?: () => boolean;
}

/** 公式渲染、纯文本化统一走 ui/mathText：板书乱码的清洗规则只维护一份 */

/**
 * 底部提示只显示一句话的开头：
 * 整句字幕横在画面下方，眼睛就会一直读字幕而不是看图——
 * 那正是"像 PPT"的另一个原因。细节交给语音和板书。
 */
function shortSay(say: string, max = 34): string {
  const t = say.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const m = /[，。；：,;:]/.exec(cut);
  return (m ? cut.slice(0, m.index) : cut) + '…';
}

/** 开场/收尾卡片停留时长（毫秒）——可被"跳过"按钮提前结束 */
const CARD_MS = 3000;
/**
 * 句与句之间的"呼吸"（毫秒）。
 * 新版里每句自己还有 hold（结论句 900ms），这里只留一点点空隙，
 * 否则"动作演完 → 等 600ms → 才说下一句"会显得拖沓。
 */
const BEAT_GAP_MS = 220;
/**
 * 立体场景的自转周期（秒/圈）。
 * 视频画布不做运镜，立体感只能靠这一点慢转来交代。
 */
const AUTO_ROTATE_SECONDS = 40;
/** 立体图入场构建的兜底时长（找不到第一小步时用）：1.6 秒画完 12 条棱 + 顶点 + 面 + 截面 */
const BUILD_MS = 1600;
/** 入场构建摊到"第一小步"时的上下限——太短看不清过程，太长会拖住讲解 */
const BUILD_MIN_MS = 2400;
const BUILD_MAX_MS = 6500;
/** 讲到某句才出现的对象：用这个时长"长"出来，不要硬切换 */
const REVEAL_MS = 320;

export function mountVideoStudio(opts: VideoStudioOpts = {}): VideoStudioHandle {
  const root = document.getElementById('video-studio') as HTMLElement;
  buildDom(root);

  // ---- DOM 引用 ----
  const stage = root.querySelector('#vs-stage') as HTMLElement;
  const host2d = root.querySelector('#vs-host-2d') as HTMLElement;
  const host3d = root.querySelector('#vs-host-3d') as HTMLElement;
  const titleEl = root.querySelector('#vs-title') as HTMLElement;
  const problemEl = root.querySelector('#vs-problem') as HTMLElement;
  const subEl = root.querySelector('#vs-sub') as HTMLElement;
  const subTitleEl = root.querySelector('#vs-sub-title') as HTMLElement;
  const subTextEl = root.querySelector('#vs-sub-text') as HTMLElement;
  const posEl = root.querySelector('#vs-pos') as HTMLElement;
  const barEl = root.querySelector('#vs-bar') as HTMLElement;
  const hintEl = root.querySelector('#vs-hint') as HTMLElement;
  const prevBtn = root.querySelector('#vs-prev') as HTMLButtonElement;
  const playBtn = root.querySelector('#vs-play') as HTMLButtonElement;
  const nextBtn = root.querySelector('#vs-next') as HTMLButtonElement;
  const closeBtn = root.querySelector('#vs-close') as HTMLButtonElement;
  const fsBtn = root.querySelector('#vs-fs') as HTMLButtonElement;
  const speedSel = root.querySelector('#vs-speed') as HTMLSelectElement;
  const voiceChk = root.querySelector('#vs-voice') as HTMLInputElement;
  const cardEl = root.querySelector('#vs-card') as HTMLElement;
  const cardLabelEl = root.querySelector('#vs-card-label') as HTMLElement;
  const cardTitleEl = root.querySelector('#vs-card-title') as HTMLElement;
  const cardBodyEl = root.querySelector('#vs-card-body') as HTMLElement;
  const cardSkipBtn = root.querySelector('#vs-card-skip') as HTMLButtonElement;
  const knownsEl = root.querySelector('#vs-knowns') as HTMLElement;
  const boardEl = root.querySelector('#vs-board') as HTMLElement;
  const boardBodyEl = root.querySelector('#vs-board-body') as HTMLElement;
  const modeNoteEl = root.querySelector('#vs-mode-note') as HTMLElement;
  /** 场景被判成"没有图形"时的自救入口：先把图叫出来看一眼 */
  const peekBtn = root.querySelector('#vs-peek') as HTMLButtonElement;

  // ---- 播放器状态 ----
  let scene2d: Scene | null = null;
  let scene3d: Scene3D | null = null;
  let space: '2d' | '3d' = '2d';
  let vsParams: Record<string, number> = {};
  let steps: StepDef[] = [];
  /**
   * 3D 标注全集：打开场景时从 constraints 一次性推算好（annotations3d.ts），
   * 每句只做挑选（pickAnnotations3D），不重复计算几何。
   */
  let ann3dAll: AnnotationMark3D[] = [];
  /** 当前场景本体——生成讲稿要用它（对象清单、原生 steps 都在里面） */
  let currentScene: AnyScene | null = null;
  /** 讲稿。null = 还没生成（点播放时才生成，光打开不花钱） */
  let narration: Narration | null = null;
  /** 编译好的时间轴（讲稿一变就重编） */
  let tl: Timeline | null = null;
  /** 当前句下标 */
  let cueIdx = 0;
  /** 会被"渐进揭示"拦下来的对象全集 */
  let progressiveAll = new Set<string>();
  let playing = false;
  let closed = true;
  let problemText = '';
  let finishedAll = false;
  /**
   * 板书模式：本题没有可对应的图形（纯代数/不等式/参数范围），
   * 或者讲稿里一个动作都落不到图上。这时不显示画布，整块舞台就是推导板。
   */
  let boardMode = false;
  /** 推导板被临时切成图形（用户点了「仍要看图」） */
  let peekFigure = false;
  /** 因为"讲稿与图对不上"自动切的板书模式，需要给用户一句说明 */

  /** 板书已经显示到第几行（避免每帧重建 DOM） */
  let boardShown = -1;
  let boardActiveShown = false;
  /** 当前底部提示的动作标签，变了才改 DOM */
  let captionLabel = '';
  /** 逐帧动画的 rAF 句柄 */
  let animRaf = 0;
  /**
   * 已经触发过的转向（key = 第几句第几个动作）。
   * 转向不是"每帧的状态"，而是"发生一次的事件"——不去重的话，
   * 一句话里每个动画帧都会重新开始补间，镜头会一直卡在起步的那一下。
   */
  let viewFired = new Set<string>();

  // ---- 3D 入场构建动画 ----
  //
  // 2D 视频靠讲稿动作逐帧画线；3D 没有动作系统，以前是整张图一开场就杵在那儿，
  // 和 2D 的"一笔一笔写上去"完全两种观感。这里补一层纯渲染侧的构建动画：
  // 棱逐条生长 → 点浮现 → 面淡入 → 截面最后描出，之后讲到某句才出现的对象
  // （辅助线、交点）在那句再长出来。
  // 主画布不受影响：这套开关只在视频里打开。
  let buildItems: Array<{ id: string; from: number; to: number; grow: boolean }> = [];
  let buildRaf = 0;
  let buildDone = true;
  /** 这一场是否已经画过一次：停在第一句暂停再播放，不该从空白重画 */
  let builtIn = false;
  /** 上一句已经"出场"的对象，用来判断这一句新长出来的是哪些 */
  let lastRevealed = new Set<string>();

  /**
   * 播放令牌：每次播放/暂停都 +1。
   * 所有等待都会检查它——令牌一变，上一轮播放流程立即作废，
   * 这样"暂停 / 切场景 / 重播"不会留下后台定时器继续推进。
   */
  let playToken = 0;
  let cardResolve: (() => void) | null = null;
  let fullscreen = false;

  // ---- 渲染器（懒创建：第一次打开才建，隐藏时不占资源）----
  let r2d: SceneRenderer | null = null;
  let r3d: Scene3DRenderer | null = null;

  function ensureRenderers() {
    if (!r2d) {
      r2d = new SceneRenderer(host2d);
      // 视频画布：镜头完全静止。重点靠"高亮 + 逐帧动作"表达，不靠相机去找。
      r2d.stepFlyEnabled = false;
      r2d.accentHighlight = true;
    }
    if (!r3d) {
      r3d = new Scene3DRenderer(host3d);
      r3d.stepFlyEnabled = false;
      r3d.accentHighlight = true;
      r3d.autoRotateSeconds = AUTO_ROTATE_SECONDS;
      r3d.frameScale = 0.82;
    }
  }

  function showSpace(s: '2d' | '3d') {
    if (boardMode) {
      host2d.style.display = 'none';
      host3d.style.display = 'none';
      return;
    }
    host2d.style.display = s === '2d' ? '' : 'none';
    host3d.style.display = s === '3d' ? '' : 'none';
  }

  /**
   * 切到 / 退出板书模式。
   *
   * 板书模式把整块舞台让给推导板：不画图、没有右侧栏、字号放大。
   * 用于两种场景：①场景自己声明没有图形；②讲稿的动作一个都落不到图上
   * （图是死的、话在讲别的——这正是"讲的内容和图像对不上"的根因）。
   */
  function setStageBoardMode(on: boolean) {
    if (boardMode === on) return;
    boardMode = on;
    stage.classList.toggle('vs-boardmode', on);
    showSpace(space);
    window.dispatchEvent(new Event('resize'));
  }

  /**
   * 推导板 ↔ 图形 的临时切换。
   *
   * 只对"场景声明没有图形、但确实画了对象"的题开放。模型偶尔会把有图的题
   * 判成 board（比如把"看图求角"当成纯代数）——这时人应该能自己把图叫出来
   * 看一眼，而不是重跑一次生成。不自动翻案：参数族那类题确实不该出图。
   */
  function setPeekFigure(on: boolean) {
    const s = currentScene;
    if (!s || isScene3D(s) || !isBoardScene(s) || s.objects.length === 0) return;
    peekFigure = on;
    peekBtn.textContent = on ? '回推导板' : '仍要看图';
    setStageBoardMode(!on);

    if (on) {
      ensureRenderers();
      if (scene2d) {
        r2d!.clearOverlay();
        r2d!.overlayTextScale = 1.35;
        r2d!.dimFactor = 0.6;
        r2d!.setScene({ ...scene2d, view: videoView(scene2d) }, vsParams);
      }
      // 角上的"没有图形"说明已经不成立了，换成讲稿自检的结果（如果有）
      modeNoteEl.hidden = true;
      modeNoteEl.title = '';
      if (narration) showNarrationIssues(narration);
    } else {
      modeNoteEl.textContent = '本题没有可对应的图形，已切换为推导模式';
      modeNoteEl.title = '';
      modeNoteEl.hidden = false;
    }

    buildTimeline(narration ?? fallbackNarration(s));
    applyBeatStatic(cueIdx, true);
    window.dispatchEvent(new Event('resize'));
  }

  peekBtn.addEventListener('click', () => setPeekFigure(!peekFigure));

  /** 讲稿里"真正有动作"的句子占比——低于三分之一说明图基本没被用起来 */
  function actionCoverage(n: Narration): number {
    let total = 0;
    let withAction = 0;
    for (const st of n.steps) {
      for (const b of st.beats) {
        total += 1;
        if (b.actions.some((a) => a.kind !== 'board')) withAction += 1;
      }
    }
    return total === 0 ? 0 : withAction / total;
  }

  /**
   * 讲稿自检结果：动作没落到图上时，在角上说清"第几句、为什么"，悬停看明细。
   *
   * 这里**只提示，不改变画面**。上一版的处理是"动作覆盖率低 → 整屏切板书"，
   * 结果是图被整个抽走，用户只看到文字，连"图和话到底对不对得上"都没法判断。
   * 图留在原地就是这一句的画面：讲推导时它静止，讲几何时它动。
   * 真正需要整屏板书的只有一种情况——场景自己声明了 visual:"board"。
   */
  function showNarrationIssues(n: Narration) {
    const issues = n.issues ?? [];
    if (issues.length > 0) {
      const first = issues[0];
      const more = issues.length > 1 ? ` 等 ${issues.length} 处` : '';
      modeNoteEl.textContent = `第 ${first.step + 1} 步第 ${first.beat + 1} 句的动作没画出来（${first.why}）${more}`;
      modeNoteEl.title = issues
        .map((x) => `第 ${x.step + 1} 步第 ${x.beat + 1} 句 · ${x.kind} · ${x.detail}\n  → ${x.why}`)
        .join('\n');
      modeNoteEl.hidden = false;
      return;
    }
    // 模型一句动作都没写：不删图，但说明一句，免得以为画面卡住了
    // （3D 场景一直在慢转，"保持不动"不成立，所以这条只对平面场景说）
    if (space === '2d' && actionCoverage(n) < 0.34) {
      modeNoteEl.textContent = '本段以推导为主，图形保持不动';
      modeNoteEl.title = '';
      modeNoteEl.hidden = false;
      return;
    }
    modeNoteEl.hidden = true;
    modeNoteEl.title = '';
  }

  // ---------------------------------------------------------------
  // 全屏沉浸
  // ---------------------------------------------------------------
  function enterFullscreen() {
    if (fullscreen) return;
    fullscreen = true;
    root.classList.add('vs-fullscreen');
    document.body.classList.add('vs-fs-lock');
    fsBtn.textContent = '⤡ 退出全屏';
    fitStage();
    window.setTimeout(() => {
      fitStage();
      window.dispatchEvent(new Event('resize'));
    }, 80);
  }

  function exitFullscreen() {
    if (!fullscreen) return;
    fullscreen = false;
    root.classList.remove('vs-fullscreen');
    document.body.classList.remove('vs-fs-lock');
    fsBtn.textContent = '⛶ 全屏';
    stage.style.width = '';
    stage.style.height = '';
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 80);
  }

  /**
   * 全屏时把 16:9 画布按窗口大小等比放大并居中（四周自然留黑边）
   *
   * 注意这里必须防重入：函数末尾要派发 resize 通知渲染器重新量尺寸，
   * 而 resize 监听器又会调回 fitStage —— 不拦就会「fitStage → resize →
   * fitStage → ...」一路递归到栈溢出（报 Maximum call stack size exceeded）。
   */
  let fitting = false;
  function fitStage() {
    if (!fullscreen || fitting) return;
    const wrap = stage.parentElement as HTMLElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w <= 0 || h <= 0) return;
    const s = Math.min(w / 16, h / 9);
    const nextW = `${Math.floor(s * 16)}px`;
    const nextH = `${Math.floor(s * 9)}px`;
    if (stage.style.width === nextW && stage.style.height === nextH) return;
    fitting = true;
    try {
      stage.style.width = nextW;
      stage.style.height = nextH;
      window.dispatchEvent(new Event('resize'));
    } finally {
      fitting = false;
    }
  }

  window.addEventListener('resize', () => {
    if (fullscreen) fitStage();
  });

  // ---- TTS（浏览器自带语音合成，零成本）----
  function voiceOn(): boolean {
    return voiceChk.checked && 'speechSynthesis' in window;
  }

  function speak(text: string) {
    stopSpeak();
    if (!voiceOn()) return;
    const u = new SpeechSynthesisUtterance(plainText(text));
    u.lang = 'zh-CN';
    u.rate = Number(speedSel.value);
    const zh = speechSynthesis
      .getVoices()
      .find((v) => v.lang.toLowerCase().startsWith('zh'));
    if (zh) u.voice = zh;
    speechSynthesis.speak(u);
  }

  function stopSpeak() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  // ---- 可取消的等待 ----
  function delay(ms: number, token: number): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      const check = () => {
        if (token !== playToken || performance.now() - start >= ms) {
          resolve();
          return;
        }
        window.setTimeout(check, 80);
      };
      window.setTimeout(check, Math.min(ms, 80));
    });
  }

  /** 等这一句朗读完；不开语音时按字数估时长。语音比动画长就以语音为准。 */
  async function waitBeat(text: string, token: number) {
    const chars = plainText(text).length;
    const est = Math.min(11000, Math.max(1800, chars * 175)) / Number(speedSel.value);
    if (!voiceOn()) {
      await delay(est, token);
      return;
    }
    const began = performance.now();
    while (token === playToken) {
      await delay(120, token);
      if (token !== playToken) return;
      if (performance.now() - began < 700) continue;
      if (!speechSynthesis.speaking && !speechSynthesis.pending) return;
      if (performance.now() - began > est + 7000) return;
    }
  }

  // ---------------------------------------------------------------
  // 时间轴
  // ---------------------------------------------------------------

  /**
   * 由讲稿编译时间轴。
   *
   * 线宽按"视野跨度"折算而不是按像素：画布大小会随窗口和全屏变化，
   * 用世界单位相对视野定宽，图放大缩小时线粗才不会跟着变。
   */
  function buildTimeline(n: Narration) {
    const view = scene2d ? videoView(scene2d) : null;
    const span = view
      ? Math.max(view.xMax - view.xMin, view.yMax - view.yMin)
      : 10;
    tl = compileTimeline(n, scene2d, vsParams, {
      lineWidth: span / 300,
      helperWidth: span / 150,
      boardMode,
      // 立体题的折起起点：由渲染器按"往哪一边摊"算好（±deg），
      // 时间轴据此把"折到哪了"编进每一句
      foldFrom: r3d?.foldFlatOffset(),
    });

    progressiveAll = new Set<string>();
    for (const s of steps) for (const id of s.reveal ?? []) progressiveAll.add(id);
    for (const b of tl.beats) for (const id of b.reveal ?? []) progressiveAll.add(id);
  }

  /** 到第 upto 句为止已经"长出来"的场景对象（含跨步时该步原生的 reveal） */
  function computeRevealed(upto: number): string[] {
    if (!tl) return [];
    const set = new Set<string>();
    let lastStep = -1;
    for (let i = 0; i <= upto && i < tl.beats.length; i++) {
      const b = tl.beats[i];
      if (b.step !== lastStep) {
        for (const id of steps[b.step]?.reveal ?? []) set.add(id);
        lastStep = b.step;
      }
      for (const id of b.reveal ?? []) set.add(id);
    }
    return [...set];
  }

  /**
   * 高亮 id → 涉及的顶点 id。
   *
   * 为什么需要这层翻译：视频的高亮集合说的是**对象**（棱 AB、面 fTop、球 ballOut），
   * 而标注挂在**顶点**上（∠BAC 的弧认的是 A、B、C）。棱拆成两端、面拆成全部顶点，
   * 挑标注（pickAnnotations3D）才能对上号。认不出的 id 原样保留——
   * 万一它本来就是顶点 id（如 'O'），不该被丢掉。
   */
  function focusPointIds(scene: Scene3D, ids: string[]): string[] {
    if (ids.length === 0) return [];
    const byId = new Map(scene.objects.map((o) => [o.id, o]));
    const out = new Set<string>();
    for (const id of ids) {
      const o = byId.get(id);
      if (!o) {
        out.add(id);
        continue;
      }
      if (o.type === 'point3') out.add(o.id);
      else if (o.type === 'edge3') {
        out.add(o.a);
        out.add(o.b);
      } else if (o.type === 'face3') {
        for (const p of o.points) out.add(p);
      }
      // 旋转体/截面没有固定顶点集，标注不会挂在它们身上，跳过
    }
    return [...out];
  }

  /**
   * 立体图的出场顺序：棱 → 点 → 面/曲面 → 截面。
   *
   * 为什么按这个顺序？因为它就是手画立体图的顺序：先搭框架，再标顶点，
   * 再涂面，最后画截面。同类内部按场景里的声明顺序错峰，相邻两个台阶重叠一半，
   * 看起来是"一直在画"，而不是一个一个往外蹦。
   */
  function makeBuildPlan(s: Scene3D): typeof buildItems {
    const groups: Array<{ kinds: string[]; from: number; to: number; grow: boolean }> = [
      { kinds: ['edge3'], from: 0, to: 0.42, grow: true },
      { kinds: ['point3'], from: 0.18, to: 0.58, grow: false },
      { kinds: ['face3', 'cylinder3', 'cone3', 'sphere3'], from: 0.46, to: 0.8, grow: false },
      { kinds: ['section3'], from: 0.72, to: 1, grow: true },
    ];
    const items: typeof buildItems = [];
    for (const g of groups) {
      const ids = s.objects.filter((o) => g.kinds.includes(o.type)).map((o) => o.id);
      const n = Math.max(1, ids.length);
      const span = g.to - g.from;
      const win = Math.min(span, (span / n) * 2);
      ids.forEach((id, i) => {
        const start = g.from + (span * i) / n;
        items.push({ id, from: start, to: Math.min(g.to, start + win), grow: g.grow });
      });
    }
    return items;
  }

  /** 缓出：起笔快、收笔慢，像真的在画线 */
  const easeBuild = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

  /** 把总进度 p（0~1）换算成每个对象的 {alpha, grow}；only 用于"只让这几个长" */
  function buildEntriesAt(p: number, only?: Set<string>) {
    const out: Array<{ id: string; alpha: number; grow: number }> = [];
    for (const it of buildItems) {
      if (only && !only.has(it.id)) continue;
      const k = easeBuild((p - it.from) / Math.max(1e-6, it.to - it.from));
      out.push({ id: it.id, alpha: k, grow: it.grow ? k : 1 });
    }
    return out;
  }

  /**
   * 入场构建要花多久：摊到"第一小步"的全部句子。
   *
   * 固定 1.6 秒的问题不是太慢，而是**太短没感觉**——立体图刚起笔就画完了，
   * 观感还是"一下就出现"。跟着第一小步走（讲"作图/已知"那几句），
   * 就能做到边讲边搭框架；夹在 [2.4s, 6.5s] 之间，免得短题一闪而过、
   * 长题把讲解拖住。
   */
  function firstStepBuildMs(): number {
    if (!tl || tl.beats.length === 0) return BUILD_MS;
    let sum = 0;
    for (const b of tl.beats) if (b.step === 0) sum += b.duration;
    if (!sum) return BUILD_MS;
    return Math.max(BUILD_MIN_MS, Math.min(BUILD_MAX_MS, sum));
  }

  /** 开播时把立体图从头画出来（ms = 画完要多久） */
  function startBuildIn(ms = BUILD_MS) {
    if (!r3d || !scene3d) return;
    cancelAnimationFrame(buildRaf);
    buildItems = makeBuildPlan(scene3d);
    r3d.setBuildEnabled(true);
    buildDone = false;
    lastRevealed = new Set();
    r3d.setBuildProgress(buildEntriesAt(0));
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / Math.max(1, ms));
      r3d?.setBuildProgress(buildEntriesAt(p));
      if (p < 1) buildRaf = requestAnimationFrame(step);
      else buildDone = true;
    };
    buildRaf = requestAnimationFrame(step);
  }

  /** 某一句新出现的对象：短促地长出来，而不是"啪"一下出现 */
  function animateReveal(ids: string[]) {
    if (!r3d || ids.length === 0) return;
    const only = new Set(ids);
    if (!buildItems.some((it) => only.has(it.id))) return;
    cancelAnimationFrame(buildRaf);
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / REVEAL_MS);
      r3d?.setBuildProgress(buildEntriesAt(p, only));
      if (p < 1) buildRaf = requestAnimationFrame(step);
    };
    buildRaf = requestAnimationFrame(step);
  }

  function renderChrome() {    const total = tl?.beats.length ?? 0;
    posEl.textContent = total ? `${cueIdx + 1} / ${total}` : '';
    barEl.style.width = total ? `${((cueIdx + 1) / total) * 100}%` : '0%';
    prevBtn.disabled = playing || cueIdx === 0;
    nextBtn.disabled = playing || cueIdx === total - 1;
  }

  /** 已知条件清单：讲到哪条哪条变亮 */
  function renderKnowns(active?: number) {
    if (!narration || narration.knowns.length === 0) {
      knownsEl.hidden = true;
      return;
    }
    knownsEl.hidden = false;
    knownsEl.innerHTML = narration.knowns
      .map((k, i) => {
        const on = i === active ? ' on' : '';
        return `<div class="vs-known${on}">${escapeHtml(k)}</div>`;
      })
      .join('');
  }

  /**
   * 板书：只在"行数变了"的时候动 DOM，而且是**追加**而不是重建。
   *
   * 每帧重建的话，KaTeX 一秒要渲染几十次，页面会卡成幻灯片；
   * 每次重建整块板书的话，所有行都会重新播一遍淡入动画，看起来像在闪。
   * 所以：行数增加就 append 新增的几行，行数减少（点上一句倒回去）才重建。
   */
  function renderBoard(count: number, active: boolean) {
    if (!tl) return;
    if (count === boardShown && active === boardActiveShown) return;

    boardEl.hidden = tl.boardLines.length === 0;
    const wantBoard = tl.boardLines.length > 0;
    // 板书栏出现/消失会改变画布宽度：必须让渲染器重新量一次，
    // 否则画布还按旧尺寸渲染，图形被拉扁（这个 bug 在第一次实测里很明显）
    if (wantBoard !== stage.classList.contains('has-board')) {
      stage.classList.toggle('has-board', wantBoard);
      window.dispatchEvent(new Event('resize'));
    }

    const grew = count > boardShown && boardShown >= 0;
    if (count !== boardShown && grew) {
      // 只追加新增的那些行
      for (let i = boardShown; i < count; i++) {
        const l = tl.boardLines[i];
        const div = document.createElement('div');
        div.className =
          'vs-board-line' +
          (l.accent ? ' key' : '') +
          (l.heading ? ' heading' : '');
        div.innerHTML = renderMathText(l.text);
        boardBodyEl.appendChild(div);
      }
    } else if (count !== boardShown) {
      boardBodyEl.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const l = tl.boardLines[i];
        const div = document.createElement('div');
        div.className =
          'vs-board-line' +
          (l.accent ? ' key' : '') +
          (l.heading ? ' heading' : '');
        div.innerHTML = renderMathText(l.text);
        boardBodyEl.appendChild(div);
      }
    }

    // 当前行高亮：只在状态真的变了时改 class，避免每帧碰 DOM
    if (active !== boardActiveShown) {
      const lines = boardBodyEl.children;
      for (let i = 0; i < lines.length; i++) {
        lines[i].classList.toggle('on', active && i === lines.length - 1);
      }
    }

    boardShown = count;
    boardActiveShown = active;
    // 板书模式下滚动发生在 #vs-board 这一层（内容居中时 body 自己不再滚）
    const scrollHost: HTMLElement = boardMode ? boardEl : boardBodyEl;
    scrollHost.scrollTop = scrollHost.scrollHeight;
  }

  /**
   * 扫参：把滑杆推到这一帧的值。
   *
   * 走的是主画布拖滑杆的同一条路径（setParam → 重建对象），
   * 所以"图会跟着变"这件事不需要另写一套渲染逻辑。
   * 变化小于 0.005 就跳过——多数帧其实没有可感知的位移，
   * 白白重建图形只会掉帧。
   */
  function applyParam(p: { name: string; value: number }) {
    const cur = vsParams[p.name];
    if (cur !== undefined && Math.abs(cur - p.value) < 0.005) return;
    vsParams[p.name] = p.value;
    r2d?.setParam(p.name, p.value);
  }

  /** 场景参数的默认值（重播时把滑杆复位，避免上一遍扫到的位置残留） */
  function defaultParams(s: Scene): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of s.params) out[p.name] = p.value;
    return out;
  }

  /** 把某一帧落到画面上：覆盖图形 + 板书 + 提示 */
  function applyFrame(i: number, t: number) {
    if (!tl) return;
    const frame = sampleBeat(tl, i, t);
    if (!boardMode && space === '2d') {
      r2d?.setOverlay(frame.overlay);
      if (frame.param) applyParam(frame.param);
    }
    if (!boardMode && space === '3d') {
      // 折起：纯数值，每帧照着设就行（和 2D 的扫参同一个路子）
      if (frame.fold !== undefined) r3d?.setFoldOffset(frame.fold);
      // 转向：一次性动作，到点只转一次——key 是"第几句第几个动作"，
      // 每帧重算不会重复触发
      for (const cue of frame.turns) {
        if (t < cue.at || viewFired.has(cue.key)) continue;
        viewFired.add(cue.key);
        turnTo(cue, cue.dur);
      }
    }
    renderBoard(frame.boardCount, frame.boardActive);
    if (frame.label && frame.label !== captionLabel) {
      captionLabel = frame.label;
      subTitleEl.textContent = frame.label;
    }
  }

  /**
   * 真的把镜头转过去。
   *
   * 转过去的同时**关掉自动慢转**：自动转的用处是让静止的画面上有立体感，
   * 可一旦讲到"看底面"，镜头还在自己转，三秒之后就转到背面去了，
   * 讲的话和画面又对不上。所以宁可后半段变成静态图。
   */
  function turnTo(cue: TurnCue, dur: number) {
    if (!r3d) return;
    r3d.autoRotateSeconds = 0;
    if (cue.face) {
      if (r3d.turnToFace(cue.face, dur)) return;
      // 面不存在（模型编的 id）就退化成"不动"，别把人转到奇怪的地方
      return;
    }
    const az = cue.azimuth ?? r3d.currentAzimuth();
    const el = cue.elevation ?? r3d.currentElevation();
    r3d.turnTo(az, el, dur);
  }

  /**
   * 切到某一句的"静态状态"：高亮、字幕、条件卡一次刷到位，
   * 图形给这一句演完的样子（手动翻句时看到的是完整结果，不是半截）。
   */
  function applyBeatStatic(i: number, atEnd: boolean) {
    if (!tl || tl.beats.length === 0) return;
    const idx = Math.max(0, Math.min(i, tl.beats.length - 1));
    cueIdx = idx;
    const beat = tl.beats[idx];
    const step = steps[beat.step];

    // 本句焦点：动作指向的对象；没有任何动作就用整步 highlight 兜底
    const focus = beat.focus.length > 0 ? beat.focus : (step?.highlight ?? []);
    const revealed = computeRevealed(idx);
    const progressive = [...progressiveAll];

    if (!boardMode) {
      if (space === '3d') r3d?.applyFocus(focus, revealed, progressive);
      else r2d?.applyFocus(focus, revealed, progressive);
      // 3D 标注只在本句显示：按本句重点挑（挑不中就是空数组 = 清空）。
      // 高亮是对象 id，先翻译成顶点 id 再匹配。
      //
      // 摊平状态下一条标注都不给：标注是按**折好之后**的坐标算的，
      // 图还摊着的时候画上去，弧线和数字会飘在半空（折起那句尤其明显）。
      // 折好之后（fold 归零）再恢复，坐标就和图对上了。
      const foldAt = atEnd ? beat.foldEnd : beat.foldStart;
      if (space === '3d' && scene3d) {
        r3d?.setAnnotations3D(
          foldAt !== 0 ? [] : pickAnnotations3D(ann3dAll, focusPointIds(scene3d, focus)),
        );
      }
      // 折起：跳到某一句时直接落到这句该有的角度（不演过程，演过程是播放时的事）
      if (space === '3d' && (beat.foldStart !== 0 || beat.foldEnd !== 0)) {
        r3d?.setFoldOffset(atEnd ? beat.foldEnd : beat.foldStart);
      }
      // 转向：翻句时要让镜头落到"这句讲的那个视角"，否则翻到"看底面"那句，
      // 画面还是上一句的斜视角，话和图对不上。
      // 只在**手动翻句**时这么干；正常播放时交给时间轴按动作的时刻转（见 applyFrame）。
      if (space === '3d' && atEnd) {
        const lastView = [...beat.actions].reverse().find((c) => c.action.kind === 'view');
        if (lastView && lastView.action.kind === 'view') {
          viewFired.add(lastView.key);
          const v = lastView.action;
          if (v.face) r3d?.turnToFace(v.face, 260);
          else {
            r3d?.turnTo(
              v.azimuth ?? r3d.currentAzimuth(),
              v.elevation ?? r3d.currentElevation(),
              260,
            );
          }
          // 手动翻到"看某个面"的句子，之后的自动慢转也该停：否则刚转正又飘走
          if (r3d) r3d.autoRotateSeconds = 0;
        }
      }
    }

    // 立体图：这一句新出场的对象用 320ms 长出来。
    // 入场动画还没跑完时（buildDone=false）不插队，否则两段动画会互相打断。
    if (space === '3d') {
      const fresh = revealed.filter((id) => !lastRevealed.has(id));
      lastRevealed = new Set(revealed);
      if (buildDone) animateReveal(fresh);
    }

    captionLabel = beat.label;
    // 板书模式下步骤标题已经写在推导板上了，字幕再重复一遍是噪音
    subTitleEl.textContent = boardMode ? '' : beat.label || step?.title || '';
    // 板书模式没有图要看，字幕不必再压成一句——直接给完整的一句
    subTextEl.innerHTML = renderMathText(boardMode ? beat.say : shortSay(beat.say));
    renderKnowns(beat.known);
    renderChrome();

    if (atEnd) applyFrame(idx, beat.duration);
    else applyFrame(idx, 0);
  }

  // ---------------------------------------------------------------
  // 开场 / 收尾卡片
  // ---------------------------------------------------------------
  function showCard(
    label: string,
    title: string,
    body: string,
    token: number,
    ms: number,
  ): Promise<void> {
    cardLabelEl.textContent = label;
    cardTitleEl.textContent = title;
    cardBodyEl.innerHTML = body ? renderMathText(body) : '';
    cardEl.hidden = false;
    requestAnimationFrame(() => cardEl.classList.add('show'));
    return new Promise((resolve) => {
      let done = false;
      let timerId = 0;
      let guard = 0;
      const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timerId);
        window.clearInterval(guard);
        cardResolve = null;
        resolve();
      };
      cardResolve = finish;
      timerId = window.setTimeout(finish, ms);
      guard = window.setInterval(() => {
        if (token !== playToken) finish();
      }, 100);
    });
  }

  function hideCard() {
    cardEl.classList.remove('show');
    window.setTimeout(() => {
      if (!cardEl.classList.contains('show')) cardEl.hidden = true;
    }, 280);
  }

  // ---------------------------------------------------------------
  // 播放
  // ---------------------------------------------------------------

  /** 确保时间轴就绪（第一次点播放才生成讲稿，之后复用） */
  async function ensureNarration(token: number): Promise<boolean> {
    if (narration) return true;
    if (!currentScene) return false;
    hintEl.hidden = false;
    hintEl.textContent = '正在拆解讲解动作……（把解题步骤变成"边讲边画"，需要几秒）';
    const n = await buildNarration({
      problem: problemText,
      scene: currentScene,
      onProgress: (m) => {
        if (token === playToken) hintEl.textContent = m;
      },
    });
    if (token !== playToken) return false;
    narration = n;
    // 讲稿的动作落不到图上时，**不再把图拿掉**，只在角上说明原因。
    // （旧逻辑：覆盖率 < 34% 就整屏切板书 → 用户只看到文字、以为图没生成）
    if (n.fromModel && !boardMode) showNarrationIssues(n);
    buildTimeline(n);
    hintEl.hidden = true;
    return true;
  }

  /**
   * 逐帧演出第 i 句，时长到 beat.duration 为止。
   * 令牌变了立刻退出（暂停/切句），不会留下还在跑的 rAF。
   */
  function playBeatAnim(i: number, token: number): Promise<void> {
    return new Promise((resolve) => {
      if (!tl) {
        resolve();
        return;
      }
      const dur = tl.beats[i].duration;
      const t0 = performance.now();
      const tick = () => {
        if (token !== playToken) {
          resolve();
          return;
        }
        const t = performance.now() - t0;
        applyFrame(i, Math.min(t, dur));
        if (t >= dur) {
          resolve();
          return;
        }
        animRaf = requestAnimationFrame(tick);
      };
      animRaf = requestAnimationFrame(tick);
    });
  }

  async function play() {
    if (steps.length === 0) return;
    const stepBefore = tl?.beats[cueIdx]?.step ?? 0;
    const hadModel = !!narration;
    let startCue = cueIdx;
    if (finishedAll) {
      startCue = 0;
      finishedAll = false;
      // 重播：允许再画一遍，否则第二次看还是"一步到位"
      builtIn = false;
    }

    const token = ++playToken;
    playing = true;
    // 新一轮播放：转向事件表清空，这一遍该转的地方重新转
    viewFired.clear();
    if (space === '3d' && r3d) r3d.autoRotateSeconds = AUTO_ROTATE_SECONDS;
    playBtn.textContent = '⏸ 暂停';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    enterFullscreen();

    // ⓪ 备脚本：先把"每步做什么动作"拆出来，失败会降级不中断
    if (!(await ensureNarration(token))) return;
    if (token !== playToken) return;
    if (!tl || tl.beats.length === 0) return;
    if (!hadModel && startCue !== 0) {
      const same = tl.beats.findIndex((b) => b.step === stepBefore);
      startCue = same >= 0 ? same : 0;
    }
    if (startCue >= tl.beats.length) startCue = 0;
    cueIdx = startCue;

    // 从头播放时把参数复位：扫参动作会改滑杆，重播不能从上次的位置接着扫
    if (startCue === 0 && scene2d && !boardMode) {
      vsParams = defaultParams(scene2d);
      r2d?.setScene({ ...scene2d, view: videoView(scene2d) }, vsParams);
    }

    // ① 开场：先让人看清题目
    if (startCue === 0) {
      await showCard(
        '题目',
        titleEl.textContent || '准备开始',
        problemText || '我们一起来看这道题。',
        token,
        CARD_MS,
      );
      hideCard();
      if (token !== playToken) return;
    }

    // 题目卡刚落幕，就是"动手"的时机：立体图从空白一条条搭出来，
    // 和第一句讲解同时进行；时长摊到第一小步（见 firstStepBuildMs）。
    // 只有从头发播放才重画——从中间接着播时图该是完整状态。
    if (startCue === 0 && space === '3d' && !boardMode && !builtIn) {
      startBuildIn(firstStepBuildMs());
      builtIn = true;
    }

    // ② 一句一句讲：把动作演出来，同时朗读；
    //    动画和语音并行，谁长等谁（语音经常比动画长）
    for (let i = startCue; i < tl.beats.length; i++) {
      if (token !== playToken) return;
      const beat = tl.beats[i];

      subEl.classList.remove('show');
      await delay(160, token);
      if (token !== playToken) return;

      applyBeatStatic(i, false);
      subEl.classList.add('show');

      speak(beat.say);
      await Promise.all([playBeatAnim(i, token), waitBeat(beat.say, token)]);
      if (token !== playToken) return;

      await delay(beat.hold + BEAT_GAP_MS, token);
    }

    if (token !== playToken) return;

    // ③ 收尾：让最后一张"写满的图"多停一会儿
    const last = tl.beats[tl.beats.length - 1];
    await showCard(
      '讲解结束',
      steps[last.step]?.title ?? '',
      last.say,
      token,
      CARD_MS + 600,
    );
    hideCard();
    if (token !== playToken) return;

    playing = false;
    finishedAll = true;
    playBtn.textContent = '↻ 重播';
    renderChrome();
    subEl.classList.add('show');
  }

  function pause() {
    playToken += 1; // 作废当前播放流程
    playing = false;
    if (animRaf) {
      cancelAnimationFrame(animRaf);
      animRaf = 0;
    }
    stopSpeak();
    hideCard();
    playBtn.textContent = '▶ 播放';
    renderChrome();
  }

  // ---- 事件 ----
  playBtn.addEventListener('click', () => (playing ? pause() : void play()));
  prevBtn.addEventListener('click', () => {
    if (!tl) return;
    applyBeatStatic(cueIdx - 1, true);
    subEl.classList.add('show');
  });
  nextBtn.addEventListener('click', () => {
    if (!tl) return;
    applyBeatStatic(cueIdx + 1, true);
    subEl.classList.add('show');
  });
  fsBtn.addEventListener('click', () => {
    if (fullscreen) exitFullscreen();
    else enterFullscreen();
  });
  cardSkipBtn.addEventListener('click', () => cardResolve?.());
  speedSel.addEventListener('change', () => {
    if (playing && tl) {
      stopSpeak();
      speak(tl.beats[cueIdx]?.say ?? '');
    }
  });
  voiceChk.addEventListener('change', () => {
    if (!voiceChk.checked) stopSpeak();
  });
  closeBtn.addEventListener('click', () => {
    pause();
    exitFullscreen();
    closed = true;
    root.hidden = true;
    // 构建动画也要停：否则关掉面板后 rAF 还在跑，白白占着画布
    cancelAnimationFrame(buildRaf);
    buildDone = true;
    r2d?.clearFocus();
    r2d?.clearOverlay();
    r3d?.clearFocus();
    r3d?.setActive(false);
    // 学习面板还挂在视频层里，通知外面把它们搬回主画布
    opts.onClose?.();
  });
  document.addEventListener('keydown', (ev) => {
    if (closed || root.hidden) return;
    if (ev.key === 'Escape') {
      // 分层退出：先收面板，再退全屏，最后才关视频
      if (opts.escLayer?.()) return;
      if (fullscreen) exitFullscreen();
      else closeBtn.click();
      return;
    }
    const t = ev.target as HTMLElement | null;
    const typing =
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLButtonElement;
    if (ev.key === ' ' && !typing) {
      ev.preventDefault();
      if (playing) pause();
      else void play();
    }
  });

  // ---- 组装 DOM（只在 mount 时执行一次）----
  function buildDom(r: HTMLElement) {
    r.innerHTML = `
      <div class="vs-inner">
        <div class="vs-head">
          <span class="vs-badge">讲解视频</span>
          <h2 id="vs-title"></h2>
          <button class="btn" id="vs-close">✕ 关闭</button>
        </div>
        <div class="vs-stage-wrap">
          <div id="vs-problem" hidden></div>
          <div id="vs-stage">
            <div id="vs-host-2d"></div>
            <div id="vs-host-3d"></div>
            <!-- 右侧板书：推导一行行累加，像黑板的一角 -->
            <aside id="vs-board" hidden>
              <div class="vs-board-head">板书</div>
              <div id="vs-board-body"></div>
            </aside>
            <div id="vs-knowns" hidden></div>
            <div class="vs-subtitle" id="vs-sub">
              <div id="vs-sub-title"></div>
              <div id="vs-sub-text"></div>
            </div>
            <div id="vs-hint" hidden></div>
            <!-- 自动切到推导模式时给一句说明：别让人以为"图没渲染出来" -->
            <div id="vs-mode-note" hidden></div>
            <!-- 模型可能把有图的题判成推导题：留一个自己爬出来的按钮 -->
            <button class="btn vs-peek" id="vs-peek" hidden>仍要看图</button>
            <div class="vs-card" id="vs-card" hidden>
              <div class="vs-card-inner">
                <div class="vs-card-label" id="vs-card-label"></div>
                <div class="vs-card-title" id="vs-card-title"></div>
                <div class="vs-card-body" id="vs-card-body"></div>
                <button class="vs-card-skip" id="vs-card-skip">跳过 ›</button>
              </div>
            </div>
          </div>
        </div>
        <div class="vs-progress"><div id="vs-bar"></div></div>
        <div class="vs-controls">
          <button class="btn" id="vs-prev">上一句</button>
          <button class="btn primary" id="vs-play">▶ 播放</button>
          <button class="btn" id="vs-next">下一句</button>
          <span id="vs-pos" class="msg"></span>
          <span class="vs-spacer"></span>
          <button class="btn" id="vs-fs">⛶ 全屏</button>
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
        <p class="vs-note">点「播放」后先拆解讲解动作：每句话对应一个几何动作——作辅助线、标角、标长度，动手的过程会逐帧演出来，并且一直留在图上；右侧板书同步累加推导。空格播放/暂停，Esc 退出全屏。本画布独立于主画布，不影响原有操作。</p>
      </div>`;
  }

  return {
    open(scene, params, title, problem) {
      closed = false;
      root.hidden = false;
      titleEl.textContent = title;
      problemText = (problem ?? '').trim();
      if (problemText) {
        problemEl.textContent = problemText;
        problemEl.hidden = false;
      } else {
        problemEl.hidden = true;
      }
      vsParams = { ...params };
      steps = scene.steps ?? [];
      currentScene = scene;
      pause();
      finishedAll = false;
      builtIn = false;
      narration = null;
      cueIdx = 0;
      boardShown = -1;
      boardActiveShown = false;
      captionLabel = '';
      viewFired = new Set();
      boardEl.hidden = true;
      boardBodyEl.innerHTML = '';
      stage.classList.remove('has-board');

      if (isScene3D(scene)) {
        space = '3d';
        scene3d = scene;
        scene2d = null;
        // 标注全集只算这一次：派生点坐标已在 resolve3d 写回 at，params 在视频里不变
        ann3dAll = buildAnnotations3D(scene, vsParams);
      } else {
        space = '2d';
        scene2d = scene;
        scene3d = null;
        ann3dAll = [];
      }

      // 场景自己声明"没有图形"→ 视频也走推导板（与主画布一致）
      const wantBoard = !isScene3D(scene) && isBoardScene(scene);
      // 先复位到"非板书"：上一场如果是板书，画布被内联 display:none 隐藏过，
      // 不复位就会带着隐藏状态进到下一场的图形模式里
      setStageBoardMode(false);
      peekFigure = false;
      peekBtn.textContent = '仍要看图';
      modeNoteEl.hidden = true;
      modeNoteEl.textContent = '';
      modeNoteEl.title = '';
      setStageBoardMode(wantBoard);
      // 有图形对象才给"仍要看图"：一个对象都没有的题，点开也是空坐标轴
      peekBtn.hidden = !wantBoard || scene.objects.length === 0;
      if (wantBoard) {
        modeNoteEl.textContent = '本题没有可对应的图形，已切换为推导模式';
        modeNoteEl.hidden = false;
      }

      // 先用本地脚本垫一层：一打开就有第一句和板书，不必等模型。
      // 注意顺序：这一句必须在渲染器装好场景之后才编时间轴——
      // 折起的起点（往哪一边摊、多少度）是渲染器按实际坐标算出来的，
      // 提前编会拿到"没有翻折"，整段视频都不会折。
      // 所以真正的第一次编译放在下面 setScene 之后。

      // 先把对应维度的宿主显示出来，再创建渲染器——
      // 顺序反了的话渲染器会量到 display:none 的 0 尺寸，画面缩成一点
      showSpace(space);
      if (!boardMode) {
        ensureRenderers();
        if (space === '3d' && scene3d) {
          r3d!.setActive(true);
          // 立体图要"一直在"，不能被压到几乎透明
          r3d!.dimFactor = 0.55;
          r3d!.setScene(scene3d, vsParams);
          // 换一道题就把自转与转向状态复位：上一题讲到"看底面"时把自转关了，
          // 不恢复的话新题一打开就是死画面
          r3d!.autoRotateSeconds = AUTO_ROTATE_SECONDS;
          // 注意：入场构建不在这里启动。
          // 这个函数在你点「讲解视频」时就跑，而真正开讲还要等你点「播放」、
          // 再等模型拆解讲稿（几秒到十几秒）——动画在这里放，等于放在没人的时候，
          // 等画面出来时图早就画完了，观感就是"一步到位"。
          // 所以这里先给完整图（等待期间有东西可看），开播时再清空重画。
          r3d!.setBuildEnabled(false);
          buildDone = true;
          // 计划表也清空：换题后不能拿上一题的棱/点去驱动这一题
          buildItems = [];
        } else if (scene2d) {
          r2d!.clearOverlay();
          // 视频里字比主画布大一点：全屏观看时更清楚
          r2d!.overlayTextScale = 1.35;
          // 图是"写在黑板上"的，除了当前重点，其余保持可读（主画布仍是 0.25）
          r2d!.dimFactor = 0.6;
          r2d!.setScene({ ...scene2d, view: videoView(scene2d) }, vsParams);
        }
      }

      // 第一次编译时间轴：渲染器已就位，折起的起点能算准了
      buildTimeline(fallbackNarration(scene));

      root.scrollIntoView({ behavior: 'smooth', block: 'start' });

      if (steps.length === 0) {
        hintEl.hidden = false;
        hintEl.textContent =
          '本题没有分步讲解数据（steps 为空），无法生成视频。换一道带 steps 的题目试试。';
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
      playBtn.textContent = '▶ 播放';
      applyBeatStatic(0, true);
      subEl.classList.add('show');
    },
    isOpen: () => !closed && !root.hidden,
    hasNarration: () => !!tl && tl.beats.length > 0,
    narrationSteps: () =>
      tl && tl.beats.length > 0
        ? tl.beats.map((b, i) => ({ title: `视频第 ${i + 1} 句`, text: b.say }))
        : null,
    currentCue: () => cueIdx,
    jumpToCue(n: number) {
      if (!tl) return;
      // 联动跳句 = 先停（语音、rAF、开场卡全停），再落到目标句的完整状态
      pause();
      applyBeatStatic(n - 1, true);
      subEl.classList.add('show');
    },
    applyFocus(ids: string[], undo: boolean) {
      if (boardMode) return;
      if (undo) {
        r2d?.clearFocus();
        r3d?.clearFocus();
        return;
      }
      if (space === '3d') r3d?.applyFocus(ids, [], []);
      else r2d?.applyFocus(ids, [], []);
    },
    pauseIfPlaying: () => {
      if (playing) pause();
    },
    panelHost: () => stage,
  };
}
