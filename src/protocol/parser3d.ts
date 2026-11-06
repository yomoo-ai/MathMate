/**
 * parser3d.ts —— 三维场景的格式关（与 parser.ts 平行）
 *
 * 只回答一个问题：**这份 JSON 能不能交给 3D 渲染器**。
 * 数学对不对不归它管（那是 verifier3d 的活）。
 *
 * 分层和 2D 完全一致，这样做的好处是流水线可以一套代码跑两种场景：
 *   JSON 文本 → parseScene3D（格式） → verifyScene3D（数值） → 渲染
 */

import type { Scene3D, Scene3DObject } from './scene3d';
import { resolveScene3D } from './resolve3d';
import { normalizeExpr, splitTopLevel } from './expr';

export type ParseResult3D =
  | { ok: true; scene: Scene3D }
  | { ok: false; errors: string[] };

const OBJECT_TYPES_3D = [
  'point3',
  'edge3',
  'face3',
  'cylinder3',
  'cone3',
  'sphere3',
  'section3',
];
const DERIVE_KINDS = ['midpoint', 'intersect', 'centroid', 'section', 'foot', 'circumcenter', 'incenter'];

/** 点引用能不能用（顶点 id 字符串，或 "x, y, z" 坐标） */
function pointRefProblem(v: unknown, field: string): string | null {
  if (Array.isArray(v)) {
    return v.length === 3 ? null : `${field} 的坐标数组应有 3 个元素，实际 ${v.length} 个`;
  }
  if (typeof v === 'string' && v.trim() !== '') return null;
  return `${field} 必须是顶点 id 字符串（如 "O"）或 "x, y, z" 坐标`;
}

/** 长度类字段（半径）：一段可求值的数字或表达式 */
function scalarProblem(v: unknown, field: string): string | null {
  if (typeof v === 'number' && isFinite(v)) return null;
  if (typeof v === 'string') {
    if (v.trim() === '') return `${field} 是空字符串`;
    // 判"是不是坐标"不能只看有没有逗号：
    // 函数调用 circumR3(A,B,C,V) 里的逗号是**参数分隔符**，写的是表达式不是坐标。
    // 只看顶层逗号是否正好把字符串拆成 3 段——这才是 "x, y, z" 的特征。
    const looksLikeCoord =
      !v.includes('(') &&
      splitTopLevel(normalizeExpr(v)).filter((s) => s.trim() !== '').length === 3;
    if (looksLikeCoord) {
      return `${field} 是一段数字或表达式（如 "r"、"a/2"、"circumR3(A,B,C,V)"），不是坐标——不要写成 "x, y, z"`;
    }
    return null;
  }
  return `${field} 必须是数字或表达式字符串`;
}

/** 坐标字段能不能拆成三段 */
function vec3Problem(v: unknown): string | null {
  if (Array.isArray(v)) {
    return v.length === 3 ? null : `坐标数组应有 3 个元素（x, y, z），实际 ${v.length} 个`;
  }
  if (typeof v === 'string') {
    const n = splitTopLevel(normalizeExpr(v))
      .map((s) => s.trim())
      .filter((s) => s.length > 0).length;
    return n === 3 ? null : `坐标字符串「${v}」按逗号拆出 ${n} 段（应为 3 段：x, y, z）`;
  }
  return '必须是 "x, y, z" 字符串或 [x, y, z] 数组';
}

export function parseScene3D(input: string): ParseResult3D {
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

  if (!data.meta || typeof data.meta.title !== 'string') {
    errors.push('缺少 meta.title（场景标题，字符串）');
  }

  if (data.params !== undefined && !Array.isArray(data.params)) {
    errors.push('params 必须是数组');
  }

  // space：允许模型漏写，只要对象类型是三维的就按 3D 处理。
  // （漏写一个判别字段就打回重做，是没必要浪费的一次调用）
  if (data.space !== undefined) {
    const s = String(data.space).toLowerCase();
    if (s !== '3d') {
      errors.push(`space 必须是 "3d"（立体几何场景），实际是 "${data.space}"`);
    }
  }

  if (!Array.isArray(data.objects)) {
    errors.push('objects 必须是数组');
  } else {
    data.objects.forEach((o: any, i: number) => {
      if (!o || typeof o !== 'object') {
        errors.push(`objects[${i}] 不是对象`);
        return;
      }
      if (typeof o.id !== 'string' || o.id.trim() === '') {
        errors.push(`objects[${i}] 缺少 id（字符串，唯一）`);
      }
      if (!OBJECT_TYPES_3D.includes(o.type)) {
        errors.push(
          `objects[${i}] 未知类型 "${o.type}"，立体场景只允许：${OBJECT_TYPES_3D.join('/')}`,
        );
        return;
      }

      switch (o.type) {
        case 'point3': {
          if (o.derive !== undefined) {
            const d = o.derive;
            if (!d || typeof d !== 'object' || !DERIVE_KINDS.includes(d.kind)) {
              errors.push(
                `objects[${i}]（point3）的 derive.kind 必须是 ${DERIVE_KINDS.join(' / ')}，` +
                  `例如 {"kind":"midpoint","a":"A","b":"B"}`,
              );
              return;
            }
            const bad =
              (d.kind === 'midpoint' && (typeof d.a !== 'string' || typeof d.b !== 'string')) ||
              (d.kind === 'intersect' &&
                (!Array.isArray(d.l1) ||
                  d.l1.length !== 2 ||
                  !Array.isArray(d.l2) ||
                  d.l2.length !== 2)) ||
              (d.kind === 'centroid' &&
                (!Array.isArray(d.points) || d.points.length !== 3)) ||
              ((d.kind === 'circumcenter' || d.kind === 'incenter') &&
                (!Array.isArray(d.points) || d.points.length !== 4)) ||
              (d.kind === 'section' &&
                (typeof d.a !== 'string' ||
                  typeof d.b !== 'string' ||
                  (typeof d.t !== 'number' && typeof d.t !== 'string'))) ||
              (d.kind === 'foot' &&
                (typeof d.p !== 'string' || !Array.isArray(d.line) || d.line.length !== 2));
            if (bad) {
              errors.push(
                `objects[${i}]（point3）的 derive 缺少必要字段：midpoint 要 a/b，` +
                  `intersect 要 l1[2] 和 l2[2]（两条直线各两个端点），` +
                  `centroid 要 points[3]，circumcenter/incenter 要 points[4]，` +
                  `section 要 a/b/t，foot 要 p 和 line[2]`,
              );
            }
          } else if (o.at === undefined) {
            errors.push(
              `objects[${i}]（point3）要么给 at（"x, y, z"），要么给 derive（让程序算）`,
            );
          } else {
            const prob = vec3Problem(o.at);
            if (prob) errors.push(`objects[${i}]（point3）的 at：${prob}`);
          }
          break;
        }
        case 'edge3': {
          if (typeof o.a !== 'string' || typeof o.b !== 'string') {
            errors.push(
              `objects[${i}]（edge3）的 a、b 必须是**顶点 id 字符串**（如 "A"、"B1"），不是坐标`,
            );
          } else if (o.a === o.b) {
            errors.push(`objects[${i}]（edge3）的 a 和 b 是同一个点「${o.a}」，棱长为 0`);
          }
          if (o.dashed !== undefined && typeof o.dashed !== 'boolean') {
            errors.push(`objects[${i}]（edge3）的 dashed 只能是 true / false`);
          }
          break;
        }
        case 'face3': {
          if (!Array.isArray(o.points) || o.points.length < 3) {
            errors.push(
              `objects[${i}]（face3）的 points 必须是至少 3 个顶点 id 的数组（如 ["A","B","C","D"]）`,
            );
          } else if (!o.points.every((x: any) => typeof x === 'string')) {
            errors.push(`objects[${i}]（face3）的 points 里必须全是顶点 id 字符串`);
          }
          break;
        }
        case 'cylinder3': {
          // 圆柱 = 两个轴端点 + 半径。这里最容易犯的错是把"高"和"半径"写成两个数字，
          // 报错必须示范正确写法，否则模型会在同一个格式上反复撞墙。
          for (const f of ['a', 'b'] as const) {
            const prob = pointRefProblem(o[f], `objects[${i}]（cylinder3）的 ${f}`);
            if (prob) {
              errors.push(
                `${prob}。圆柱写成 {"type":"cylinder3","a":"O","b":"O1","radius":"r"}：` +
                  `a、b 是两个底面圆心（下、上），不是半径或 height`,
              );
            }
          }
          const rp = scalarProblem(o.radius, `objects[${i}]（cylinder3）的 radius`);
          if (rp) errors.push(rp);
          break;
        }
        case 'cone3': {
          for (const f of ['apex', 'base'] as const) {
            const prob = pointRefProblem(o[f], `objects[${i}]（cone3）的 ${f}`);
            if (prob) {
              errors.push(
                `${prob}。圆锥写成 {"type":"cone3","apex":"P","base":"O","radius":"r"}：` +
                  `apex 是锥尖，base 是底面圆心`,
              );
            }
          }
          const rp = scalarProblem(o.radius, `objects[${i}]（cone3）的 radius`);
          if (rp) errors.push(rp);
          break;
        }
        case 'sphere3': {
          const prob = pointRefProblem(o.center, `objects[${i}]（sphere3）的 center`);
          if (prob) {
            errors.push(
              `${prob}。球写成 {"type":"sphere3","center":"O","radius":"r"}：` +
                `center 是球心（顶点 id 或坐标）`,
            );
          }
          const rp = scalarProblem(o.radius, `objects[${i}]（sphere3）的 radius`);
          if (rp) errors.push(rp);
          break;
        }
        case 'section3': {
          // 截面 = 切谁 + 平面在哪。两种定平面写法二选一：
          //   plane: [P, Q, R]（三个点）或 p + normal（一点 + 法向量）。
          if (typeof o.cut === 'string') {
            if (o.cut.trim() === '') {
              errors.push(
                `objects[${i}]（section3）的 cut 是空字符串——写被切的旋转体 id（如 "cyl"）` +
                  `或多面体的顶点集合 {"vertices":["A","B","C","A1"]}`,
              );
            }
          } else if (o.cut && typeof o.cut === 'object') {
            const cut = o.cut as { vertices?: unknown; faces?: unknown };
            if (!Array.isArray(cut.vertices) || cut.vertices.length < 4) {
              errors.push(
                `objects[${i}]（section3）切多面体时 cut.vertices 要列出全部顶点（至少 4 个），` +
                  `例如 {"cut":{"vertices":["A","B","C","D","A1","B1","C1","D1"]}}`,
              );
            } else if (cut.vertices.some((v) => typeof v !== 'string' || v.trim() === '')) {
              errors.push(
                `objects[${i}]（section3）的 cut.vertices 只能写顶点 id（字符串），不要写坐标`,
              );
            }
            if (cut.faces !== undefined) {
              const fs = cut.faces;
              if (!Array.isArray(fs) || fs.some((f) => !Array.isArray(f) || f.length < 3)) {
                errors.push(
                  `objects[${i}]（section3）的 cut.faces 要是"面的数组"，每个面至少 3 个顶点 id，` +
                    `例如 [[\"A\",\"B\",\"B1\",\"A1\"], …]`,
                );
              }
            }
          } else {
            errors.push(
              `objects[${i}]（section3）的 cut 只有两种写法：` +
                `旋转体写对象 id（"cut":"cyl"），多面体写 {"cut":{"vertices":["A","B","C","A1"]}}`,
            );
          }
          const hasPlane = Array.isArray(o.plane);
          const hasPN = o.p !== undefined || o.normal !== undefined;
          if (hasPlane && hasPN) {
            errors.push(
              `objects[${i}]（section3）的 plane 和 p/normal 只能二选一，不要都写`,
            );
          } else if (hasPlane) {
            if (o.plane.length !== 3) {
              errors.push(
                `objects[${i}]（section3）的 plane 应有 3 个点（三点定一面），实际 ${o.plane.length} 个`,
              );
            } else {
              o.plane.forEach((ref: unknown, k: number) => {
                const prob = pointRefProblem(ref, `objects[${i}]（section3）的 plane[${k}]`);
                if (prob) errors.push(prob);
              });
            }
          } else if (hasPN) {
            const prob = pointRefProblem(o.p, `objects[${i}]（section3）的 p`);
            if (prob) errors.push(prob);
            const np = vec3Problem(o.normal);
            if (np) {
              errors.push(
                `objects[${i}]（section3）的 normal：${np}。法向量写三个数或表达式，` +
                  `如 [1, 0, "sqrt(3)"] 或 "1, 0, sqrt(3)"（不必单位化）`,
              );
            }
          } else {
            errors.push(
              `objects[${i}]（section3）缺平面：要么给 plane（三个点的数组），` +
                `要么给 p + normal（一个点加法向量）`,
            );
          }
          if (o.opacity !== undefined && (typeof o.opacity !== 'number' || o.opacity < 0 || o.opacity > 1)) {
            errors.push(`objects[${i}]（section3）的 opacity 必须是 0~1 的数字`);
          }
          break;
        }
      }
    });
  }

  // camera：可选；给了的字段必须是有限数字
  if (data.camera !== undefined) {
    if (!data.camera || typeof data.camera !== 'object') {
      errors.push('camera 必须是对象，如 { "azimuth": 35, "elevation": 18 }');
    } else {
      for (const k of ['azimuth', 'elevation', 'fov', 'distance']) {
        const v = data.camera[k];
        if (v !== undefined && (typeof v !== 'number' || !isFinite(v))) {
          errors.push(`camera.${k} 必须是有限数字`);
        }
      }
    }
  }

  if (Array.isArray(data.readouts)) {
    data.readouts.forEach((r: any, i: number) => {
      if (!r || typeof r.expr !== 'string') {
        errors.push(`readouts[${i}] 的 expr 必须是字符串（立体用 dist3/angle3/area3）`);
      }
    });
  }

  if (data.steps !== undefined) {
    if (!Array.isArray(data.steps)) {
      errors.push('steps 必须是数组');
    } else {
      data.steps.forEach((s: any, i: number) => {
        if (!s || typeof s !== 'object') {
          errors.push(`steps[${i}] 不是对象`);
          return;
        }
        if (typeof s.title !== 'string') errors.push(`steps[${i}] 缺少 title（字符串）`);
        if (typeof s.text !== 'string') errors.push(`steps[${i}] 缺少 text（字符串）`);
        for (const f of ['highlight', 'reveal'] as const) {
          if (
            s[f] !== undefined &&
            !(Array.isArray(s[f]) && s[f].every((x: any) => typeof x === 'string'))
          ) {
            errors.push(`steps[${i}] 的 ${f} 必须是对象 id 字符串数组`);
          }
        }
      });
    }
  }

  if (data.constraints !== undefined && !Array.isArray(data.constraints)) {
    errors.push('constraints 必须是数组（每项是一条立体几何关系声明）');
  }

  if (errors.length > 0) return { ok: false, errors };

  const scene: Scene3D = {
    space: '3d',
    meta: {
      title: data.meta.title,
      subtitle: typeof data.meta.subtitle === 'string' ? data.meta.subtitle : undefined,
    },
    params: Array.isArray(data.params) ? data.params : [],
    objects: data.objects as Scene3DObject[],
    camera: data.camera,
    readouts: Array.isArray(data.readouts) ? data.readouts : [],
    steps: Array.isArray(data.steps) ? data.steps : undefined,
    constraints: Array.isArray(data.constraints) ? data.constraints : undefined,
  };
  return { ok: true, scene: resolveScene3D(scene) };
}
