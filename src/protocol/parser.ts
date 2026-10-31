/**
 * parser.ts —— 把 JSON 字符串解析成 Scene（带校验）
 *
 * 这是将来接 LLM 的关键一环：
 *   模型输出文本 → parseScene 校验 → 通过则渲染，不通过则把错误列表
 *   回传给模型让它重试（见 README「接入 LLM」一节）。
 *
 * 为什么需要它：LLM 输出的 JSON 常有小毛病——少个字段、多个逗号、
 * 自创对象类型。解析器负责把这些挡在渲染之前。
 */

import type { Scene } from './scene';
import { resolveScene } from './resolve';

export type ParseResult =
  | { ok: true; scene: Scene }
  | { ok: false; errors: string[] };

const OBJECT_TYPES = [
  'point',
  'segment',
  'vector',
  'polygon',
  'circle',
  'arc',
  'curve',
  'parametric',
];

export function parseScene(input: string): ParseResult {
  const errors: string[] = [];

  let data: any;
  try {
    data = JSON.parse(input);
  } catch (e) {
    return { ok: false, errors: [`不是合法的 JSON：${(e as Error).message}`] };
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['顶层必须是一个 JSON 对象'] };
  }

  // meta
  if (!data.meta || typeof data.meta.title !== 'string') {
    errors.push('缺少 meta.title（场景标题，字符串）');
  }

  // view
  const view = data.view;
  if (
    !view ||
    !['xMin', 'xMax', 'yMin', 'yMax'].every(
      (k) => typeof view[k] === 'number' && isFinite(view[k]),
    )
  ) {
    errors.push('view 需要 xMin/xMax/yMin/yMax 四个有限数字');
  }

  // params
  if (data.params !== undefined && !Array.isArray(data.params)) {
    errors.push('params 必须是数组');
  }

  // objects
  if (!Array.isArray(data.objects)) {
    errors.push('objects 必须是数组');
  } else {
    data.objects.forEach((o: any, i: number) => {
      if (!o || typeof o !== 'object') {
        errors.push(`objects[${i}] 不是对象`);
        return;
      }
      if (typeof o.id !== 'string') {
        errors.push(`objects[${i}] 缺少 id（字符串）`);
      }
      if (!OBJECT_TYPES.includes(o.type)) {
        errors.push(`objects[${i}] 未知类型 "${o.type}"，可选：${OBJECT_TYPES.join('/')}`);
        return;
      }
      // ---- 按类型检查关键字段（表达式字段必须是字符串，否则求值器会崩）----
      const needVec2 = (field: string) => {
        const v = o[field];
        const ok =
          (Array.isArray(v) && v.length === 2) || typeof v === 'string';
        if (!ok) {
          errors.push(
            `objects[${i}]（${o.type}）的 ${field} 必须是 "表达式, 表达式" 字符串或 [x, y] 数组`,
          );
        }
      };
      switch (o.type) {
        case 'point':
          // 点有两写法：手写坐标（at），或声明几何关系让程序算（derive）
          if (o.derive !== undefined) {
            const d = o.derive;
            const kinds = ['midpoint', 'foot', 'intersect', 'section'];
            if (!d || typeof d !== 'object' || !kinds.includes(d.kind)) {
              errors.push(
                `objects[${i}]（point）的 derive.kind 必须是 ${kinds.join(' / ')}，例如 {"kind":"midpoint","a":"C","b":"E"}`,
              );
            } else if (
              (d.kind === 'midpoint' &&
                (typeof d.a !== 'string' || typeof d.b !== 'string')) ||
              (d.kind === 'foot' &&
                (typeof d.p !== 'string' ||
                  !Array.isArray(d.line) ||
                  d.line.length !== 2)) ||
              (d.kind === 'intersect' &&
                (!Array.isArray(d.l1) ||
                  !Array.isArray(d.l2) ||
                  d.l1.length !== 2 ||
                  d.l2.length !== 2)) ||
              (d.kind === 'section' &&
                (typeof d.a !== 'string' ||
                  typeof d.b !== 'string' ||
                  (typeof d.t !== 'number' && typeof d.t !== 'string')))
            ) {
              errors.push(
                `objects[${i}]（point）的 derive 缺少必要的点 id：midpoint 要 a/b，foot 要 p 和 line[2]，intersect 要 l1[2] 和 l2[2]，section 要 a/b/t`,
              );
            }
          } else {
            needVec2('at');
          }
          break;
        case 'segment':
        case 'vector':
          needVec2('from');
          needVec2('to');
          break;
        case 'polygon':
          if (!Array.isArray(o.points)) {
            errors.push(`objects[${i}]（polygon）的 points 必须是坐标数组`);
          }
          break;
        case 'circle':
        case 'arc':
          needVec2('center');
          if (typeof o.radius !== 'string') {
            errors.push(`objects[${i}]（${o.type}）的 radius 必须是表达式字符串`);
          }
          break;
        case 'curve':
          if (typeof o.expr !== 'string') {
            errors.push(
              `objects[${i}]（curve）的 expr 必须是字符串，例如 "a*(x-h)^2+k"，不要写成数组或对象`,
            );
          }
          if (o.domain !== undefined) {
            const ok =
              Array.isArray(o.domain) &&
              o.domain.length === 2 &&
              o.domain.every(
                (d: any) => typeof d === 'string' || typeof d === 'number',
              );
            if (!ok) {
              errors.push(
                `objects[${i}]（curve）的 domain 必须是 [起始x, 终止x]（两个数字或字符串），不要写成其他形式`,
              );
            }
          }
          break;
        case 'parametric':
          if (typeof o.xExpr !== 'string' || typeof o.yExpr !== 'string') {
            errors.push(
              `objects[${i}]（parametric）的 xExpr 和 yExpr 都必须是字符串，例如 xExpr: "16*sin(t)^3"`,
            );
          }
          if (
            o.tRange !== undefined &&
            !(
              Array.isArray(o.tRange) &&
              o.tRange.length === 2 &&
              o.tRange.every(
                (d: any) => typeof d === 'string' || typeof d === 'number',
              )
            )
          ) {
            errors.push(
              `objects[${i}]（parametric）的 tRange 必须是 [起始t, 终止t]（两个数字或字符串）`,
            );
          }
          break;
      }
    });
  }

  // readouts 的 expr 也必须是字符串（readouts 求值失败只是显示 —，但提前拦下更好）
  if (Array.isArray(data.readouts)) {
    data.readouts.forEach((r: any, i: number) => {
      if (!r || typeof r.expr !== 'string') {
        errors.push(`readouts[${i}] 的 expr 必须是字符串`);
      }
    });
  }

  // steps：分步讲解。title/text 必须是字符串，highlight/reveal 必须是字符串数组
  if (data.steps !== undefined) {
    if (!Array.isArray(data.steps)) {
      errors.push('steps 必须是数组');
    } else {
      data.steps.forEach((s: any, i: number) => {
        if (!s || typeof s !== 'object') {
          errors.push(`steps[${i}] 不是对象`);
          return;
        }
        if (typeof s.title !== 'string') {
          errors.push(`steps[${i}] 缺少 title（字符串）`);
        }
        if (typeof s.text !== 'string') {
          errors.push(`steps[${i}] 缺少 text（字符串）`);
        }
        for (const f of ['highlight', 'reveal'] as const) {
          if (
            s[f] !== undefined &&
            !(
              Array.isArray(s[f]) && s[f].every((x: any) => typeof x === 'string')
            )
          ) {
            errors.push(`steps[${i}] 的 ${f} 必须是对象 id 字符串数组`);
          }
        }
      });
    }
  }

  // constraints：几何关系声明。这里只查"是不是数组"，
  // 每条约束的类型是否认识、引用的点是否存在，交给体检器（错了只提醒不拦截）
  if (data.constraints !== undefined && !Array.isArray(data.constraints)) {
    errors.push('constraints 必须是数组（每项是一条几何关系声明）');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const scene: Scene = {
    meta: {
      title: data.meta.title,
      subtitle:
        typeof data.meta.subtitle === 'string' ? data.meta.subtitle : undefined,
    },
    view: {
      xMin: data.view.xMin,
      xMax: data.view.xMax,
      yMin: data.view.yMin,
      yMax: data.view.yMax,
    },
    params: Array.isArray(data.params) ? data.params : [],
    objects: data.objects,
    readouts: Array.isArray(data.readouts) ? data.readouts : [],
    steps: Array.isArray(data.steps) ? data.steps : undefined,
    constraints: Array.isArray(data.constraints) ? data.constraints : undefined,
  };
  // 补全：解出派生点坐标、把 "from": "A" 这类点 id 引用换成坐标表达式。
  // 放在校验之后、返回之前——渲染器和体检器拿到的永远是"坐标齐全"的场景。
  return { ok: true, scene: resolveScene(scene) };
}
