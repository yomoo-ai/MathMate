/**
 * timeline.ts —— 把「动作脚本」编译成时间轴，并支持按时间采样
 *
 * ===== 为什么要单独一层 =====
 * 讲稿说的是"这句话里做什么动作"，播放器需要的是"此刻这一帧应该画到哪"。
 * 这两件事中间隔着一堆时间计算：动作什么时候开始、演多久、
 * 同一句里几个动作怎么错峰、板书第几毫秒落到黑板上。
 *
 * 把这层单独写出来，带来两个好处：
 *   ① 播放变成纯函数：sample(t) 给出画面，跟"上一帧发生过什么"无关。
 *      所以暂停后能精确续播、点上一句能回到准确状态，不会出现
 *      "跳过去以后辅助线还停在半路"这种脏状态。
 *   ② 以后要导出视频（逐帧渲染），直接喂不同的 t 就行，不用改逻辑。
 *
 * 时间单位统一用毫秒（相对这一句的开头），不依赖全局时钟——
 * 因为 TTS 长度不可预知，每句话都是"播完再进下一句"，
 * 只有句内动画需要精确计时。
 */
import type { Scene } from '../protocol/scene';
import type { Action } from '../core/action';
import {
  ACTION_MS,
  ACTION_STAGGER_MS,
  actionLabel,
  applyNewPoint,
  firstVisibleLabel,
  resolvePoints,
} from '../core/action';
import { actionShapes, centroidOf } from '../core/actionMarks';
import type { MarkContext } from '../core/actionMarks';
import type { OverlayShape } from '../core/renderer';
import type { Narration } from '../llm/narration';

/** 一个动作在句内的排期 */
export interface CompiledAction {
  action: Action;
  /** 相对本句开头的开始时间（毫秒） */
  start: number;
  /** 演出时长（毫秒） */
  dur: number;
  /** 覆盖层图形的 key 前缀（每帧复用同一几何体靠它） */
  key: string;
}

export interface CompiledBoardLine {
  text: string;
  accent: boolean;
  /** 相对本句开头的出现时间 */
  start: number;
  /** 步骤小标题（板书模式下用来分段，不是推导行） */
  heading?: boolean;
}

export interface CompiledBeat {
  /** 属于第几步 */
  step: number;
  say: string;
  actions: CompiledAction[];
  board: CompiledBoardLine[];
  /** 本句总时长（动作演完的时间；语音可能更长，由播放器兜） */
  duration: number;
  /** 底部"当前动作"提示 */
  label: string;
  /** 本句要强调的对象（其余变淡） */
  focus: string[];
  /** 本句用到的已知条件下标 */
  known?: number;
  /** 本句才出现的场景对象 */
  reveal?: string[];
  /** 句末停留 */
  hold: number;
  /** 本句开始之前，黑板上已经有多少行（用于增量更新 DOM） */
  boardBefore: number;
  /**
   * 本句所有动作"演完"后的静态图形，预计算一次。
   *
   * 为什么预计算：讲第 8 句时要同时画出前 7 句留下的所有记号（这就是
   * "图在长"），如果每帧重算一遍 7 句的几何，帧率会掉得很难看。
   * 演完的样子是固定的，算一次存起来即可。
   */
  finalShapes: OverlayShape[];
}

export interface Timeline {
  beats: CompiledBeat[];
  ctx: MarkContext;
  /** 全部板书行（跨句累积，按出现顺序） */
  boardLines: CompiledBoardLine[];
}

/** 一句至少给这么长，否则动作刚起来就切走了 */
const MIN_BEAT_MS = 2000;
/** 动作演完后的余韵：让人看清最后画上去的东西 */
const TAIL_MS = 420;
/** 默认句末停留 */
const DEFAULT_HOLD = 500;

/**
 * 编译时间轴。
 *
 * scene 为 null（3D 场景）时只编板书和时间，不生成图形动作——
 * 3D 的标注要处理前后遮挡，那是下一阶段的事。
 */
export function compileTimeline(
  narration: Narration,
  scene: Scene | null,
  params: Record<string, number>,
  opts: { lineWidth: number; helperWidth: number; boardMode?: boolean },
): Timeline {
  const pos = scene ? resolvePoints(scene, params) : new Map<string, [number, number]>();
  const ctx: MarkContext = {
    pos,
    constraints: scene?.constraints ?? [],
    centroid: centroidOf(pos),
    lineWidth: opts.lineWidth,
    helperWidth: opts.helperWidth,
  };

  const beats: CompiledBeat[] = [];
  const boardLines: CompiledBoardLine[] = [];
  let beatIndex = 0;

  narration.steps.forEach((step, stepIdx) => {
    step.beats.forEach((b, inStep) => {
      const isLastOfStep = inStep === step.beats.length - 1;
      const compiled: CompiledAction[] = [];
      let cursor = 0;

      for (let ai = 0; ai < b.actions.length; ai++) {
        const action = b.actions[ai];
        // 造点先落地：后面的 draw 要引用它；失败的动作直接跳过（不排期）
        if (action.kind === 'newpoint') {
          const p = applyNewPoint(action, pos);
          if (!p) continue;
        }
        const dur = ACTION_MS[action.kind] ?? 400;
        compiled.push({
          action,
          start: cursor,
          dur,
          key: `b${beatIndex}a${ai}`,
        });
        cursor += dur + ACTION_STAGGER_MS;
      }
      // 最后一个动作不留下一个错峰间隔
      const actionEnd = compiled.length
        ? compiled[compiled.length - 1].start + compiled[compiled.length - 1].dur
        : 0;

      // ---- 板书排期：跟在动作后面，一句一句落 ----
      const board: CompiledBoardLine[] = [];
      const rawAll = b.board ?? [];
      // 板书模式下，每一步开头先落一个步骤小标题，让推导板有分段。
      // 降级讲稿会把标题塞进第一步的板书里，这里去掉重复的那一份。
      if (opts.boardMode && inStep === 0) {
        board.push({ text: step.title, accent: false, start: 0, heading: true });
      }
      const rawBoard =
        opts.boardMode && inStep === 0
          ? rawAll.filter((t, i) => !(i === 0 && t.trim() === step.title.trim()))
          : rawAll;
      rawBoard.forEach((text, bi) => {
        const line: CompiledBoardLine = {
          text,
          accent: /^(所以|因此|故|即|∴)/.test(text) || bi === rawBoard.length - 1,
          start: actionEnd + bi * 260,
        };
        board.push(line);
      });
      // 紧挨着的重复行只留一条：模型常在相邻两句里复述同一句结论
      // （真实截图里「截面为四边形 DMNP」落了两遍，看着像黑板写重了）。
      // 只拦相邻重复，隔了几行的复述可能是刻意的强调，不动。
      for (let i = board.length - 1; i >= 0; i--) {
        const prev = i > 0 ? board[i - 1] : boardLines[boardLines.length - 1];
        if (!prev || prev.heading || board[i].heading) continue;
        if (prev.text.trim() === board[i].text.trim()) board.splice(i, 1);
      }
      for (const line of board) boardLines.push(line);

      const duration = Math.max(
        MIN_BEAT_MS,
        actionEnd + TAIL_MS,
        board.length ? board[board.length - 1].start + 320 : 0,
      );

      // ---- 本句重点：emphasize 的 id + 正在操作的对象 ----
      const focus: string[] = [];
      for (const ca of compiled) {
        const a = ca.action;
        if (a.kind === 'emphasize') focus.push(...a.ids);
        else if (a.kind === 'angle') focus.push(a.at, a.arm1, a.arm2);
        else if (a.kind === 'length') focus.push(a.from, a.to);
        else if (a.kind === 'draw') focus.push(a.from, a.to);
        else if (a.kind === 'equal') focus.push(a.a1, a.a2, a.b1, a.b2);
        else if (a.kind === 'newpoint') focus.push(a.id);
      }

      beats.push({
        step: stepIdx,
        say: b.say,
        actions: compiled,
        board,
        duration,
        // 3D 没有几何动作可演，emphasize 的 id 是物体名（cyl / axis），
        // 直接拼成"看 cyl"这种提示还不如不提示，交给步骤标题兜底
        label: scene ? firstVisibleLabel(compiled.map((c) => c.action)) : '',
        focus: [...new Set(focus)],
        known: b.known,
        reveal: b.reveal,
        hold: b.hold ?? (isLastOfStep ? 900 : DEFAULT_HOLD),
        boardBefore: boardLines.length - board.length,
        finalShapes: [],
      });
      beatIndex += 1;
    });
  });

  // 预计算"演完后的样子"。旧句的记号要一直留在图上（黑板上擦不掉的痕迹），
  // 所以压一点透明度，让当前句的记号仍然是视觉中心。
  for (const b of beats) {
    const shapes: OverlayShape[] = [];
    for (const ca of b.actions) {
      for (const s of actionShapes(ca.action, ctx, 1, ca.key)) {
        shapes.push({ ...s, opacity: 0.45 });
      }
    }
    b.finalShapes = shapes;
  }

  return { beats, ctx, boardLines };
}

export interface BeatFrame {
  /** 这一帧要画的覆盖图形 */
  overlay: OverlayShape[];
  /** 这一帧黑板上应该有几行（含之前所有句的） */
  boardCount: number;
  /** 最近一行是否还在写（用于高亮当前行） */
  boardActive: boolean;
  /** 底部提示（优先显示"正在做的动作"） */
  label: string;
  /** 这一帧参数滑杆应该推到哪（含参数的题靠它让图形真的动起来） */
  param?: { name: string; value: number };
}

/**
 * 采样某一句在 t 毫秒时的样子。
 *
 * 纯函数：同样的 t 永远给同样的画面。播放、暂停续播、跳句都用它，
 * 不需要额外维护"我演到哪了"的状态机。
 */
export function sampleBeat(tl: Timeline, index: number, t: number): BeatFrame {
  const beat = tl.beats[index];
  if (!beat) return { overlay: [], boardCount: 0, boardActive: false, label: '' };

  const overlay: OverlayShape[] = [];
  // ① 之前讲过的句子：记号全部留在图上（这是"像讲题"而不是"像翻页"的根本）
  for (let j = 0; j < index; j++) {
    overlay.push(...tl.beats[j].finalShapes);
  }

  // ② 当前这句：按 t 演出
  let label = '';
  let param: BeatFrame['param'];
  for (const ca of beat.actions) {
    if (t < ca.start) continue;
    const p = ca.dur <= 0 ? 1 : Math.min(1, (t - ca.start) / ca.dur);
    overlay.push(...actionShapes(ca.action, tl.ctx, p, ca.key));
    const l = actionLabel(ca.action);
    if (l) label = l;
    // 扫参：用 smoothstep 缓动，起步和收尾都不"啪"地跳一下
    if (ca.action.kind === 'param') {
      const e = p * p * (3 - 2 * p);
      param = {
        name: ca.action.name,
        value: ca.action.from + (ca.action.to - ca.action.from) * e,
      };
    }
  }

  let boardCount = beat.boardBefore;
  let boardActive = false;
  for (const line of beat.board) {
    if (t >= line.start) {
      boardCount += 1;
      boardActive = t - line.start < 420;
    }
  }

  return { overlay, boardCount, boardActive, label: label || beat.label, param };
}

/** 某一句在 t=0 的静态画面（跳句、暂停时用：直接给"这句刚开始"的样子） */
export function staticFrame(tl: Timeline, index: number): BeatFrame {
  return sampleBeat(tl, index, 0);
}

/** 整段动画总时长（不含语音），用于估算进度条 */
export function totalActionMs(tl: Timeline): number {
  return tl.beats.reduce((sum, b) => sum + b.duration + b.hold, 0);
}
