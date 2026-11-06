/**
 * stub.ts —— LLM 调用层（阶段 1 核心）
 *
 * 数据流（这就是文章里那条流水线的左半边）：
 *   自然语言 → [构建 prompt] → 调 API → 拿到文本
 *     → 剥出 JSON → parseScene 校验
 *        ├─ 通过 → 返回 Scene（渲染器接手）
 *        └─ 失败 → 把错误列表追加进对话，再调一次（最多 3 次）
 *
 * 设计要点：
 *   - 模型输出永远不可信：parseScene 是唯一放行关卡；
 *   - 重试时把「具体错误」喂回去，比笼统说"错了"成功率高得多；
 *   - API Key 存 localStorage（只在本机浏览器），绝不写进代码。
 */

import type { Scene } from '../protocol/scene';
import type { Scene3D } from '../protocol/scene3d';
import { parseScene } from '../protocol/parser';
import { parseScene3D } from '../protocol/parser3d';
import { verifyScene, measureReadouts, type Issue } from '../protocol/verifier';
import { verifyScene3D, measureReadouts3D } from '../protocol/verifier3d';
import { buildSystemPrompt } from './prompt';
import { buildSystemPrompt3D } from './prompt3d';
import { autoFix3D } from '../protocol/autofix3d';

/** 模型与接口配置。换服务商只改这里（保持 OpenAI 兼容格式即可） */
const API_URL = '/llm-api/chat/completions'; // 经 vite 代理转发到 api.deepseek.com
const MODEL = 'deepseek-chat';
const MAX_ATTEMPTS = 3; // 首次 + 最多 2 次重试

// ---------------------------------------------------------------
// 拍照识别（阶段 4）：图片 → 题目文字。
//
// 选型演进（三次实测换回来的经验）：
//   v1 只有智谱 GLM-4V 一条路，"双模型分工"——视觉模型只当转录员；
//   v2 DeepSeek 上线支持图片的 deepseek-flash，试过"一把 Key 走天下"；
//   v3 实测对比：几何图的标记（平行/垂直/相等记号）识别 GLM-4.6V 明显更准，
//      deepseek-flash 识图容易丢条件——转录缺一句，下游生成整条约束链塌掉。
//      所以默认回到「GLM 转录 + DeepSeek 理解」的双模型分工，
//      deepseek-flash 保留在降级链里当兜底（只填一把 Key 也能用）。
// ---------------------------------------------------------------
const VL_API_URL = '/vl-api/api/paas/v4/chat/completions'; // 代理转发到 open.bigmodel.cn

/** 一个可用的「看图」端点：不同厂商 Key 和 URL 不同，消息格式相同（OpenAI 兼容） */
interface VisionEndpoint {
  model: string;
  url: string;
  /** 从 localStorage 取对应的 Key（为空表示用户没填，该端点跳过） */
  key: () => string;
  /** 401/403 时给用户的具体指引 */
  keyAdvice: string;
}

const DEEPSEEK_VISION: VisionEndpoint = {
  model: 'deepseek-flash',
  url: API_URL, // 同一个 api.deepseek.com 端点，走同一个 vite 代理
  key: getApiKey,
  keyAdvice:
    'DeepSeek Key 无效或没有权限（{err}）。请回 platform.deepseek.com 重新复制（sk- 开头）；' +
    '如果这个 Key 是旧版不支持图片的模型，也可以在「视觉模型 Key」里填智谱 Key 兜底。',
};

const GLM_ENDPOINTS: VisionEndpoint[] = [
  {
    model: 'glm-4v-flash',
    url: VL_API_URL,
    key: getVlKey,
    keyAdvice:
      '智谱 Key 无效或没有权限（{err}）。到 open.bigmodel.cn 控制台重新复制 API Key（格式 xxxx.yyyy，不是 sk- 开头）。',
  },
  {
    model: 'glm-4.6v-flash',
    url: VL_API_URL,
    key: getVlKey,
    keyAdvice:
      '智谱 Key 无效或没有权限（{err}）。到 open.bigmodel.cn 控制台重新复制 API Key（格式 xxxx.yyyy，不是 sk- 开头）。',
  },
];

/**
 * 题目转录指令（v2：结构化转录）。
 *
 * v1 只让它"抄一段文字"，几何题必翻车——图形里的平行/垂直/相等标记、
 * 点在线上这些信息全在图里，抄不成一句话就丢了。
 * v2 改成三段式：已知条件逐条列（含图形标记）、求证原样、图形骨架用文字描述。
 * 看不清的地方强制写 (不确定)，不许猜——猜错的代价比留空大得多。
 */
const TRANSCRIBE_PROMPT = `你是数学题转录器。图片里可能是一道带图形的几何题或代数题，请把它转写成结构化的中文文字，供后续程序解析。

按下面三段输出，段标题原样保留：

【已知】
逐条列出题目给出的全部条件。如果是几何题，必须逐条写清：
- 图中有哪些点、哪些线段、哪些角；
- 图中标注的关系：相等（如 AB=AC）、平行（AB∥CD）、垂直（AB⊥CD）、直角、中点、角平分线、圆、切线、弦等；
- 图形上标注的数字、字母、角度值。
看不清或不确定的地方在括号里写 (不确定)，绝对不要猜。

【求证/求】
原样转写题目要求证明或求解的结论。

【图形结构】
用文字描述图形的骨架，逐条说明：哪些点连成哪条线；哪两条线平行或垂直；哪些角标了记号；点的相对位置（如「D 在 BC 上」「O 是圆心」）。

硬性要求：
1. 只转写，不解题、不解释、不补充推理；
2. 数字、字母、符号一个都不能丢；看不清写 (不确定)；
3. 公式用普通文本：x^2、sqrt(2)、(a)/(b)、∠ABC、△ABC；
4. 图里有多道题时只转写第一道；
5. 直接输出转写结果，不要任何前后缀。`;

/** UI 进度回调：把每一步显示到界面上（调试 prompt 时非常有用） */
export type ProgressFn = (message: string) => void;

/** 体检报告回调：每轮数值体检的结果（含被打回重试的）都抛给 UI 展示 */
export type IssuesFn = (issues: Issue[]) => void;

function getApiKey(): string {
  const raw = localStorage.getItem('mm-api-key') ?? '';
  // 清洗：只保留可打印 ASCII 字符（0x20~0x7E）。
  // 从微信/网页复制 key 时经常带进全角空格、弯引号、零宽字符（U+200B）、
  // BOM 等"看不见的杂质"——HTTP 头不允许非 Latin-1 字符，
  // 浏览器会直接抛 "String contains non ISO-8859-1 code point"。
  // key 本身就是 sk- 开头的纯 ASCII，删掉杂质不影响正确性。
  return raw.replace(/[^\x20-\x7E]/g, '').trim();
}

/** 视觉模型的 Key（智谱，格式是 "id.secret"，不是 sk- 开头） */
function getVlKey(): string {
  return (localStorage.getItem('mm-vl-key') ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

// ---------------------------------------------------------------
// 场景「内核」：把一个场景类型与流水线的差异点集中成一个小对象
//
// 六道关（生成 → 格式 → 数值 → 约束 → 复核 → 渲染）对 2D 和 3D 是同一套逻辑，
// 只有四个地方不同：说明书、解析器、体检器、给复核用的事实材料。
// 把这四点抽出来，流水线本身就不需要知道"平面还是立体"——
// 以后再加一种场景（比如统计图），只要再写一个 kernel。
// ---------------------------------------------------------------
export interface SceneKernel<T> {
  /** 日志里怎么称呼它 */
  label: string;
  systemPrompt: () => string;
  parse: (json: string) => { ok: true; scene: T } | { ok: false; errors: string[] };
  verify: (scene: T) => Issue[];
  stepsOf: (scene: T) => Array<{ title: string; text: string }> | undefined;
  /** 复核用的事实材料（已声明的约束 + 图形实测值） */
  facts: (scene: T) => string;
  /**
   * 程序代改（可选）：体检发现错误后，先用程序能证明的答案直接修——
   * 省一次模型调用，也避免"模型看着答案都抄不对"烧出 429。
   * 只修程序能证明的（截面边数、交点、写反的比值），修不动原样返回。
   */
  autoFix?: (scene: T) => { scene: T; fixes: string[] };
}

/** 平面场景（原链路，行为完全不变） */
const KERNEL_2D: SceneKernel<Scene> = {
  label: '平面',
  systemPrompt: buildSystemPrompt,
  parse: parseScene,
  verify: verifyScene,
  stepsOf: (s) => s.steps,
  facts: (s) => sceneFacts(s),
};

/** 立体几何场景 */
const KERNEL_3D: SceneKernel<Scene3D> = {
  label: '立体',
  systemPrompt: buildSystemPrompt3D,
  parse: parseScene3D,
  verify: verifyScene3D,
  stepsOf: (s) => s.steps,
  facts: (s) => sceneFacts3D(s),
  autoFix: autoFix3D,
};

// ---------------------------------------------------------------
// 限流退避重试（实测补充）
//
// 事故：生成一道题时控制台冒出 "429 (Too Many Requests)"，整次生成直接失败。
// 429 / 5xx 都是**暂时性**故障——等一两秒再发同一个请求通常就好了。
// 免费额度的视觉模型（GLM-4V-Flash）尤其常见。
// 所以：可重试的状态码用指数退避重发，不可重试的（401 键错、400 参数错）
// 立刻失败——重试只会浪费时间，还会把真正的错误信息埋掉。
// ---------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 429 不是一种故障，而是四种，处理方式完全相反：
 *   - insufficient_balance → 账户没钱了，等一万年也不会好，只能去充值；
 *   - quota_exceeded       → 当日/当月额度用尽，得等重置或充值；
 *   - rate limit           → 真的只是发太快，等几十秒再试就好；
 *   - 什么都不写           → 按限流处理（最保守）。
 *
 * 服务商把原因写在响应体里（OpenAI 兼容格式的 error.message / error.code），
 * 所以这里必须解析 body，光看状态码分不出来——用户看到的就是
 * "明明还有余额，为什么一直 429" 或者 "一直等重试，其实是没钱了"。
 */
function explain429(
  body: string,
  label: string,
): { transient: boolean; message: string } {
  const b = body.toLowerCase();
  const site = /deepseek/i.test(label) ? 'platform.deepseek.com' : 'open.bigmodel.cn';

  if (/insufficient|balance|余额/.test(b)) {
    return {
      transient: false,
      message:
        `${label} 账户余额不足（429 insufficient_balance）——这不是限流，重试一百次也一样。\n` +
        `请打开 ${site} 充值，余额到账（通常即时）后再点一次。\n` +
        '提示：赠送余额和充值余额是分开扣的，先看页面上的余额数字是不是 0。',
    };
  }
  if (/quota/.test(b)) {
    return {
      transient: false,
      message:
        `${label} 账号的额度/配额已经用完（429 quota_exceeded）。\n` +
        `去 ${site} 看看额度详情，等重置或充值后再试。`,
    };
  }
  return {
    transient: true,
    message:
      `${label} 请求被限流（429，同一时刻的请求太多或触发了速率上限）。\n` +
      '等 30 秒再点一次即可；等待期间别连续点按钮——连点会让限流窗口一直续上，越点越久。\n' +
      '（浏览器控制台那条红色的 429 是浏览器自己记的账，重试成功也会留着，不用管它。）',
  };
}

// ---------------------------------------------------------------
// 请求节流：两次出网请求之间至少隔 MIN_REQUEST_GAP_MS
//
// 为什么需要：一道题的生成不是一次调用——生成 → 数值体检 → 带着错误重写
// → 证明复核，串下来 4~6 次请求。账号若按「每分钟 N 次」限流，这么一串
// 打过去很容易撞 429；更糟的是**每次重试又占一个额度**，于是越重试越撞，
// 用户看到的就是「重试了还是 429」。
// 强制拉开间隔，总耗时只多几秒，换的是「不再整次失败」。
//
// 注意这是全局节流（含视觉转录），因为图文两条链路共用同一个账号额度。
// ---------------------------------------------------------------
const MIN_REQUEST_GAP_MS = 1500;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  onProgress?: ProgressFn,
  tries = 3,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let i = 1; i <= tries; i++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // fetch 本身抛异常（断网、代理拦了）——也可能是暂时的
      lastError = err as Error;
      if (i === tries) break;
      const wait = 800 * i;
      onProgress?.(`   ${label} 网络异常（${lastError.message}），${wait / 1000}s 后重试……`);
      await sleep(wait);
      continue;
    }

    if (res.ok) return res;

    const body = await res.text().catch(() => '');
    lastError = new Error(`${label} 返回 ${res.status}：${body.slice(0, 300)}`);

    if (!RETRYABLE_STATUS.has(res.status)) throw lastError;

    // 429 先分清是「没钱」还是「太快」：没钱就立刻停，重试只会白等三次
    if (res.status === 429) {
      const info = explain429(body, label);
      if (!info.transient) throw new Error(info.message);
      lastError = new Error(info.message);
      // 原始响应留在过程日志里——真出问题时得看服务商到底说了什么
      onProgress?.(`   ${label} 429 原始响应：${body.slice(0, 180).replace(/\s+/g, ' ')}`);
    }

    if (i === tries) throw lastError;

    // 服务端给了 Retry-After 就照它等，否则退避。
    //
    // 429 的等待必须**比"网络抖一下"长得多**：智谱免费档的 429 是
    // 「并发/频率」限制，窗口通常按秒到十几秒算，等 1.2s 再发一模一样会被
    // 立刻再拒一次——用户看到的就是"重试了还是 429"。所以 429 单独给
    // 3s / 6s / 9s 起步，5xx 才是快退避。
    // 加抖动是因为多个请求同时退避会踩同一时刻重发，又撞一起。
    const ra = Number(res.headers.get('retry-after'));
    const jitter = Math.random() * 400;
    const base = res.status === 429 ? 4000 : 1000;
    const wait =
      isFinite(ra) && ra > 0
        ? Math.min(ra * 1000, 20000)
        : Math.min(base * i + jitter, 20000);
    onProgress?.(
      `   ${label} 被限流（${res.status}），${(wait / 1000).toFixed(1)}s 后自动重试（第 ${i}/${tries - 1} 次）……`,
    );
    await sleep(wait);
  }
  throw lastError ?? new Error(`${label} 重试后仍失败`);
}

/**
 * 拍照识别入口：图片 base64 → 结构化题目文字。
 * 多模态消息格式（OpenAI 兼容）：content 是数组，图片和文字各占一项。
 * 走统一降级链：界面选中的模型排最前，其余按「DeepSeek 优先、GLM 兜底」；
 * 没填对应 Key 的端点直接跳过——一把 DeepSeek Key 就能完成拍照识别。
 */
export async function transcribeImage(
  dataUrl: string,
  onProgress?: ProgressFn,
  preferredModel?: string,
): Promise<string> {
  const all = [DEEPSEEK_VISION, ...GLM_ENDPOINTS];
  const chain = preferredModel
    ? [
        ...all.filter((e) => e.model === preferredModel),
        ...all.filter((e) => e.model !== preferredModel),
      ]
    : all;

  // 没填 Key 的端点不参与尝试（连错误信息都省了）
  const usable = chain.filter((e) => e.key() !== '');
  if (usable.length === 0) {
    throw new Error(
      '拍照识别需要至少一个模型的 Key（二选一即可）：\n' +
        '· 主用：左侧「DeepSeek API Key」（sk- 开头，platform.deepseek.com）——填了它就能拍照；\n' +
        '· 备选：「视觉模型 Key」（智谱 GLM-4V-Flash，open.bigmodel.cn 永久免费）。',
    );
  }

  // 限流 429 很常见：浏览器控制台一定会留下红色 "Failed to load resource"，
  // 那是浏览器记的账，代码拦不住。我们能做的是重试 + 成功后告诉用户别管它。
  let sawRateLimit = false;
  const relay: ProgressFn = (m) => {
    if (m.includes('限流') || m.includes('429')) sawRateLimit = true;
    onProgress?.(m);
  };

  let lastError: Error | null = null;
  for (const ep of usable) {
    try {
      relay(`→ 正在用 ${ep.model} 识别图片……`);
      // 每个端点最多试 3 次：限流时退避等一下通常就能过
      const res = await fetchWithRetry(
        ep.url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ep.key()}`,
          },
          body: JSON.stringify({
            model: ep.model,
            messages: [
              {
                role: 'user',
                content: [
                  // 图片用 data URL（base64）直接内嵌在请求里，不需要图床
                  { type: 'image_url', image_url: { url: dataUrl } },
                  { type: 'text', text: TRANSCRIBE_PROMPT },
                ],
              },
            ],
            temperature: 0.1, // 转录任务要的就是逐字忠实，温度压到最低
          }),
        },
        ep.model,
        relay,
        3,
      );
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim() !== '') {
        if (sawRateLimit) {
          relay('   （控制台那条红色 429 是服务商的频率限制，已自动重试成功，不用管）');
        }
        return content.trim();
      }
      lastError = new Error('识别模型没有返回文字（图片可能不清晰或不含题目）');
    } catch (err) {
      lastError = err as Error;
      // Key 错（401/403）：这个端点换哪个模型都没用，直接告诉用户怎么办
      if (/返回 40[13]/.test(lastError.message)) {
        throw new Error(ep.keyAdvice.replace('{err}', lastError.message));
      }
      // 400 之类的参数错（比如该模型暂不收图）不死磕——换下一个端点
      relay(`   ${ep.model} 不可用（${lastError.message.slice(0, 120)}），尝试下一个……`);
    }
  }
  // 全线溃败时把 lastError 原样抛出即可——429 / 余额不足的文案
  // 已经在 explain429 里翻译成人话了，这里不用再包一层（包了反而会
  // 把"余额不足"误说成"只是限流"）。
  throw lastError ?? new Error('所有识别模型都没能识别这张图');
}

// ---------------------------------------------------------------
// 证明复核（阶段 4 补充）：语义层的正确性关卡
//
// 数值体检能抓"算不出数"，抓不到"算得出但推错了"。
// 分步讲解（steps）里的定理引用、逻辑跳跃只有读文字才能判断，
// 所以加一道「LLM 复核」：让另一个视角把原题和步骤对着读一遍。
//
// 诚实的边界：LLM 复核自己也会看走眼。所以它只当"质检员"——
// 报错就回传重做一次；再不过就放行，但把疑点留在报告里让你判断。
// ---------------------------------------------------------------

const REVIEW_SYSTEM_PROMPT = `你是严格的数学审题老师。用户会给你【原题】和一份【分步讲解】，有时还会给你【题目已声明的几何关系】和【图形实测值】。请判断分步讲解里的数学内容有没有**确凿错误**。

【以下都不算错误，不要报】
- 同一个角/同一条线的不同记法：∠ADE 与 ∠EDA 相同；当 F 在 AD 上时 ∠EDF 与 ∠ADE 是同一个角；
  线段 AB 与 BA 相同；CD 与 DC 相同。
- 字母顺序、书写风格、详略程度、是否用 LaTeX。
- 你一时没算出来，但也没能算出矛盾的地方。

【以下才算错误，而且必须给出证据】
1. 计算错：写出你的复算过程，指出结果差在哪里；
2. 定理用错：指出这一步用了哪个定理、哪个前提不满足；
3. 逻辑跳跃：指出缺了哪个中间结论；
4. 凭空加条件：指出原题原文哪一句没有，但这一步用上了；
5. 结论错：题目要求证明/求解的东西与最后一步不符。

【铁律】
- 报之前必须先自己复算一遍；复算后如果自己也得出同样的结论，就不报。
- **你的复算只能使用题面给的条件 + 已证明的结论**。不能因为"看起来像"就把某个三角形当直角三角形、
  把某个点当作在线上、把某个角当作已知角——这类未声明的假设一旦用上，算出来的数就是错的，必须撤回。
- 如果给了【图形实测值】，它是从已通过几何验算的坐标算出来的，**与你的心算冲突时以它为准**。

只输出一个 JSON 对象：
- 全部正确：{"ok": true}
- 有问题：{"ok": false, "problems": ["第2步：错误是什么；我的复算：……"]}

problems 每条一句话，必须带你的复算过程。不要重写证明，不要输出其他内容。`;

/**
 * 自检回环的提示词。
 *
 * 为什么要多这一步？——因为复核模型会误报，而且误报的代价很大：
 * 生成模型会照着"莫须有"的错误去改，把本来对的证明改坏。
 * 所以让复核自己对每一条质疑再验算一次，撤回站不住的，只保留有数值证据的。
 * 截图里那条「∠EDF 不等于 ∠ADE，二者相等」就是典型的自相矛盾式误报。
 */
const REVIEW_SELF_CHECK = `下面是对一份分步讲解提出的质疑。请逐条重新验算，只保留**确实成立**的：

- 如果质疑说的是同一个角/同一条线的不同记法（如 ∠ADE 与 ∠EDF 当 F 在 AD 上），撤回；
- 如果质疑的复算用到了题面没有给、也没有被证明的假设，撤回
  （最常见的是把某个三角形当直角三角形、把某条线当垂直、把某点当在线上）；
- 如果质疑自己的复算有误，撤回；
- 只有你重新算过、能给出明确数值或逻辑矛盾时，才保留。

只输出 JSON：{"confirmed": ["保留的质疑"], "withdrawn": ["撤回的质疑（说明为什么撤回）"]}`;

/**
 * 给复核模型的事实材料：已声明的几何关系 + 图形实测值。
 *
 * 这一步很关键——复核模型心算经常错（它曾把 △DEF 当直角三角形，
 * 算出 DF=10，而真值是 2.5）。既然图形已经过约束验算，图上的长度/角度
 * 就是可信的事实基准，直接交给它对照，能显著压低它自己编数的概率。
 */
function sceneFacts(scene: Scene): string {
  const lines: string[] = [];
  const cs = scene.constraints ?? [];
  if (cs.length > 0) {
    lines.push('【题目已声明的几何关系（已知条件，成立；不要当成错误）】');
    for (const c of cs) lines.push(`- ${JSON.stringify(c)}`);
  }
  const measured = measureReadouts(scene);
  if (measured.length > 0) {
    lines.push(
      '【图形实测值（由已通过几何验算的坐标算出，可当事实基准；与你的心算冲突时以它为准）】',
    );
    for (const m of measured) lines.push(`- ${m.label} = ${m.value}`);
  }
  return lines.join('\n');
}

/** 立体场景版：约束描述换成三维的，实测值用 dist3/angle3/area3 算出来 */
function sceneFacts3D(scene: Scene3D): string {
  const lines: string[] = [];
  const cs = scene.constraints ?? [];
  if (cs.length > 0) {
    lines.push('【题目已声明的立体几何关系（已知条件，成立；不要当成错误）】');
    for (const c of cs) lines.push(`- ${JSON.stringify(c)}`);
  }
  const measured = measureReadouts3D(scene);
  if (measured.length > 0) {
    lines.push(
      '【图形实测值（由已通过约束验算的空间坐标算出，可当事实基准；与你的心算冲突时以它为准）】',
    );
    for (const m of measured) lines.push(`- ${m.label} = ${m.value}`);
  }
  return lines.join('\n');
}

interface ProofReview {
  ok: boolean;
  problems: string[];
  /** 被自检撤回的误报（只给用户看，不参与打回） */
  withdrawn: string[];
}

/**
 * 复核分步讲解；网络/解析失败一律当作"没发现问题"，不阻断主流程。
 *
 * 参数里传的是**已经拼好的文字**（步骤 + 事实材料），不传 Scene：
 * 2D 和 3D 的步骤结构一样、事实材料不一样，复核这一关本身不关心维度。
 */
async function reviewProof(
  problem: string,
  steps: string,
  facts: string,
): Promise<ProofReview> {
  const ask = async (
    system: string,
    user: string,
  ): Promise<Record<string, unknown> | null> => {
    try {
      // 复核是"锦上添花"的关卡，限流时等一下重试即可，不值得让整次生成失败
      const res = await fetchWithRetry(
        API_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${getApiKey()}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.1,
            response_format: { type: 'json_object' },
          }),
        },
        '复核',
        undefined,
        2,
      );
      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content;
      if (typeof raw !== 'string') return null;
      return JSON.parse(extractJson(raw)) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const first = await ask(
    REVIEW_SYSTEM_PROMPT,
    `【原题】\n${problem}\n\n【分步讲解】\n${steps}\n\n${facts}`,
  );
  if (!first) return { ok: true, problems: [], withdrawn: [] };
  const problems = Array.isArray(first.problems)
    ? first.problems.filter((p): p is string => typeof p === 'string')
    : [];
  if (first.ok !== false || problems.length === 0) {
    return { ok: true, problems: [], withdrawn: [] };
  }

  // ---- 第二回：自检。只保留能给出证据的质疑 ----
  const check = await ask(
    '你是严谨的复核员，负责撤回站不住的质疑。',
    `${REVIEW_SELF_CHECK}\n\n【原题】\n${problem}\n\n【分步讲解】\n${steps}\n\n${facts}\n\n【待复核的质疑】\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
  );
  const pick = (key: string): string[] => {
    const v = check?.[key];
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  };
  const confirmed = pick('confirmed');
  const withdrawn = pick('withdrawn');

  // 自检没给出结论（网络抖动/格式坏）→ 保守处理：当成没问题，不打扰用户
  if (confirmed.length === 0) {
    return {
      ok: true,
      problems: [],
      withdrawn: withdrawn.length > 0 ? withdrawn : problems,
    };
  }
  return { ok: false, problems: confirmed, withdrawn };
}

/** 从模型输出里剥出 JSON：处理 ```json 围栏、前后废话 */
function extractJson(text: string): string {
  let s = text.trim();
  // 剥 markdown 代码围栏（虽然 prompt 禁止了，模型偶尔还是会加）
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // 兜底：截取第一个 { 到最后一个 } 之间
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > 0 || last < s.length - 1) {
    if (first !== -1 && last > first) s = s.slice(first, last + 1);
  }
  return s;
}

/** 调一次对话接口，返回模型输出的文本 */
export async function callChat(
  messages: Array<{ role: string; content: string }>,
  onProgress?: ProgressFn,
): Promise<string> {
  const key = getApiKey();
  if (!key) {
    throw new Error('还没有填 API Key——在右侧「DeepSeek API Key」输入框里粘贴。');
  }
  if (!key.startsWith('sk-')) {
    throw new Error(
      'Key 格式不对：DeepSeek 的 key 以 "sk-" 开头。请回 platform.deepseek.com 重新复制（注意别带上前后多余的引号或文字）。',
    );
  }
  const res = await fetchWithRetry(
    API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.2, // 低温度 = 输出更稳定，结构化任务要的就是确定性
        // 强制 JSON 模式：服务商在解码层面只允许产出合法 JSON，
        // 从根上消灭"多一句解释、包一层 markdown 围栏"这类事故
        response_format: { type: 'json_object' },
      }),
    },
    'DeepSeek',
    onProgress,
  );
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('API 响应里没有 choices[0].message.content');
  }
  return content;
}

/** 把问题清单格式化成给模型看 / 给用户看的几行文字 */
function formatIssues(issues: Issue[]): string {
  return issues
    .map((i) => `- [${i.level === 'error' ? '错误' : '提醒'}] ${i.where}：${i.message}`)
    .join('\n');
}

/**
 * 六道关的通用流水线：自然语言 → 场景数据。
 *
 * 对 2D / 3D 完全一样，差异全部在 kernel 里（说明书、解析器、体检器、事实材料）：
 *   1. 生成：调模型，剥出 JSON；
 *   2. 格式关：kernel.parse（字段、类型）；
 *   3. 数值关：kernel.verify（把每个表达式真算一遍 + 验算约束）；
 *   4. 复核关：steps 的文字推理再让模型自查一遍（只给一次改正机会）。
 * 任何一关不过，都把**具体问题清单**回传给模型重试——
 * 模型"看着错误改"的成功率，远高于笼统地重试一次。
 */
async function runGeneration<T>(
  kernel: SceneKernel<T>,
  prompt: string,
  onProgress?: ProgressFn,
  onIssues?: IssuesFn,
): Promise<T> {
  if (!getApiKey()) {
    throw new Error(
      '还没有填 API Key。在下方输入框填入 DeepSeek Key（sk- 开头），它只保存在你的浏览器里。',
    );
  }

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: kernel.systemPrompt() },
    { role: 'user', content: prompt },
  ];
  // 证明复核给最多 2 次修正机会（复核有自检撤回误报，但仍防无限打回）。
  // 真实案例：模型连续两轮把 DF 用 tan30° 算成 2.89（正确 sin30°=2.5），
  // 只给 1 次机会时第二轮的错误直接放行——数值类错误多给一轮通常能改对。
  let proofRetries = 0;
  // 上一轮数值体检的错误签名（原地打转检测用）
  let lastErrorsSig = '';

  /**
   * 放行 + 证明复核（正常通过和程序代改通过走同一条路）。
   * 返回 null 表示复核发现问题且已排好重试消息，外层 continue 下一轮。
   */
  const acceptAndReview = async (
    accepted: T,
    warns: Issue[],
    passMsg: string,
    attempt: number,
    lastText: string,
  ): Promise<T | null> => {
    onProgress?.(passMsg);
    for (const w of warns) onProgress?.(`   ⚠ 提醒：${w.where}：${w.message}`);

    // 第三道关：证明复核（只读文字判断，数值体检管不到）
    const steps = kernel.stepsOf(accepted);
    if (steps && steps.length > 0) {
      onProgress?.('→ 正在复核分步讲解的数学正确性……');
      const stepsText = steps.map((s, i) => `第${i + 1}步（${s.title}）：${s.text}`).join('\n');
      const review = await reviewProof(prompt, stepsText, kernel.facts(accepted));
      // 自检撤回的误报也打出来——让你看见"这条质疑被判定为误报"
      for (const w of review.withdrawn) {
        onProgress?.(`   ↩ 已撤回误报：${w}`);
      }
      if (!review.ok) {
        onProgress?.(`✗ 证明复核发现问题（${review.problems.length} 处）：`);
        for (const p of review.problems) onProgress?.(`   · ${p}`);

        // 还有修正名额就打回重做
        if (proofRetries < 2 && attempt < MAX_ATTEMPTS) {
          proofRetries++;
          messages.push({ role: 'assistant', content: lastText });
          messages.push({
            role: 'user',
            content:
              `你输出的 JSON 格式与数值都没问题，但分步讲解的数学内容被复核判定有误：\n${review.problems
                .map((p) => `- ${p}`)
                .join('\n')}\n请修正 steps 里的推理（不要改图形结构），重新输出完整 JSON。`,
          });
          onIssues?.(
            review.problems.map((p) => ({ level: 'error' as const, where: 'steps', message: p })),
          );
          return null;
        }

        // 已重试过：放行，但把疑点降级为提醒留在报告里，由你人工核对
        onProgress?.('   （复核只给一次修正机会，放行并在报告里保留疑点）');
        onIssues?.([
          ...warns,
          ...review.problems.map((p) => ({ level: 'warn' as const, where: 'steps', message: p })),
        ]);
        return accepted;
      }
      onProgress?.('✓ 证明复核通过');
    }

    onIssues?.(warns);
    return accepted;
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onProgress?.(
      attempt === 1
        ? `→ 正在调用模型（${kernel.label}场景）……`
        : `→ 第 ${attempt} 次尝试（已回传错误重试）……`,
    );
    const text = await callChat(messages, onProgress);
    const json = extractJson(text);
    const result = kernel.parse(json);

    if (!result.ok) {
      onProgress?.(`✗ 格式校验失败（${result.errors.length} 处）：`);
      for (const err of result.errors) onProgress?.(`   · ${err}`);
      // 把模型原始输出的开头打出来——排查"它到底输出了什么"全靠这行
      onProgress?.(`   原始输出片段：${text.slice(0, 150).replace(/\n/g, ' ')}`);

      if (attempt < MAX_ATTEMPTS) {
        // 关键一步：把模型的输出和错误列表一起放回对话，让它看着改
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content:
            `你输出的 JSON 有以下问题：\n${result.errors
              .map((e) => `- ${e}`)
              .join('\n')}\n请重新输出修正后的完整 JSON，仍然只输出 JSON 本身。`,
        });
      }
      continue;
    }

    const scene = result.scene;
    // 第二道关：数值体检（格式对了，数学上未必对）
    const issues = kernel.verify(scene);
    const errors = issues.filter((i) => i.level === 'error');
    const warns = issues.filter((i) => i.level === 'warn');

    if (errors.length > 0) {
      onProgress?.(`✗ 数值体检未通过（${errors.length} 处）：`);
      for (const e of errors) onProgress?.(`   · ${e.where}：${e.message}`);
      if (warns.length > 0) {
        onProgress?.(`   （另有 ${warns.length} 条提醒，一并回传）`);
      }
      // 被打回的这轮也把报告抛给 UI——用户能看见"模型第几次错在哪"
      onIssues?.(issues);

      // 原地打转检测：模型连续两轮输出**完全相同**的错误集合，说明它
      // 在照抄自己——继续重试只是烧调用（实测第 2、3 轮一字不差，还烧出 429）。
      // 提前止损，把"换种描述"的建议直接给用户。
      const errSig = errors.map((e) => `${e.where}|${e.message}`).join('\n');
      if (errSig === lastErrorsSig) {
        throw new Error(
          `模型连续两轮输出完全相同的错误（在原地打转），已提前停止以免继续浪费调用：\n` +
            `${formatIssues(errors)}\n` +
            `建议：换一种描述再试——把关键点（交点、分点）在题面里的来历写得更明确，` +
            `或把题目原文贴全。`,
        );
      }
      lastErrorsSig = errSig;

      // 优先程序代改：体检错误里有一类是程序自己已经算出正确答案的
      // （截面边数、延长线交点、写反的比值），退回模型等于让它"抄答案"，
      // 实测抄不对还烧调用（连续 3 轮裁在同一批错上 → 429）。
      // 这里先用程序修，修完重新体检，过了就直接放行——一次模型调用都不花。
      if (kernel.autoFix) {
        const fixed = kernel.autoFix(scene);
        if (fixed.fixes.length > 0) {
          const issues2 = kernel.verify(fixed.scene);
          const errors2 = issues2.filter((i) => i.level === 'error');
          if (errors2.length === 0) {
            onProgress?.(`🔧 程序代改了 ${fixed.fixes.length} 处（没有调用模型）：`);
            for (const f of fixed.fixes) onProgress?.(`   · ${f}`);
            const res = await acceptAndReview(
              fixed.scene,
              issues2.filter((i) => i.level === 'warn'),
              '✓ 代改后通过校验与数值体检',
              attempt,
              text,
            );
            if (res) return res;
            continue;
          }
          // 部分修好：以代改稿为基底回传，只让模型修剩余问题。
          // 教训（2026-11-06 实测）：把代改结果整个丢掉、让模型从零重写，
          // 它会把已修好的（写反的比值）又写错——第 2、3 轮错误一字不差，
          // 原地打转。基底换成代改稿后，修好的部分不会反弹。
          onProgress?.(
            `   （程序代改了 ${fixed.fixes.length} 处，还剩 ${errors2.length} 处修不动——以代改稿为基底回传模型）`,
          );
          for (const f of fixed.fixes) onProgress?.(`      · 已代改：${f}`);
          if (attempt < MAX_ATTEMPTS) {
            messages.push({ role: 'assistant', content: JSON.stringify(fixed.scene) });
            messages.push({
              role: 'user',
              content:
                `上面的 JSON 已由程序代改了 ${fixed.fixes.length} 处（不要改动这些地方）：\n` +
                `${fixed.fixes.map((f) => `- ${f}`).join('\n')}\n` +
                `数值体检仍发现以下 ${errors2.length} 处程序修不动的问题，请只修这几处，` +
                `其余内容保持原样，重新输出完整 JSON：\n${formatIssues(errors2)}`,
            });
            continue;
          }
        }
      }

      if (attempt < MAX_ATTEMPTS) {
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content:
            `你输出的 JSON 格式合法，但数值体检发现以下问题（坐标或公式算不出有效数字，或几何关系不成立）：
${formatIssues(issues)}
请重新输出修正后的完整 JSON，仍然只输出 JSON 本身。`,
        });
        continue;
      }

      // 唯一的错是"说要画图却一个对象都没画"：别把整次生成丢掉。
      // steps 是好的，把场景降级成推导板书照样能用——空白坐标轴才是最糟的结果。
      if (errors.every((e) => e.where === 'visual')) {
        onProgress?.('✓ 本题没有可对应的图形，已改用推导板书');
        onIssues?.(warns);
        return { ...scene, visual: 'board', objects: [] };
      }

      throw new Error(`连续 ${MAX_ATTEMPTS} 次未通过数值体检：\n${formatIssues(errors)}`);
    }

    // error 清零 = 放行。warn 不拦截，但报告照样抛给 UI 展示。
    // （放行 + 证明复核抽成了 acceptAndReview，正常通过和程序代改共用一条路）
    const res = await acceptAndReview(
      scene,
      warns,
      attempt === 1 ? '✓ 一次通过校验与数值体检' : `✓ 第 ${attempt} 次通过校验与数值体检`,
      attempt,
      text,
    );
    if (res) return res;
    continue;
  }

  throw new Error(`连续 ${MAX_ATTEMPTS} 次都未通过校验，请换一种描述再试。`);
}

/** 主入口（平面）：自然语言 → Scene */
export async function requestSceneFromPrompt(
  prompt: string,
  onProgress?: ProgressFn,
  onIssues?: IssuesFn,
): Promise<Scene> {
  return runGeneration(KERNEL_2D, prompt, onProgress, onIssues);
}

/** 主入口（立体几何）：自然语言 → Scene3D */
export async function requestSceneFromPrompt3D(
  prompt: string,
  onProgress?: ProgressFn,
  onIssues?: IssuesFn,
): Promise<Scene3D> {
  return runGeneration(KERNEL_3D, prompt, onProgress, onIssues);
}
