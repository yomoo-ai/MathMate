/**
 * narration.ts —— 讲解脚本（分镜 + 动作）生成
 *
 * ===== 这一层在解决什么 =====
 * 场景里的 steps 是"解题过程的书面记录"——一步一整段，语言是结论式的。
 * 直接拿去播就是念答案；只拆句子 + 高亮，又变成"一页一个重点"的翻页。
 *
 * 所以脚本的最小单位不是"句子"，而是**动作**：
 *   一句话 + 这句话里手上做的事（作线、标角、写板书）
 *
 *   beat.say      —— 嘴上说什么（口语，交给 TTS）
 *   beat.actions  —— 手上做什么（几何动作，交给渲染器逐帧演出来）
 *   beat.board    —— 往黑板上添哪一行推导
 *
 * 动作会留在图上，讲到第五句时前四句的痕迹都还在——这才是"讲题"，
 * 而不是"放 PPT"。动作的数据模型见 core/action.ts。
 *
 * ===== 三条铁律（写进提示词，代码里再兜一层）=====
 *   ① 不得改变数学结论——只把书面语改口语、把段落拆句，不许改数字。
 *   ② 只能引用真实存在的对象 id——模型很爱编 id（说"CE"但场景里没有）。
 *      编出来的 id 在这里就被丢掉，不会送进渲染器。
 *   ③ 不许自己造坐标——辅助点只声明几何关系（在线上 / 垂足），
 *      坐标由程序解算。模型算坐标是它最容易错的地方。
 *
 * 失败一律降级：本地生成"按句切分 + 从 constraints 推动作"的脚本，
 * 视频照常能播，绝不因为讲稿生成把播放卡死。
 */
import type { Scene, StepDef } from '../protocol/scene';
import type { Scene3D } from '../protocol/scene3d';
import { isScene3D } from '../protocol/scene3d';
import type { Action } from '../core/action';
import { callChat } from './stub';
import { clipBoardLine } from '../ui/mathText';

type AnyScene = Scene | Scene3D;

/** 一句话 + 这句话里的动作 */
export interface Beat {
  /** 这一句讲什么（口语，15~40 字；公式用 $...$ 包 LaTeX） */
  say: string;
  /** 这一句里手上的动作（按顺序演出） */
  actions: Action[];
  /** 这一句新增的板书行（累积显示，不含前面的行） */
  board?: string[];
  /** 本句用到的已知条件下标（knowns 的下标，从 0 起） */
  known?: number;
  /** 本句才第一次出现的场景对象 id（辅助线之外的对象，兜底用） */
  reveal?: string[];
  /** 句末停留（毫秒）。结论句给 900~1400，过程句省略 */
  hold?: number;
}

export interface NarrationStep {
  title: string;
  beats: Beat[];
}

/**
 * 一条"被丢掉的动作"。
 *
 * 为什么要把丢弃记录下来：模型写了动作、解析器不认，两边都没有声音——
 * 现场表现就是"讲得很热闹，图一动不动"，而人完全不知道该去修哪。
 * 记下位置和原因，视频角上就能直接说"第 2 句想标 F1，但图里没有这个点"。
 */
export interface ActionIssue {
  /** 第几步（从 0 起，对应 scene.steps 下标） */
  step: number;
  /** 该步第几句（从 0 起） */
  beat: number;
  /** 动作类型，如 draw / angle / length */
  kind: string;
  /** 动作原文摘要，方便定位 */
  detail: string;
  /** 人话原因 */
  why: string;
}

export interface Narration {
  /** 已知条件清单（人话，一条一句）；开场后常驻在画面角落 */
  knowns: string[];
  steps: NarrationStep[];
  /** true = 模型生成；false = 本地降级（提示用户时用） */
  fromModel: boolean;
  /** 被丢掉的动作（诊断用）。为空时省略 */
  issues?: ActionIssue[];
}

// ---------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------

function systemPrompt(opts: { is3d: boolean; hasFold: boolean }): string {
  return `你是一位中学数学老师，正在录一段"边讲边画"的解题视频。请把给出的解题步骤改写成**动作脚本**。

【核心要求】
不要"念答案"，要像老师在黑板上讲题：每一句都对应一个**手上的动作**——
作辅助线、标一个角、标一条边的长度、打等长记号、往黑板上写一行推导。
动作会留在图上，所以整段讲完，图上应该是一张"写满了的题图"，而不是反复高亮。

【输出格式】只输出一个 JSON 对象，第一个字符是 {，最后一个是 }，不要解释、不要 markdown 围栏。
{
  "knowns": ["∠C = 90°", "∠A = 30°"],
  "steps": [
    {
      "title": "沿用原步骤标题",
      "beats": [
        {
          "say": "先看条件，∠C 是直角。",
          "actions": [{ "kind": "angle", "at": "C", "arm1": "A", "arm2": "B" }],
          "board": ["∠C = 90°"]
        },
        {
          "say": "在这个直角三角形里，∠A 是 30°。",
          "actions": [
            { "kind": "angle", "at": "A", "arm1": "B", "arm2": "C" },
            { "kind": "length", "from": "A", "to": "B" }
          ],
          "board": ["∠A = 30°", "AB = 6"]
        },
        {
          "say": "过 C 作 AB 的垂线，垂足记作 D。",
          "actions": [
            { "kind": "newpoint", "id": "D", "foot": { "from": "C", "line": ["A", "B"] } },
            { "kind": "draw", "from": "C", "to": "D", "dashed": true }
          ],
          "board": ["CD ⊥ AB"]
        }
      ]
    }
  ]
}

【可用的动作】
1. {"kind":"newpoint","id":"D","foot":{"from":"C","line":["A","B"]}}
   —— D 是 C 到直线 AB 的垂足。只能这样声明，**绝对不要自己算坐标**。
2. {"kind":"newpoint","id":"E","on":["A","B"],"t":0.5}
   —— E 在 AB 上，AE:EB 由 t 决定（t=0.5 是中点，t=1/3 表示 AE 占三分之一）。
3. {"kind":"draw","from":"A","to":"D","dashed":true}
   —— 作辅助线。两端必须是有 id 的点（可以是上面刚造的点）。
4. {"kind":"angle","at":"B","arm1":"A","arm2":"C"}
   —— 在顶点 B 标出 ∠ABC。**不要写度数**，程序会按题目给的真值填。
5. {"kind":"length","from":"B","to":"D"}
   —— 在 BD 旁边标出它的长度。**不要写数字**，程序会去查题目条件。
6. {"kind":"equal","a1":"A","a2":"B","b1":"C","b2":"D"}
   —— 表示 AB = CD，两边各打一道等长记号。
7. {"kind":"emphasize","ids":["BD"]}
   —— 只是把注意力引到某些对象上（不改图），用于"看这条边"这类句子。
8. {"kind":"param","name":"m","from":-8,"to":7.9}
   —— 把滑杆 m 从 -8 连续推到 7.9，图形会跟着变形。
   **只能推对象清单里登记过的参数**。题目是"分类讨论 / 参数范围"时，
   按分类分段推：先推到边界一侧，讲完再推到另一侧。
9. {"kind":"board","text":"$BD = \\\\frac{1}{2}AB$","accent":true}
   —— 往黑板加一行推导。通常用 beat.board 数组更省事。${opts.is3d ? `
10. {"kind":"view","face":"fBottom"}
   —— 把镜头转到正对某个面（只在"看底面 / 从上面看 / 看侧面"这类句子用）。
   也可以直接指视角：{"kind":"view","azimuth":35,"elevation":60}。
   整段最多用 2 次——镜头一多，人就晕了，而且每次转都要占掉 1 秒多。${
   opts.hasFold
     ? `
11. {"kind":"fold"}
   —— 把图**折起来**（本题已声明折痕与折起角，你不用写任何坐标或角度）。
   在讲到"沿 BD 折起 / 折成 / 翻折"的那一句写，**整段只写一次**。
   注意：折之前整张图是摊平的，所以折起之后的句子才按立体图形讲；
   如果原文从头到尾没提折起，就不要写这个动作。`
     : ''
 }` : ''}

【硬性规则】
1. **绝不改变数学内容**：不许改数字、不许换推理路线、不许加题面没有的条件、不许跳步。
2. 每一步拆成 2~4 句，每句 15~40 个汉字，只讲一件事。
3. 引用的 id 只能来自【对象清单】或你自己用 newpoint 声明过的点。
4. 角度、长度**只声明"标哪个"，不要写数值**——数值由题目条件决定，写错就是错。
5. 板书一行只写一个结论或一步推导，20 字以内，公式用 $...$ 包起来。
6. 讲法要像老师：先说做什么、为什么；再动手；最后给结论。禁止只念结论。
7. 新造的点不要超过 2 个；没有必要的辅助线不要造。
8. 如果【本题没有图形】（只有板书），actions 一律给空数组 []，只写 say 和 board。
   **绝不要编造不存在的点/边去"凑"动作**——被丢掉的动作用处是零，
   反而会让视频看起来"讲得很热闹、图一动不动"。

步骤的数量和顺序必须与原文一致，不要增删步骤。`;
}

/** 对象清单 + 已登记的几何条件：模型只能从这里挑 id，数值只能从这里取 */
function describeScene(scene: AnyScene): string {
  const lines: string[] = [];
  for (const obj of scene.objects) {
    const o = obj as { id?: string; type: string; label?: string };
    if (!o.id) continue;
    const label = o.label ? `，标签「${o.label}」` : '';
    lines.push(`${o.id}（${o.type}${label}）`);
  }

  const params = (scene.params ?? [])
    .map((p) => `${p.name}（${p.min} ~ ${p.max}，当前 ${p.value}）`)
    .join('、');

  const cons = (scene as Scene).constraints ?? [];
  const facts: string[] = [];
  for (const c of cons) {
    if (c.type === 'angle-value') facts.push(`∠${c.points[0]}${c.points[1]}${c.points[2]} = ${c.deg}°`);
    else if (c.type === 'perp') facts.push(`${c.points[0]}${c.points[1]} ⊥ ${c.points[2]}${c.points[1]}`);
    else if (c.type === 'equal-length') facts.push(`${c.a[0]}${c.a[1]} = ${c.b[0]}${c.b[1]}`);
    else if (c.type === 'length-ratio') facts.push(`${c.a[0]}${c.a[1]} = ${c.ratio}${c.b[0]}${c.b[1]}`);
    else if (c.type === 'value') facts.push(`${c.expr} = ${c.equals}`);
    else if (c.type === 'parallel') facts.push(`${c.a[0]}${c.a[1]} ∥ ${c.b[0]}${c.b[1]}`);
    else if (c.type === 'midpoint') facts.push(`${c.m} 是 ${c.ends[0]}${c.ends[1]} 的中点`);
  }

  const board = (scene as Scene).visual === 'board';

  const is3d = isScene3D(scene);
  const fold = is3d ? (scene as Scene3D).fold : undefined;
  const faceIds = is3d
    ? scene.objects.filter((o) => o.type === 'face3').map((o) => o.id)
    : [];

  const foldBlock = fold
    ? `

【本题有翻折（视频会把"折起来"这个过程演出来）】
折痕是 ${fold.crease[0]}${fold.crease[1]}，跟着折起来的是 ${fold.moving.join('、')} 这一块，
折起角 ${fold.deg}°。讲到折起那一步写 {"kind":"fold"}（整段只写一次）。
折起之前图是摊平的，所以在那之前的句子不要把它当立体图形讲。`
    : '';

  const facesBlock = is3d
    ? `

【可以"转过去看"的面（view 动作的 face 只能填这些）】
${faceIds.length ? faceIds.join('、') : '（本题没有声明面）'}`
    : '';

  return `【本题有没有图形】
${board ? '没有图形（visual=board）：这是一道只能靠推导讲的题，actions 必须全部为空数组，只写 say 和 board。' : '有图形：动作只能引用下面清单里的 id。'}

【对象清单】
${lines.length ? lines.join('、') : '（无）'}

【可扫的参数（param 动作只能推这些）】
${params || '（无）'}

【题目已登记的几何条件（标角度/长度时以这里为准）】
${facts.length ? facts.join('；') : '（本题没有登记几何条件，动作只做 emphasize / draw / param / board）'}${foldBlock}${facesBlock}`;
}

function userPrompt(problem: string, steps: AnyScene['steps'], scene: AnyScene): string {
  const stepText = (steps ?? [])
    .map((s, i) => {
      const hl = s.highlight?.length ? `（原高亮：${s.highlight.join('、')}）` : '';
      const rv = s.reveal?.length ? `（原本步才出现：${s.reveal.join('、')}）` : '';
      return `第 ${i + 1} 步《${s.title}》${hl}${rv}：${s.text}`;
    })
    .join('\n');

  return `【题目】
${problem || '（题目原文缺失，按步骤理解）'}

【原始步骤】
${stepText}

${describeScene(scene)}`;
}

// ---------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有输出 JSON 对象');
  return JSON.parse(text.slice(start, end + 1));
}

function asIdList(v: unknown, valid: Set<string>): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const ids = v.filter((x): x is string => typeof x === 'string' && valid.has(x));
  return ids.length > 0 ? ids : undefined;
}

/**
 * 解析一条动作。不合法返回 null（调用方丢弃它）。
 *
 * 校验顺序很重要：newpoint 先登记进 valid，后面的 draw 才能引用它。
 * 这也是为什么动作必须按顺序解析——模型经常把 draw 写在 newpoint 前面，
 * 那种情况下这条 draw 会因为"点不存在"被丢掉，符合预期（宁可少画一条）。
 */
function parseAction(
  raw: unknown,
  valid: Set<string>,
  params: Set<string>,
  /** 立体题专有的两类动作要知道上下文：有没有声明翻折、有哪些面 */
  extra: { is3d: boolean; hasFold: boolean; faces: Set<string> },
  diag?: { why?: string },
): Action | null {
  /** 丢掉动作时把原因写进 diag：视频角上要能说清"为什么没画出来" */
  const fail = (why: string): null => {
    if (diag) diag.why = why;
    return null;
  };

  const a = raw as Record<string, unknown>;
  if (!a || typeof a !== 'object') return fail('动作不是一个对象');
  const kind = a.kind;
  const str = (k: string): string | null => {
    const v = a[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  /** 挑出确实不存在的 id，用来给一句人话原因 */
  const missing = (...ids: (string | null)[]): string[] =>
    ids.filter((x): x is string => !!x).filter((x) => !valid.has(x));

  switch (kind) {
    case 'newpoint': {
      const id = str('id');
      if (!id) return fail('新点缺少 id');
      if (valid.has(id)) return fail(`点 ${id} 已经存在，不能再造一次`);
      const foot = a.foot as { from?: unknown; line?: unknown } | undefined;
      if (foot && typeof foot.from === 'string' && Array.isArray(foot.line)) {
        const line = foot.line as unknown[];
        if (line.length !== 2) return fail('垂足定义里的直线需要两个点');
        const [l0, l1] = [String(line[0]), String(line[1])];
        const miss = missing(foot.from, l0, l1);
        if (miss.length) return fail(`图里没有点 ${miss.join('、')}，垂足定不了`);
        valid.add(id);
        return { kind: 'newpoint', id, foot: { from: foot.from, line: [l0, l1] } };
      }
      const on = a.on as unknown;
      if (Array.isArray(on) && on.length === 2) {
        const [o0, o1] = [String(on[0]), String(on[1])];
        const miss = missing(o0, o1);
        if (miss.length) return fail(`图里没有点 ${miss.join('、')}，分点定不了`);
        let t = 0.5;
        if (typeof a.t === 'number' && isFinite(a.t)) t = a.t;
        else if (typeof a.t === 'string') {
          // 模型有时写 "1/3"：这里只接受简单分数，复杂表达式宁可当中点
          const m = /^\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*$/.exec(a.t);
          if (m && Number(m[2]) !== 0) t = Number(m[1]) / Number(m[2]);
        }
        if (!(t > 0 && t < 1)) return fail('分点比例必须落在 0 和 1 之间');
        valid.add(id);
        return { kind: 'newpoint', id, on: [o0, o1], t };
      }
      return fail('新点既没有 foot（垂足）也没有 on（在两点之间）');
    }

    case 'draw': {
      const from = str('from');
      const to = str('to');
      if (!from || !to) return fail('作线段缺少端点');
      const miss = missing(from, to);
      if (miss.length) return fail(`图里没有点 ${miss.join('、')}`);
      if (from === to) return fail('线段两端是同一个点');
      const out: Action = { kind: 'draw', from, to };
      if (a.dashed !== false) out.dashed = true;
      return out;
    }

    case 'angle': {
      const at = str('at');
      const arm1 = str('arm1');
      const arm2 = str('arm2');
      if (!at || !arm1 || !arm2) return fail('标角缺少顶点或两条边');
      const miss = missing(at, arm1, arm2);
      if (miss.length) return fail(`图里没有点 ${miss.join('、')}`);
      if (at === arm1 || at === arm2 || arm1 === arm2) return fail('角的顶点与两条边重复');
      return { kind: 'angle', at, arm1, arm2 };
    }

    case 'length': {
      const from = str('from');
      const to = str('to');
      if (!from || !to) return fail('标长度缺少端点');
      const miss = missing(from, to);
      if (miss.length) return fail(`图里没有点 ${miss.join('、')}`);
      if (from === to) return fail('标长度的两端是同一个点');
      return { kind: 'length', from, to };
    }

    case 'equal': {
      const a1 = str('a1');
      const a2 = str('a2');
      const b1 = str('b1');
      const b2 = str('b2');
      if (!a1 || !a2 || !b1 || !b2) return fail('等长记号缺少端点');
      const miss = missing(a1, a2, b1, b2);
      if (miss.length) return fail(`图里没有点 ${miss.join('、')}`);
      return { kind: 'equal', a1, a2, b1, b2 };
    }

    case 'emphasize': {
      const ids = asIdList(a.ids, valid);
      return ids ? { kind: 'emphasize', ids } : fail('要强调的对象不在图里');
    }

    case 'param': {
      const name = str('name');
      if (!name) return fail('扫参动作缺少参数名');
      if (!params.has(name)) return fail(`没有可扫的参数 ${name}`);
      const from = typeof a.from === 'number' ? a.from : NaN;
      const to = typeof a.to === 'number' ? a.to : NaN;
      if (!isFinite(from) || !isFinite(to)) return fail(`参数 ${name} 的起止值不是数字`);
      if (from === to) return fail(`参数 ${name} 的起止值相同，扫不动`);
      return { kind: 'param', name, from, to };
    }

    case 'board': {
      const text = str('text');
      if (!text) return fail('板书内容为空');
      return { kind: 'board', text: clipBoardLine(text), accent: a.accent === true };
    }

    case 'fold': {
      // 折痕、折起角都由场景声明，动作只管"什么时候折"——
      // 所以这里不读任何字段，只检查这一场到底有没有可折的东西
      if (!extra.hasFold) return fail('本题没有声明翻折（scene.fold），不要写 fold 动作');
      return { kind: 'fold' };
    }

    case 'view': {
      if (!extra.is3d) return fail('view（转视角）只能用在立体题上');
      const face = str('face');
      if (face && !extra.faces.has(face)) return fail(`图里没有面 ${face}`);
      const azimuth = typeof a.azimuth === 'number' && isFinite(a.azimuth) ? a.azimuth : undefined;
      const elevation = typeof a.elevation === 'number' && isFinite(a.elevation) ? a.elevation : undefined;
      if (!face && azimuth === undefined && elevation === undefined) {
        return fail('view 动作要么给 face（转到正对某个面），要么给 azimuth / elevation');
      }
      const out: Action = { kind: 'view' };
      if (face) out.face = face;
      if (azimuth !== undefined) out.azimuth = azimuth;
      if (elevation !== undefined) out.elevation = elevation;
      return out;
    }

    default:
      return fail(`不认识的动作类型 ${String(kind)}`);
  }
}

/** 动作原文摘要：诊断里要能看出"模型到底写了什么"，截断防止刷屏 */
function safeBrief(raw: unknown): string {
  try {
    const s = JSON.stringify(raw);
    if (!s) return '（空）';
    return s.length > 90 ? `${s.slice(0, 90)}…` : s;
  } catch {
    return '（无法序列化）';
  }
}

/**
 * 把模型输出对齐到原步骤上。
 *
 * 为什么按"步骤数必须相等"处理：模型的 steps 如果少一个，后面的讲解就会
 * 整体错位（第 2 步的画面配第 3 步的话），这比降级更糟。宁可整片降级。
 */
function normalize(raw: unknown, scene: AnyScene): Narration | null {
  const steps = scene.steps ?? [];
  if (steps.length === 0) return null;

  const data = raw as { knowns?: unknown; steps?: unknown };
  const rawSteps = Array.isArray(data.steps) ? data.steps : null;
  if (!rawSteps || rawSteps.length !== steps.length) return null;

  // 真实存在的对象 id：动作只能引用这些（newpoint 会在解析中追加）
  const valid = new Set<string>();
  for (const obj of scene.objects) {
    const id = (obj as { id?: string }).id;
    if (id) valid.add(id);
  }
  // 可扫的参数：param 动作只能推场景里登记过的滑杆
  const paramNames = new Set<string>((scene.params ?? []).map((p) => p.name));

  // 立体题才有的两种动作（折起 / 转视角）要知道：这一场是不是 3D、
  // 有没有声明翻折、有哪些面可以"转过去看"
  const is3d = isScene3D(scene);
  const extra = {
    is3d,
    hasFold: is3d && !!(scene as Scene3D).fold,
    faces: new Set<string>(
      is3d ? scene.objects.filter((o) => o.type === 'face3').map((o) => o.id) : [],
    ),
  };

  const knowns = Array.isArray(data.knowns)
    ? data.knowns
        .filter((k): k is string => typeof k === 'string' && k.trim() !== '')
        .slice(0, 8)
    : [];

  const out: NarrationStep[] = [];
  const issues: ActionIssue[] = [];
  for (let i = 0; i < steps.length; i++) {
    const rs = rawSteps[i] as { title?: unknown; beats?: unknown };
    const rawBeats = Array.isArray(rs?.beats) ? rs.beats : [];
    const beats: Beat[] = [];

    for (const b of rawBeats) {
      const bb = b as {
        say?: unknown;
        actions?: unknown;
        board?: unknown;
        known?: unknown;
        reveal?: unknown;
        hold?: unknown;
      };
      if (typeof bb.say !== 'string' || bb.say.trim() === '') continue;

      const actions: Action[] = [];
      if (Array.isArray(bb.actions)) {
        for (const ra of bb.actions) {
          const diag: { why?: string } = {};
          const act = parseAction(ra, valid, paramNames, extra, diag);
          if (act) actions.push(act);
          else {
            const rawKind = (ra as { kind?: unknown })?.kind;
            issues.push({
              step: i,
              beat: beats.length,
              kind: typeof rawKind === 'string' ? rawKind : '未知',
              detail: safeBrief(ra),
              why: diag.why ?? '动作格式不合法',
            });
          }
        }
      }

      // 板书：beat.board 数组 + 夹在 actions 里的 board 动作，合并去重
      const board: string[] = [];
      if (Array.isArray(bb.board)) {
        for (const line of bb.board) {
          if (typeof line === 'string' && line.trim()) board.push(clipBoardLine(line));
        }
      }
      for (const act of actions) {
        if (act.kind === 'board' && !board.includes(act.text)) board.push(act.text);
      }

      const beat: Beat = { say: bb.say.trim(), actions };
      if (board.length > 0) beat.board = board;
      if (typeof bb.known === 'number' && bb.known >= 0 && bb.known < knowns.length) {
        beat.known = bb.known;
      }
      const reveal = asIdList(bb.reveal, valid);
      if (reveal) beat.reveal = reveal;
      if (typeof bb.hold === 'number' && bb.hold > 0) {
        beat.hold = Math.min(2000, bb.hold);
      }
      beats.push(beat);
    }

    // 这一步一句有效的都没解析出来 → 用本地切句补上，别让视频在这里断掉
    if (beats.length === 0) {
      beats.push(...splitStep(steps[i] as StepDef));
    }
    out.push({ title: steps[i].title, beats });
  }

  return { knowns, steps: out, fromModel: true, issues: issues.length ? issues : undefined };
}

// ---------------------------------------------------------------
// 本地降级：切句 + 从 constraints 推动作
// ---------------------------------------------------------------

/**
 * 把一句话按标点切成短句。
 * $...$ 里的公式整体保护起来——公式里的分号、逗号不能当句读切，
 * 切开后 KaTeX 渲染会坏掉。
 */
function splitSentences(text: string): string[] {
  const guarded: string[] = [];
  const masked = text.replace(/\$[^$]*\$/g, (m) => {
    guarded.push(m);
    return `\u0000${guarded.length - 1}\u0000`;
  });
  const parts = masked
    .split(/(?<=[。！？；\n])/)
    .map((s) => s.trim())
    .filter((s) => s !== '');

  const out: string[] = [];
  for (const p of parts) {
    const restored = p.replace(/\u0000(\d+)\u0000/g, (_, i: string) => guarded[Number(i)] ?? '');
    if (restored.length > 60) {
      const halves = restored.split(/[，,]/);
      let cur = '';
      for (const h of halves) {
        if (cur && (cur + h).length > 45) {
          out.push(cur.replace(/[，,]$/, '') + '，');
          cur = h;
        } else {
          cur += h;
        }
      }
      if (cur.trim()) out.push(cur.trim());
    } else {
      out.push(restored);
    }
  }
  return out.filter((s) => s.trim() !== '');
}

/** 从一句话里抠出板书行：优先取 $公式$，其次取"所以/因此/即"开头的结论 */
function boardFromSentence(say: string): string | null {
  const formulas = say.match(/\$[^$]+\$/g);
  if (formulas && formulas.length > 0) return formulas[formulas.length - 1];
  const m = /(所以|因此|即|故)[^。；]{2,40}/.exec(say);
  if (m) return m[0].trim();
  return null;
}

/**
 * 本地版本的单步脚本：按句切分，并从 constraints 里捡能对上的角/长度。
 *
 * 这是"降级"而不是"另一套产品"：模型不可用时，至少还能看到
 * 图形上被标出的角、写下的长度和累积的板书，比纯念字幕强一个档次。
 */
function splitStep(step: StepDef): Beat[] {
  const sentences = splitSentences(step.text);
  if (sentences.length === 0) return [{ say: step.text || step.title, actions: [] }];

  const text = step.text;
  const beats: Beat[] = sentences.map((say, i) => {
    const actions: Action[] = [];
    if (i === 0 && step.highlight?.length) {
      actions.push({ kind: 'emphasize', ids: step.highlight });
    }
    // 句子里提到了两个点 id 就当作在讲这条边（"AB = 6" / "连接 BD"）
    const seg = /([A-Z])([A-Z])/.exec(say);
    if (seg && text.includes(`${seg[1]}${seg[2]}`) && i > 0) {
      actions.push({ kind: 'length', from: seg[1], to: seg[2] });
    }
    const beat: Beat = { say, actions };
    const board = boardFromSentence(say);
    if (board) beat.board = [board];
    if (i === 0 && step.reveal?.length) beat.reveal = step.reveal;
    return beat;
  });

  // 第一步补一行板书：把标题当小标题写在黑板上（后面每步同理）
  if (beats[0]) beats[0].board = [step.title, ...(beats[0].board ?? [])];
  return beats;
}

/** 降级方案：不调模型，直接把每一步按句切开 + 抽板书 */
export function fallbackNarration(scene: AnyScene): Narration {
  const steps = scene.steps ?? [];
  const out: NarrationStep[] = steps.map((s) => ({ title: s.title, beats: splitStep(s as StepDef) }));

  // 立体题声明了翻折，就给降级脚本补一个 fold 动作——挂在"第一次提到折起"的那一步。
  //
  // 为什么降级也要补：翻折是这道题的**核心画面**（"沿 BD 折起"整句话就是这个动作），
  // 没有 API Key 时如果连折都不折，用户看到的就是一张静态图配一句"沿 BD 折起"，
  // 会以为功能坏了。规则简单到不会错：第一个正文里出现"折"的步骤，第一句开折。
  const fold = isScene3D(scene) ? (scene as Scene3D).fold : undefined;
  if (fold && out.length > 0) {
    let at = steps.findIndex((s) => /折/.test(`${s.title}${s.text}`));
    if (at < 0) at = 0;
    const target = out[at]?.beats[0];
    if (target) target.actions = [{ kind: 'fold' }, ...target.actions];
  }

  return { knowns: [], steps: out, fromModel: false };
}

// ---------------------------------------------------------------
// 入口
// ---------------------------------------------------------------

/**
 * 生成讲解脚本。**永不抛异常**——失败返回本地版本（fromModel=false），
 * 让视频至少能播。调用方按 fromModel 决定是否提示"本次为简化讲解"。
 */
export async function buildNarration(opts: {
  problem: string;
  scene: AnyScene;
  onProgress?: (msg: string) => void;
}): Promise<Narration> {
  const { problem, scene, onProgress } = opts;
  const steps = scene.steps ?? [];
  if (steps.length === 0) return fallbackNarration(scene);

  let hasKey = false;
  try {
    hasKey = Boolean(localStorage.getItem('mm-api-key'));
  } catch {
    hasKey = false; // 隐私模式下 localStorage 会抛异常
  }
  if (!hasKey) {
    onProgress?.('未填 API Key，使用简化讲解');
    return fallbackNarration(scene);
  }

  try {
    onProgress?.('正在拆解讲解动作……');
    const is3d = isScene3D(scene);
    const text = await callChat([
      { role: 'system', content: systemPrompt({ is3d, hasFold: is3d && !!(scene as Scene3D).fold }) },
      { role: 'user', content: userPrompt(problem, steps, scene) },
    ]);
    const parsed = normalize(extractJson(text), scene);
    if (!parsed) {
      onProgress?.('讲稿格式不对，改用简化讲解');
      return fallbackNarration(scene);
    }
    return parsed;
  } catch (err) {
    onProgress?.(`讲稿生成失败（${(err as Error).message.slice(0, 80)}），改用简化讲解`);
    return fallbackNarration(scene);
  }
}
