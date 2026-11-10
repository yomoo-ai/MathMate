/**
 * verifier3d.ts —— 三维场景的数值体检器（与 verifier.ts 平行）
 *
 * 它回答的问题和 2D 版一样：**这份场景的数学能不能站住**。
 * 但立体几何有三类 2D 完全没有的错误，这里必须点名：
 *
 *   ① 所有顶点共面 —— 最常见的事故。模型忘了给 z，
 *      输出一堆 (x, y, 0)，渲染出来是一张"平面图"，用户以为是假的 3D。
 *   ② 两个顶点重合 —— 手写坐标时复制粘贴忘了改，图上少一个角。
 *   ③ 面退化 / 面漏声明 —— 面决定"哪条棱被挡住"，
 *      漏一个面，遮挡判断就会把背面的棱画成实线，整张图废掉。
 *
 * 另外把题面给的几何关系（constraints）逐条验算：
 * 不成立就报「实测值 + 怎么改」，让模型看着数字改坐标。
 */

import type {
  Constraint3,
  Curved3Object,
  Face3Object,
  Point3Object,
  PointRef,
  Scene3D,
  Scene3DObject,
  Section3Object,
} from './scene3d';
import { isCurved3 } from './scene3d';
import {
  buildPolySpec,
  solveSectionOn,
  type PlaneSpec,
  type SectionTarget,
  type SolidSpec,
} from './sectionMath';
import {
  evalAny,
  evalNumber,
  evalVec3Detailed,
  normalizeExpr,
  unknownNames,
  type Scope,
} from './expr';
import { evalPointRef } from './resolve3d';
import { foldAngleFrom, planFold } from './fold3d';
import type { Issue } from './verifier';

type V3 = [number, number, number];

/** 角度容差（度）：和 2D 一致 */
const ANG_TOL = 0.05;
/** 相对容差：长度、距离类 */
const REL_TOL = 1e-3;
/**
 * 结构性容差（重合、共线、共面）：只放过浮点误差，不放过"差不多"。
 * 用 1e-6 而不是 1e-9 是因为"共面/共线"经常由表达式算出（中点、垂足），
 * 浮点误差到 1e-9 量级很正常；而真正的构造错误至少在 1e-2 量级。
 */
const TIGHT = 1e-6;

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const dist3 = (a: V3, b: V3) => len3(sub3(a, b));

/** 两个方向向量的夹角（度）；向量长度为 0 时返回 0，交给别处报错 */
function angleBetween3(u: V3, v: V3): number {
  const lu = len3(u);
  const lv = len3(v);
  if (lu < 1e-12 || lv < 1e-12) return 0;
  const c = dot3(u, v) / (lu * lv);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** 点 P 到直线 AB 的距离 */
function distToLine3(p: V3, a: V3, b: V3): number {
  const ab = sub3(b, a);
  const ap = sub3(p, a);
  const l = len3(ab);
  if (l < 1e-12) return dist3(p, a);
  return len3(cross3(ap, ab)) / l;
}

/** 点 P 到平面 ABC 的距离 */
function distToPlane3(p: V3, a: V3, b: V3, c: V3): number {
  const n = cross3(sub3(b, a), sub3(c, a));
  const ln = len3(n);
  if (ln < 1e-12) return NaN;
  return Math.abs(dot3(sub3(p, a), n)) / ln;
}

const fmtV = (v: V3) => `(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})`;
const fmtN = (n: number) => (Math.abs(n) < 1e-9 ? '0' : n.toFixed(2));

function defaultScope(scene: Scene3D): Record<string, number> {
  const scope: Record<string, number> = {};
  for (const p of scene.params) scope[p.name] = p.value;
  return scope;
}

function unknownHint(expr: string, scope: Scope): string {
  const names = unknownNames(expr, scope);
  if (names.length === 0) return '';
  return `；表达式里出现了未定义的名称 ${names.join('、')}（没登记在 params 里）`;
}

// ---------------------------------------------------------------
// 结构性检查：顶点、棱、面
// ---------------------------------------------------------------

/** 收集所有能算出坐标的顶点；算不出来的单独报错 */
function collectPoints(scene: Scene3D, scope: Record<string, number>): {
  pts: Map<string, V3>;
  issues: Issue[];
} {
  const pts = new Map<string, V3>();
  const issues: Issue[] = [];
  const seen = new Set<string>();

  for (const obj of scene.objects) {
    if (obj.type !== 'point3') continue;
    if (seen.has(obj.id)) {
      issues.push({ level: 'error', where: obj.id, message: `顶点 id「${obj.id}」重复了` });
    }
    seen.add(obj.id);

    const r = evalVec3Detailed(obj.at ?? '', scope);
    if (!r.value) {
      issues.push({
        level: 'error',
        where: obj.id,
        message:
          `顶点坐标算不出来：${r.reason}` +
          (obj.derive
            ? '（派生点：检查 derive 引用的顶点 id 是否存在、是否写成了自己的 id）'
            : ''),
      });
      continue;
    }
    pts.set(obj.id, r.value);
  }
  return { pts, issues };
}

/** 顶点两两重合 / 整体共面 —— 立体几何里这两件事都必然是构造错误 */
interface SanityResult {
  issues: Issue[];
  /**
   * 整个图形退化（所有顶点共面 / 共线）——这是**根因**。
   * 上层拿到它之后只回传这一条：顶点重合、垂直不成立、截面退化……
   * 几乎全是"图形没有厚度"的连带现象，一次报 9 条模型只会去改症状。
   */
  degenerate: Issue | null;
  /** 退化时被合并掉的同类错误条数（"顶点重合"这类），只用于报"另有 N 条" */
  suppressed: number;
}

function checkGeometrySanity(
  pts: Map<string, V3>,
  hasCurved: boolean,
  /** 允许与别的点重合的顶点（球心这类"结构点"，见下方说明） */
  allowed: Set<string>,
): SanityResult {
  const issues: Issue[] = [];
  const ids = [...pts.keys()];
  let degenerate: Issue | null = null;

  // ① 重合：全量两两比较（顶点也就几十个）
  //
  // 例外：**球心/内心可以重合**。正四面体的外心与内心就是同一个点，
  // 照原规则会报"图里少一个角"，把一张完全正确的图打回重做。
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (allowed.has(ids[i]) || allowed.has(ids[j])) continue;
      const a = pts.get(ids[i])!;
      const b = pts.get(ids[j])!;
      if (dist3(a, b) < 1e-9) {
        issues.push({
          level: 'error',
          where: ids[i],
          message:
            `顶点 ${ids[i]} 和 ${ids[j]} 坐标完全相同 ${fmtV(a)} —— 图里会少一个角。` +
            `多半是复制上一个顶点后忘了改坐标`,
        });
      }
    }
  }

  // ② 共面：找一个不平行的三点定平面，再看其余点
  //
  // 有旋转体时跳过这条：圆柱的半径、球的存在本身就说明这是真立体，
  // 而"圆心 + 轴上几个点"完全可能恰好共面（轴上的点必然共线），
  // 照原规则会误判成"假 3D"，把一张好图打回重做。
  if (ids.length >= 4 && !hasCurved) {
    let plane: [string, string, string] | null = null;
    for (let i = 0; i < ids.length && !plane; i++) {
      for (let j = i + 1; j < ids.length && !plane; j++) {
        for (let k = j + 1; k < ids.length && !plane; k++) {
          const A = pts.get(ids[i])!;
          const B = pts.get(ids[j])!;
          const C = pts.get(ids[k])!;
          if (len3(cross3(sub3(B, A), sub3(C, A))) > 1e-9) {
            plane = [ids[i], ids[j], ids[k]];
          }
        }
      }
    }

    // 连一个不共线的三点都找不出来 → 所有点都在同一条直线上（或互相重合）
    if (!plane) {
      degenerate = {
        level: 'error',
        where: 'objects',
        message:
          `所有 ${ids.length} 个顶点都在同一条直线上（或互相重合）——这不是立体图形，` +
          `画出来只会是一条线。检查坐标：底面要给 x、y 两个方向的值，` +
          `上层顶点还要给 z（如 z=h），不能所有点都只改动一个坐标`,
      };
    } else {
      const [ia, ib, ic] = plane;
      const A = pts.get(ia)!, B = pts.get(ib)!, C = pts.get(ic)!;
      const scale = Math.max(
        1,
        ...[...pts.values()].map((p) => dist3(p, A)),
      );
      let maxOff = 0;
      let worst = '';
      for (const id of ids) {
        if (id === ia || id === ib || id === ic) continue;
        const d = distToPlane3(pts.get(id)!, A, B, C);
        if (d > maxOff) {
          maxOff = d;
          worst = id;
        }
      }
      if (maxOff / scale <= TIGHT) {
        degenerate = {
          level: 'error',
          where: 'objects',
          message:
            `所有 ${ids.length} 个顶点都落在同一个平面上` +
            (worst
              ? `（最偏离的 ${worst} 也只差 ${maxOff.toFixed(4)}）`
              : `（零偏差，严格共面）`) +
            `——这不是立体图形。检查是不是漏了高度：` +
            `底面放 z=0，顶点/上层顶点要给 z（如 z=h）`,
        };
      }
    }
  }

  // 退化时真正的根因是"没有厚度"，那几条"顶点重合"多半是同一个原因造成的
  // （上层顶点照抄了底层坐标）→ 一并交给上层按根因处理，不重复报。
  if (degenerate) return { issues: [], degenerate, suppressed: issues.length };
  return { issues, degenerate: null, suppressed: 0 };
}

/** 棱：端点必须存在、不能退化成点；被面覆盖情况影响虚实判断 */
function checkEdges(scene: Scene3D, pts: Map<string, V3>): Issue[] {
  const issues: Issue[] = [];

  // 每条棱被几个面包含（决定遮挡判断走哪条路）
  const covers = new Map<string, number>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const obj of scene.objects) {
    if (obj.type !== 'face3') continue;
    const n = obj.points.length;
    for (let i = 0; i < n; i++) {
      const k = key(obj.points[i], obj.points[(i + 1) % n]);
      covers.set(k, (covers.get(k) ?? 0) + 1);
    }
  }

  const hasFaces = scene.objects.some((o) => o.type === 'face3');

  for (const obj of scene.objects) {
    if (obj.type !== 'edge3') continue;
    const A = pts.get(obj.a);
    const B = pts.get(obj.b);
    if (!A || !B) {
      const missing = !A ? obj.a : obj.b;
      issues.push({
        level: 'error',
        where: obj.id,
        message: `棱「${obj.id}」引用的顶点「${missing}」不存在（或者它的坐标算不出来）`,
      });
      continue;
    }
    const l = dist3(A, B);
    if (l < 1e-9) {
      issues.push({ level: 'error', where: obj.id, message: `棱「${obj.id}」长度为 0（两端点重合）` });
      continue;
    }
    // 有面却没人认领这条棱 → 说明某个面的 points 漏了它，虚实会算错
    if (hasFaces && (covers.get(key(obj.a, obj.b)) ?? 0) === 0 && obj.dashed === undefined) {
      issues.push({
        level: 'warn',
        where: obj.id,
        message:
          `棱 ${obj.a}${obj.b} 不属于任何面：它的虚实只能靠射线判断。` +
          `如果它本来就是几何体的棱，说明某个面的 points 漏了这一对顶点；` +
          `如果它是辅助线/体对角线，请显式写 "dashed": true`,
      });
    }
  }
  return issues;
}

/** 面：顶点必须存在、不能退化成线 */
function checkFaces(scene: Scene3D, pts: Map<string, V3>): Issue[] {
  const issues: Issue[] = [];
  for (const obj of scene.objects) {
    if (obj.type !== 'face3') continue;
    const miss = obj.points.filter((id) => !pts.has(id));
    if (miss.length > 0) {
      issues.push({
        level: 'error',
        where: obj.id,
        message: `面「${obj.id}」引用了不存在的顶点 ${miss.join('、')}`,
      });
      continue;
    }
    const coords = obj.points.map((id) => pts.get(id)!);
    // 面积：三角扇求和（和渲染器的拆法一致）
    let area = 0;
    for (let i = 1; i < coords.length - 1; i++) {
      area += len3(cross3(sub3(coords[i], coords[0]), sub3(coords[i + 1], coords[0]))) / 2;
    }
    if (area < 1e-9) {
      issues.push({
        level: 'error',
        where: obj.id,
        message: `面「${obj.id}」面积是 0（顶点共线或重合）——这个面挡不住任何棱，遮挡判断会出错`,
      });
    }
    if (obj.opacity !== undefined && (obj.opacity < 0 || obj.opacity > 1)) {
      issues.push({
        level: 'warn',
        where: obj.id,
        message: `面「${obj.id}」的 opacity=${obj.opacity} 超出 0~1，建议 0.3~0.5`,
      });
    }
  }
  return issues;
}

/** 孤立顶点：没有任何棱连到它 */
/** 一条约束里点名的所有顶点 id（各变体字段名不同，这里统一捞出来） */
function constraintPointIds(c: Constraint3): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
  };
  switch (c.type) {
    case 'equal-length':
    case 'length-ratio':
    case 'perp-lines':
    case 'parallel-lines':
      (c.a ?? []).forEach(add);
      (c.b ?? []).forEach(add);
      break;
    case 'collinear':
    case 'coplanar':
      (c.points ?? []).forEach(add);
      break;
    case 'midpoint':
      add(c.m);
      (c.ends ?? []).forEach(add);
      break;
    case 'on-segment':
      add(c.p);
      (c.ends ?? []).forEach(add);
      break;
    case 'angle-value':
      (c.points ?? []).forEach(add);
      break;
    case 'value':
      // 表达式里的点 id 交给读数求值去处理，这里不管
      break;
  }
  return out;
}

function checkIsolatedPoints(scene: Scene3D, pts: Map<string, V3>): Issue[] {  const used = new Set<string>();
  for (const obj of scene.objects) {
    if (obj.type === 'edge3') {
      used.add(obj.a);
      used.add(obj.b);
    } else if (obj.type === 'face3') {
      for (const id of obj.points) used.add(id);
    } else if (isCurved3(obj)) {
      // 旋转体引用的圆心（圆柱 O、O₁ / 圆锥的 O）虽然没连棱，
      // 但它撑起了整个曲面，不该被提醒"孤立"
      for (const r of refsOf(obj)) {
        const id = refIdOf(r.ref);
        if (id) used.add(id);
      }
    } else if (obj.type === 'section3') {
      // 截面引用的平面点同理：它们撑起了截面平面
      const refs: PointRef[] = Array.isArray(obj.plane)
        ? [...obj.plane]
        : obj.p !== undefined
          ? [obj.p]
          : [];
      for (const ref of refs) {
        const id = refIdOf(ref);
        if (id) used.add(id);
      }
    }
  }
  // 约束里点名的点也算"在用"。
  // 典型场景：截面与棱的交点（正方体截面里的 P、Q）既没连棱也不在面上，
  // 它是靠约束（on-segment / coplanar）参与题目的——报"孤立点"是误伤。
  for (const c of scene.constraints ?? []) {
    for (const id of constraintPointIds(c)) used.add(id);
  }
  // 讲解正文里点名的点同理也算"在用"：程序代改补出来的交点
  // （"延长 DM 交 AA₁ 于 P"的 P）不连棱、不进面、可能也没约束，
  // 只活在讲解文字里——按原规则会被提醒"孤立"，那是误伤。
  for (const step of scene.steps ?? []) {
    const norm = normalizeVertexToken(String(step.text ?? ''));
    const re = /(^|[^A-Za-z0-9])([A-Z]\d?)(?![A-Za-z0-9])/g;
    for (const m of norm.matchAll(re)) used.add(m[2]);
  }
  const issues: Issue[] = [];
  const hiddenIds = new Set<string>();
  for (const obj of scene.objects) {
    if (obj.type !== 'point3') continue;
    if ((obj as Point3Object).hidden) hiddenIds.add(obj.id);
    // 折前点只提供坐标（derive.of），本来就不画，谈不上"孤立"
    const d = (obj as Point3Object).derive;
    if (d && d.kind === 'fold') hiddenIds.add(d.of);
  }
  for (const id of pts.keys()) {
    if (hiddenIds.has(id)) continue;
    if (!used.has(id)) {
      issues.push({
        level: 'warn',
        where: id,
        message: `顶点「${id}」没有连任何棱、也不在任何面上，图上只是一个孤立的点`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------
// 旋转体（圆柱 / 圆锥 / 球）
// ---------------------------------------------------------------

/** 一个旋转体引用的全部点：圆柱 2 个、圆锥 2 个、球 1 个 */
function refsOf(obj: Curved3Object): Array<{ field: string; ref: PointRef }> {
  if (obj.type === 'cylinder3') {
    return [
      { field: 'a', ref: obj.a },
      { field: 'b', ref: obj.b },
    ];
  }
  if (obj.type === 'cone3') {
    return [
      { field: 'apex', ref: obj.apex },
      { field: 'base', ref: obj.base },
    ];
  }
  return [{ field: 'center', ref: obj.center }];
}

/** 点引用是不是"顶点 id"（不是坐标）；是就返回 id，用于"这个点被用到了"的判定 */
function refIdOf(ref: PointRef): string | null {
  if (typeof ref !== 'string') return null;
  const s = ref.trim();
  return s !== '' && !s.includes(',') ? s : null;
}

const SOLID_NAME: Record<Curved3Object['type'], string> = {
  cylinder3: '圆柱',
  cone3: '圆锥',
  sphere3: '球',
};

/**
 * 旋转体的体检。
 *
 * 这里能抓的三类错都有真实后果：
 *   ① 半径 ≤ 0 或算不出来 —— 渲染器会静默跳过，画面直接少一个体；
 *   ② 圆心写的是不存在的顶点 id（最常见是 O₁ 带下标、id 却是 O1）—— 同上；
 *   ③ 圆柱的"两个圆心"写成同一个点 —— 轴长为 0，画出来只剩一个圆。
 *
 * 数值解析抽成 resolveSolidSpecs：截面检查（checkSections）和
 * 读数里的截面量（sectionScope3D）要用同一份数字，各算各的迟早对不上。
 */
function resolveSolidSpecs(
  scene: Scene3D,
  pts: Map<string, V3>,
  scope: Record<string, number>,
): { specs: Map<string, SolidSpec>; issues: Issue[] } {
  const specs = new Map<string, SolidSpec>();
  const issues: Issue[] = [];
  const lookup = (id: string) => pts.get(id);

  for (const obj of scene.objects) {
    if (!isCurved3(obj)) continue;
    const name = SOLID_NAME[obj.type];

    // ① 半径
    const rawR = obj.radius as unknown;
    let r = NaN;
    if (typeof rawR === 'number') {
      r = rawR;
    } else {
      try {
        r = evalNumber(normalizeExpr(String(rawR)), scope);
      } catch {
        r = NaN;
      }
    }
    if (!isFinite(r)) {
      issues.push({
        level: 'error',
        where: obj.id,
        message:
          `${name}「${obj.id}」的半径算不出来：radius = ${JSON.stringify(rawR)}。` +
          `半径要写一段数字或表达式（如 "r"、"a/2"），不是坐标${unknownHint(String(rawR), scope)}`,
      });
    } else if (r <= 0) {
      issues.push({
        level: 'error',
        where: obj.id,
        message: `${name}「${obj.id}」的半径是 ${fmtN(r)}，必须大于 0`,
      });
    }

    // ② 圆心
    const resolved = refsOf(obj).map(({ field, ref }) => {
      const res = evalPointRef(ref, lookup, scope);
      if (!res.value) {
        issues.push({
          level: 'error',
          where: obj.id,
          message: `${name}「${obj.id}」的 ${field}：${res.reason}`,
        });
      }
      return res.value;
    });

    // ③ 轴不能退化成一个点
    if (obj.type !== 'sphere3') {
      const [pa, pb] = resolved;
      const [fa, fb] = refsOf(obj).map((x) => x.field);
      if (pa && pb && dist3(pa, pb) < 1e-9) {
        issues.push({
          level: 'error',
          where: obj.id,
          message:
            `${name}「${obj.id}」的轴长为 0（${fa} 与 ${fb} 是同一个点），画出来只剩一个圆。` +
            `圆柱/圆锥要两个不同的圆心：下底面一个（z=0）、上底面/锥尖一个（z=h）`,
        });
      }
    }

    if (isFinite(r) && r > 0 && resolved.every((v) => v !== null)) {
      specs.set(obj.id, {
        kind: obj.type === 'cylinder3' ? 'cylinder' : obj.type === 'cone3' ? 'cone' : 'sphere',
        a: resolved[0]!,
        b: (resolved[1] ?? resolved[0])!,
        r,
      });
    }
  }
  return { specs, issues };
}

function checkSolids(
  scene: Scene3D,
  pts: Map<string, V3>,
  scope: Record<string, number>,
): Issue[] {
  return resolveSolidSpecs(scene, pts, scope).issues;
}

// ---------------------------------------------------------------
// 截面（section3）
// ---------------------------------------------------------------

/**
 * 把每个 section3 的「切谁」解析成可计算的目标。
 *
 * 两类目标共用一套下游（平面求值、截面求解、读数注入）：
 *   - 旋转体：直接查已解析好的圆柱/圆锥/球；
 *   - 多面体：按 cut.vertices 收集面，面优先取 cut.faces，
 *     否则从场景里已有的 face3 里挑「顶点全在 vertices 内」的那些。
 */
function resolveSectionTargets(
  scene: Scene3D,
  pts: Map<string, V3>,
  specs: Map<string, SolidSpec>,
): { targets: Map<string, SectionTarget>; issues: Issue[] } {
  const targets = new Map<string, SectionTarget>();
  const issues: Issue[] = [];
  const sceneFaces = scene.objects.filter((o) => o.type === 'face3') as Face3Object[];

  for (const obj of scene.objects) {
    if (obj.type !== 'section3') continue;
    if (typeof obj.cut === 'string') {
      const target = specs.get(obj.cut);
      if (!target) {
        const curvedIds = scene.objects
          .filter((o) => isCurved3(o))
          .map((o) => `"${o.id}"`)
          .join('、');
        issues.push({
          level: 'error',
          where: obj.id,
          message:
            `截面「${obj.id}」的 cut = "${obj.cut}" 找不到可切的旋转体` +
            `（场景里的旋转体：${curvedIds || '一个都没有'}）。` +
            `cut 要写 cylinder3/cone3/sphere3 的 id；切正方体/棱锥这类多面体，` +
            `改成 {"cut":{"vertices":["A","B","C","D","A1","B1","C1","D1"]}}`,
        });
        continue;
      }
      targets.set(obj.id, { kind: 'solid', spec: target });
      continue;
    }

    const built = buildPolySpec(
      obj.cut.vertices,
      obj.cut.faces,
      (id) => pts.get(id),
      sceneFaces.map((f) => ({ points: f.points })),
    );
    if ('error' in built) {
      issues.push({ level: 'error', where: obj.id, message: `截面「${obj.id}」：${built.error}` });
      continue;
    }
    targets.set(obj.id, { kind: 'poly', spec: built.spec });
  }
  return { targets, issues };
}

/**
 * 把 section3 的平面定义解析成 PlaneSpec（数值）。
 * plane 三点 或 p+normal 两种写法都在这里归一。
 * 解析失败返回 null 并附 issue。
 */
function evalSectionPlane(
  obj: Section3Object,
  pts: Map<string, V3>,
  scope: Record<string, number>,
): { plane: PlaneSpec } | { error: string } {
  const lookup = (id: string) => pts.get(id);
  const crossP = (a: V3, b: V3): V3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  if (Array.isArray(obj.plane)) {
    const vals = obj.plane.map((ref) => evalPointRef(ref, lookup, scope));
    for (let k = 0; k < vals.length; k++) {
      if (!vals[k].value) return { error: `plane[${k}]：${vals[k].reason}` };
    }
    const [P1, P2, P3] = vals.map((v) => v.value!);
    const n = crossP(sub3(P2, P1), sub3(P3, P1));
    if (len3(n) < 1e-9) {
      return { error: `plane 的三点共线（${fmtV(P1)} ${fmtV(P2)} ${fmtV(P3)}），定不出平面——换三个不共线的点` };
    }
    return { plane: { p: P1, n } };
  }

  const pv = evalPointRef(obj.p as PointRef, lookup, scope);
  if (!pv.value) return { error: `p：${pv.reason}` };
  const rawN = obj.normal;
  let n: V3 | null = null;
  try {
    const r = evalVec3Detailed(
      (Array.isArray(rawN) ? rawN.map(String) : String(rawN)) as never,
      scope,
    );
    n = r.value;
  } catch {
    n = null;
  }
  if (!n || len3(n) < 1e-12) {
    return { error: `normal 算不出来（${JSON.stringify(rawN) ?? ''}），要写三个数或表达式` };
  }
  return { plane: { p: pv.value, n } };
}

/** 截面的体检：切的是不是旋转体、平面定不定得出来、切没切到、切没切穿 */
function checkSections(
  scene: Scene3D,
  pts: Map<string, V3>,
  scope: Record<string, number>,
  specs: Map<string, SolidSpec>,
): Issue[] {
  const { targets, issues } = resolveSectionTargets(scene, pts, specs);
  for (const obj of scene.objects) {
    if (obj.type !== 'section3') continue;
    const target = targets.get(obj.id);
    if (!target) continue; // resolveSectionTargets 已经报过原因
    const pl = evalSectionPlane(obj, pts, scope);
    if ('error' in pl) {
      issues.push({ level: 'error', where: obj.id, message: `截面「${obj.id}」的平面：${pl.error}` });
      continue;
    }
    const sol = solveSectionOn(target, pl.plane);
    if (!sol.ok) {
      issues.push({ level: 'error', where: obj.id, message: `截面「${obj.id}」：${sol.reason}` });
    }
  }
  return issues;
}

const CN_NUM: Record<string, number> = {
  三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8,
};
/** 数字 → 中文（报错文案用"五边形"而不是"5 边形"，和题面说法一致） */
const NUM_CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八'];

/**
 * 把下标写法统一成普通数字：D₁ → D1。模型两种混着写，比对前先归一。
 */
export function normalizeVertexToken(s: string): string {
  return s
    .replace(/[₀-₉]/g, (c) => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(c)))
    .replace(/\s+/g, '');
}

/**
 * 截面结论核对：步骤文字里写的「n 边形」必须等于程序实测边数。
 *
 * 真实事故（2026-11-05，正方体过 D、M、N 的截面）：
 * 求解器逐面求交算出**五边形**，图形画对了，但步骤写「截面为四边形 DMNP」。
 * 旧体检完全不看这句话——它能验坐标、验约束、验截面切没切穿，
 * 唯独不验"你最后得出的结论"。用户看到的是"自己数出五边形、系统说四边形"。
 *
 * 判定范围收得很紧，宁可不报也不误报：
 *   · 场景里恰好一个 section3（多个时分不清在说哪一个）；
 *   · 切出来是多边形（3~6 边），不是椭圆/圆；
 *   · 只在「同一句里同时出现"截面"和"n 边形"」时认定为结论。
 */
/**
 * 截面实测信息：边数 + 按环绕顺序的顶点。
 *
 * 体检器（结论核对）和程序代改（autofix3d）共用这一份计算，
 * 保证"体检说错了什么"和"程序改成了什么"永远一致。
 *
 * 只有场景里**恰好一个 section3** 且切出的是多边形时才有值；
 * 其它情况返回 null（多个截面分不清在说谁、椭圆没有"边数"）。
 */
export interface SectionFacts3D {
  /** section3 对象的 id */
  id: string;
  /** 多边形边数（3~8） */
  n: number;
  /** 每个截面顶点：能对上已声明点就给它的 id，对不上给 null */
  names: Array<string | null>;
  /** 与 names 对齐的实测坐标（names[i] 为 null 时用它） */
  positions: V3[];
}

export function sectionFacts3D(scene: Scene3D): SectionFacts3D | null {
  const sections = scene.objects.filter((o) => o.type === 'section3') as Section3Object[];
  if (sections.length !== 1) return null;
  const obj = sections[0];

  const scope = defaultScope(scene);
  const { pts } = collectPoints(scene, scope);
  if (pts.size === 0) return null;
  const { specs } = resolveSolidSpecs(scene, pts, scope);
  const { targets } = resolveSectionTargets(scene, pts, specs);
  const target = targets.get(obj.id);
  if (!target) return null;
  const pl = evalSectionPlane(obj, pts, scope);
  if ('error' in pl) return null;

  const sol = solveSectionOn(target, pl.plane);
  if (!sol.ok || sol.shape !== 'polygon' || sol.n < 3) return null;

  // 顶点 → 已知点 id（顶点常常是"棱上的落点"，模型可能声明过也可能没有）
  let scale = 1;
  for (const p of pts.values()) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const tol = 1e-3 * scale;
  const names: Array<string | null> = [];
  const positions: V3[] = [];
  for (const v of sol.loop) {
    let bestId: string | null = null;
    let bestD = Infinity;
    for (const [id, p] of pts) {
      const d = len3(sub3(p, v));
      if (d < bestD) {
        bestD = d;
        bestId = id;
      }
    }
    names.push(bestD <= tol ? bestId : null);
    positions.push(v);
  }
  return { id: obj.id, n: sol.n, names, positions };
}

function checkSectionClaims(
  scene: Scene3D,
): Issue[] {
  const issues: Issue[] = [];
  if (!(scene.steps ?? []).length) return issues;

  const facts = sectionFacts3D(scene);
  if (!facts) return issues;
  const solN = facts.n;
  const vertexNames = facts.names.map((id, i) => id ?? `(${fmtV(facts.positions[i])})`);

  (scene.steps ?? []).forEach((step, i) => {
    const text = String(step.text ?? '');
    if (!text.includes('截面')) return;

    const re = /([三四五六七八])\s*边形\s*([A-Z][A-Za-z0-9₀-₉]{1,9})?/g;
    for (const m of text.matchAll(re)) {
      const claimed = CN_NUM[m[1]];
      if (!claimed || claimed === solN) continue;

      const listed = m[2] ? normalizeVertexToken(m[2]) : '';
      const actual = vertexNames.map(normalizeVertexToken);
      const missing = actual.filter((v) => v && !listed.includes(v));

      issues.push({
        level: 'error',
        where: `steps[${i}]`,
        message:
          `第 ${i + 1} 步的结论写「${m[1]}边形${m[2] ? ' ' + m[2] : ''}」，` +
          `但按 cut.vertices + plane 逐面求交，这个截面实际是**${NUM_CN[solN]}边形**（${solN} 条边），` +
          `顶点依次为 ${vertexNames.join('、')}。` +
          `截面边数 = 平面穿过的面数，不能只按已知那三个点就下结论` +
          `——三个点只定了平面，第四个、第五个顶点要由其它面与这个平面的交线求出。` +
          (listed && missing.length
            ? `你列出的顶点还漏了 ${missing.join('、')}。`
            : '') +
          `请把结论改成「${NUM_CN[solN]}边形」并写全顶点（读数里可直接用 secN3(${facts.id}) 取边数）。`,
      });
      break; // 同一句只报一次
    }
  });
  return issues;
}

/**
 * 算出所有截面量，塞进求值 scope（__sec_a_<id> 等）。
 *
 * 渲染器的读数面板、体检器的读数检查、复核用的 measureReadouts3D
 * 都走这里——三处共用一份定义，截面量不可能对不上。
 */
export function sectionScope3D(
  scene: Scene3D,
  base: Record<string, number>,
): Record<string, number> {
  const scope = { ...base };
  const hasSection = scene.objects.some((o) => o.type === 'section3');
  if (!hasSection) return scope;

  const { pts } = collectPoints(scene, base);
  const { specs } = resolveSolidSpecs(scene, pts, base);
  const { targets } = resolveSectionTargets(scene, pts, specs);
  for (const obj of scene.objects) {
    if (obj.type !== 'section3') continue;
    const target = targets.get(obj.id);
    if (!target) continue;
    const pl = evalSectionPlane(obj, pts, base);
    if ('error' in pl) continue;
    const sol = solveSectionOn(target, pl.plane);
    if (!sol.ok) continue;
    // 长短轴只对旋转体有定义；多面体截面的 a/b 是 NaN，
    // 读数里若写了 secA3 会显示"—"，模型应当改用 secArea3 / secPerim3 / secN3
    scope[`__sec_a_${obj.id}`] = sol.a;
    scope[`__sec_b_${obj.id}`] = sol.b;
    scope[`__sec_area_${obj.id}`] = sol.area;
    scope[`__sec_perim_${obj.id}`] = sol.perimeter;
    scope[`__sec_n_${obj.id}`] = sol.n;
  }
  return scope;
}

// ---------------------------------------------------------------
// 约束验算
// ---------------------------------------------------------------

/** 把表达式里的点 id 换成数值坐标（报错时仍显示原写法） */
function substitutePointIds3(expr: string, pts: Map<string, V3>): string {
  return expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => {
    const p = pts.get(name);
    return p ? `(${p[0]}),(${p[1]}),(${p[2]})` : name;
  });
}

function checkConstraint3(
  c: Constraint3,
  pts: Map<string, V3>,
  scope: Record<string, number>,
  where: string,
): Issue | null {
  const missing = (id: string): Issue => ({
    level: 'warn',
    where,
    message: `这条约束引用的顶点「${id}」不存在或坐标算不出来，无法验算`,
  });
  const need = (id: string) => {
    const p = pts.get(id);
    return p ?? null;
  };

  switch (c.type) {
    case 'equal-length': {
      const [a1, a2] = c.a ?? [];
      const [b1, b2] = c.b ?? [];
      const A1 = need(a1), A2 = need(a2), B1 = need(b1), B2 = need(b2);
      for (const [id, p] of [[a1, A1], [a2, A2], [b1, B1], [b2, B2]] as const) {
        if (!p) return missing(id);
      }
      const l1 = dist3(A1!, A2!);
      const l2 = dist3(B1!, B2!);
      const rel = Math.abs(l1 - l2) / Math.max(l1, l2, 1);
      if (rel <= REL_TOL) return null;
      return {
        level: 'error',
        where,
        message:
          `「${a1}${a2} = ${b1}${b2}」不成立：实测 |${a1}${a2}| = ${l1.toFixed(3)}、` +
          `|${b1}${b2}| = ${l2.toFixed(3)}。坐标 ${a1}${fmtV(A1!)}、${a2}${fmtV(A2!)}、` +
          `${b1}${fmtV(B1!)}、${b2}${fmtV(B2!)}`,
      };
    }
    case 'length-ratio': {
      const [a1, a2] = c.a ?? [];
      const [b1, b2] = c.b ?? [];
      const A1 = need(a1), A2 = need(a2), B1 = need(b1), B2 = need(b2);
      for (const [id, p] of [[a1, A1], [a2, A2], [b1, B1], [b2, B2]] as const) {
        if (!p) return missing(id);
      }
      const l1 = dist3(A1!, A2!);
      const l2 = dist3(B1!, B2!);
      const actual = l2 > 1e-12 ? l1 / l2 : Infinity;
      if (Math.abs(actual - c.ratio) / Math.max(1, Math.abs(c.ratio)) <= REL_TOL) return null;
      return {
        level: 'error',
        where,
        message:
          `「|${a1}${a2}| : |${b1}${b2}| = ${c.ratio}」不成立：实测 ${actual.toFixed(3)}` +
          `（|${a1}${a2}| = ${l1.toFixed(3)}、|${b1}${b2}| = ${l2.toFixed(3)}）。` +
          `定比分点请用 derive 的 section，不要手算坐标`,
      };
    }
    case 'perp-lines': {
      const [a1, a2] = c.a ?? [];
      const [b1, b2] = c.b ?? [];
      const A1 = need(a1), A2 = need(a2), B1 = need(b1), B2 = need(b2);
      for (const [id, p] of [[a1, A1], [a2, A2], [b1, B1], [b2, B2]] as const) {
        if (!p) return missing(id);
      }
      const ang = angleBetween3(sub3(A2!, A1!), sub3(B2!, B1!));
      if (Math.abs(ang - 90) <= ANG_TOL) return null;
      return {
        level: 'error',
        where,
        message:
          `「${a1}${a2} ⊥ ${b1}${b2}」不成立：两线方向夹角实测 ${ang.toFixed(2)}°（应为 90°）。` +
          `坐标 ${a1}${fmtV(A1!)}、${a2}${fmtV(A2!)}、${b1}${fmtV(B1!)}、${b2}${fmtV(B2!)}`,
      };
    }
    case 'parallel-lines': {
      const [a1, a2] = c.a ?? [];
      const [b1, b2] = c.b ?? [];
      const A1 = need(a1), A2 = need(a2), B1 = need(b1), B2 = need(b2);
      for (const [id, p] of [[a1, A1], [a2, A2], [b1, B1], [b2, B2]] as const) {
        if (!p) return missing(id);
      }
      const ang = angleBetween3(sub3(A2!, A1!), sub3(B2!, B1!));
      const dev = Math.min(ang, 180 - ang);
      if (dev <= ANG_TOL) return null;
      return {
        level: 'error',
        where,
        message:
          `「${a1}${a2} ∥ ${b1}${b2}」不成立：两线方向夹角实测 ${dev.toFixed(2)}°（平行应为 0°）。` +
          `平行棱要求方向向量成比例，比如两条都沿 x 轴或都沿 z 轴`,
      };
    }
    case 'collinear': {
      const ids = c.points ?? [];
      if (ids.length < 3) return { level: 'warn', where, message: '共线约束至少要 3 个点' };
      const ps: V3[] = [];
      for (const id of ids) {
        const p = need(id);
        if (!p) return missing(id);
        ps.push(p);
      }
      const A = ps[0];
      const scale = Math.max(1, ...ps.map((p) => dist3(p, A)));
      let maxOff = 0;
      for (let i = 2; i < ps.length; i++) {
        maxOff = Math.max(maxOff, distToLine3(ps[i], ps[0], ps[1]));
      }
      if (maxOff / scale <= TIGHT) return null;
      return {
        level: 'error',
        where,
        message: `「${ids.join('、')} 共线」不成立：最大偏离直线 ${maxOff.toFixed(3)}`,
      };
    }
    case 'coplanar': {
      const ids = c.points ?? [];
      if (ids.length < 4) return { level: 'warn', where, message: '共面约束至少要 4 个点' };
      const ps: V3[] = [];
      for (const id of ids) {
        const p = need(id);
        if (!p) return missing(id);
        ps.push(p);
      }
      // 找三个不共线的点定平面
      let base: [V3, V3, V3] | null = null;
      for (let i = 0; i < ps.length && !base; i++) {
        for (let j = i + 1; j < ps.length && !base; j++) {
          for (let k = j + 1; k < ps.length && !base; k++) {
            if (len3(cross3(sub3(ps[j], ps[i]), sub3(ps[k], ps[i]))) > 1e-9) {
              base = [ps[i], ps[j], ps[k]];
            }
          }
        }
      }
      if (!base) {
        return { level: 'error', where, message: `「${ids.join('、')} 共面」无法验算：这些点全都共线` };
      }
      const [A, B, C] = base;
      const scale = Math.max(1, ...ps.map((p) => dist3(p, A)));
      let maxOff = 0;
      for (const p of ps) maxOff = Math.max(maxOff, distToPlane3(p, A, B, C));
      if (maxOff / scale <= TIGHT) return null;
      return {
        level: 'error',
        where,
        message:
          `「${ids.join('、')} 四点共面」不成立：最远的点离平面 ${maxOff.toFixed(3)}。` +
          `共面点必须是平面上点的线性组合（如截面里的点都满足某个 z = k）`,
      };
    }
    case 'midpoint': {
      const M = need(c.m);
      const E1 = need(c.ends?.[0] ?? '');
      const E2 = need(c.ends?.[1] ?? '');
      if (!M) return missing(c.m);
      if (!E1) return missing(c.ends?.[0] ?? '');
      if (!E2) return missing(c.ends?.[1] ?? '');
      const mid = mul3(add3(E1!, E2!), 0.5);
      const d = dist3(M!, mid);
      const scale = Math.max(1, dist3(E1!, E2!));
      if (d / scale <= REL_TOL) return null;
      return {
        level: 'error',
        where,
        message:
          `「${c.m} 是 ${c.ends?.[0]}${c.ends?.[1]} 的中点」不成立：` +
          `中点应为 ${fmtV(mid)}，实测 ${c.m}${fmtV(M!)}。中点一律用 derive，不要手算`,
      };
    }
    case 'on-segment': {
      const P = need(c.p);
      const E1 = need(c.ends?.[0] ?? '');
      const E2 = need(c.ends?.[1] ?? '');
      if (!P) return missing(c.p);
      if (!E1) return missing(c.ends?.[0] ?? '');
      if (!E2) return missing(c.ends?.[1] ?? '');
      const d = sub3(E2!, E1!);
      const l2 = Math.max(dot3(d, d), 1e-12);
      const t = dot3(sub3(P!, E1!), d) / l2;
      const off = distToLine3(P!, E1!, E2!);
      const scale = Math.max(1, len3(d));
      const name = `${c.ends?.[0]}${c.ends?.[1]}`;
      if (off / scale > REL_TOL) {
        return {
          level: 'error',
          where,
          message:
            `「${c.p} 在线段 ${name} 上」不成立：${c.p}${fmtV(P!)} 到直线 ${name} 的距离 ${off.toFixed(3)}。` +
            `用 derive 的 section（${c.p} = ${c.ends?.[0]} + t·(${c.ends?.[1]}−${c.ends?.[0]})，t 取 0~1）`,
        };
      }
      if (t < -REL_TOL || t > 1 + REL_TOL) {
        return {
          level: 'error',
          where,
          message: `「${c.p} 在线段 ${name} 上」不成立：参数 t = ${t.toFixed(3)}，应在 0~1 之间（落在线段外）`,
        };
      }
      return null;
    }
    case 'angle-value': {
      const [i1, i2, i3] = c.points ?? [];
      const A = need(i1), V = need(i2), B = need(i3);
      if (!A) return missing(i1);
      if (!V) return missing(i2);
      if (!B) return missing(i3);
      const ang = angleBetween3(sub3(A!, V!), sub3(B!, V!));
      if (Math.abs(ang - c.deg) <= ANG_TOL) return null;
      return {
        level: 'error',
        where,
        message:
          `「∠${i1}${i2}${i3} = ${c.deg}°」不成立：实测 ${ang.toFixed(2)}°。` +
          `坐标 ${i1}${fmtV(A!)}、${i2}${fmtV(V!)}、${i3}${fmtV(B!)}`,
      };
    }
    case 'value': {
      const expr = substitutePointIds3(c.expr ?? '', pts);
      let v: number;
      try {
        v = evalNumber(expr, scope);
      } catch (e) {
        return {
          level: 'warn',
          where,
          message: `定值约束「${c.expr}」算不出来：${(e as Error).message}${unknownHint(c.expr, scope)}`,
        };
      }
      const tol = Math.max(1e-6, Math.abs(c.equals) * REL_TOL);
      if (Math.abs(v - c.equals) <= tol) return null;
      return {
        level: 'error',
        where,
        message:
          `「${c.expr} = ${c.equals}」不成立：图上量出来是 ${fmtN(v)}（差 ${fmtN(Math.abs(v - c.equals))}）。` +
          `这是题面给定的具体数值，靠它定住整张图的缩放——调参数默认值或顶点坐标去凑`,
      };
    }
    default: {
      const t = (c as { type?: string }).type;
      return { level: 'warn', where, message: `未知的立体约束类型「${t}」` };
    }
  }
}

/**
 * 共线/共面的容差用 TIGHT（见文件头）。这里不再单列常量——
 * 同一个数值散在两处，改一处忘了另一处，是最难查的那种 bug。
 */

function checkConstraints(scene: Scene3D, pts: Map<string, V3>, scope: Record<string, number>): Issue[] {
  const issues: Issue[] = [];
  const list = scene.constraints ?? [];
  list.forEach((c, i) => {
    const where = c && typeof c === 'object' ? `constraints[${i}]（${c.type}）` : `constraints[${i}]`;
    if (!c || typeof c !== 'object') {
      issues.push({ level: 'warn', where, message: '这条约束不是对象，已跳过' });
      return;
    }
    const issue = checkConstraint3(c, pts, scope, where);
    if (issue) issues.push(issue);
  });
  return issues;
}

// ---------------------------------------------------------------
// 读数与步骤
// ---------------------------------------------------------------

/** 算一遍所有读数（给复核用，也给"答案对不对"做证据） */
export function measureReadouts3D(scene: Scene3D): Array<{ label: string; value: string }> {
  const scope = sectionScope3D(scene, defaultScope(scene));
  const out: Array<{ label: string; value: string }> = [];
  for (const r of scene.readouts ?? []) {
    try {
      const v = evalAny(r.expr, { ...scope });
      if (typeof v === 'number' && isFinite(v)) {
        out.push({ label: r.label, value: v.toFixed(2) + (r.unit ?? '') });
      }
    } catch {
      // 读数算不出来不影响渲染，checkReadouts 会单独提醒
    }
  }
  return out;
}

function checkReadouts(scene: Scene3D, scope: Record<string, number>): Issue[] {
  const issues: Issue[] = [];
  const fullScope = sectionScope3D(scene, scope);
  (scene.readouts ?? []).forEach((r, i) => {
    try {
      const v = evalAny(r.expr, { ...fullScope });
      if (typeof v === 'number' && !isFinite(v)) {
        issues.push({
          level: 'warn',
          where: `readouts[${i}]`,
          message: `「${r.label}」算出来是 ${v}（分母为 0 或参数越界）`,
        });
      }
    } catch (e) {
      issues.push({
        level: 'warn',
        where: `readouts[${i}]`,
        message: `「${r.label}」求值失败：${(e as Error).message}${unknownHint(r.expr, scope)}`,
      });
    }
  });
  return issues;
}

/** steps 引用的对象 id 必须真的存在，否则"高亮"会静默失效 */
function checkSteps(scene: Scene3D): Issue[] {
  const ids = new Set(scene.objects.map((o: Scene3DObject) => o.id));
  const issues: Issue[] = [];
  (scene.steps ?? []).forEach((s, i) => {
    for (const f of ['highlight', 'reveal'] as const) {
      for (const id of s[f] ?? []) {
        if (!ids.has(id)) {
          issues.push({
            level: 'warn',
            where: `steps[${i}]`,
            message: `第 ${i + 1} 步的 ${f} 引用了不存在的对象 id「${id}」`,
          });
        }
      }
    }
  });
  return issues;
}

/** 相机参数：视角给得离谱时提醒（不拦） */
function checkCamera(scene: Scene3D): Issue[] {
  const c = scene.camera;
  if (!c) return [];
  const issues: Issue[] = [];
  if (c.elevation !== undefined && (c.elevation < -89 || c.elevation > 89)) {
    issues.push({
      level: 'warn',
      where: 'camera',
      message: `elevation=${c.elevation} 超出 -89~89（0 平视、90 正俯视），建议 15~25`,
    });
  }
  if (c.fov !== undefined && (c.fov < 20 || c.fov > 100)) {
    issues.push({ level: 'warn', where: 'camera', message: `fov=${c.fov} 超出 20~100，建议 45` });
  }
  return issues;
}

// ---------------------------------------------------------------
// 翻折声明
// ---------------------------------------------------------------

/**
 * 核 fold 声明：折痕、折起的那一块、折起角对不对得上。
 *
 * 一律只报 warn，不拦生成——翻折只是"讲解时演一段动画"，图本身可能是对的。
 * 核不过的 fold 播放器会安静地跳过（见 core/renderer3d 的 setFoldOffset），
 * 视频退化成静态折好图，不至于整道题重出。
 *
 * 其中最有价值的一条是**实测折起角**：模型经常把 90° 的图画成 60°，
 * 而声明写 90°，结果展开再折回去时那块平面像自己往上翘。
 */
function checkFold(scene: Scene3D, pts: Map<string, V3>): Issue[] {
  const fold = scene.fold;
  if (!fold) return [];

  const issues: Issue[] = [];
  const { plan, why } = planFold(fold, pts);
  if (!plan) {
    issues.push({
      level: 'warn',
      where: 'fold',
      message: `翻折声明不能用（${why}），视频里不会演折起过程，只显示静态图`,
    });
    return issues;
  }

  // 截面/旋转体的几何每帧都要按点重算，和"点会动"这件事打架；播放器直接不演
  const blockers = scene.objects.filter((o) => o.type === 'section3' || isCurved3(o)).map((o) => o.id);
  if (blockers.length > 0) {
    issues.push({
      level: 'warn',
      where: 'fold',
      message: `本题有 ${blockers.join('、')}（截面/旋转体），翻折动画已停用——这两类图形每帧都要按顶点重算，点一动就画歪。静态图不受影响`,
    });
    return issues;
  }

  // 实测折起角：折痕两侧各取一个"离轴最远"的样本点，量它们垂直于轴的方向夹角
  const axis = sub3(plan.b, plan.a);
  const axisLen = len3(axis);
  const u: V3 = [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen];
  const perpDist = (p: V3): number => {
    const v = sub3(p, plan.a);
    const d = dot3(v, u);
    return len3([v[0] - u[0] * d, v[1] - u[1] * d, v[2] - u[2] * d]);
  };
  const movingSet = new Set(plan.ids);
  let movingSample: V3 | null = null;
  let movingBest = 0;
  for (const id of plan.ids) {
    const p = pts.get(id);
    if (!p) continue;
    const d = perpDist(p);
    if (d > movingBest) {
      movingBest = d;
      movingSample = p;
    }
  }
  let fixedSample: V3 | null = null;
  let fixedBest = 0;
  // hidden 点（折前位置）不算"固定块"的样本：它不在画面上，
  // 而且它本来就躺在展开时的那个平面里，拿它量二面角会量出 180°
  const hiddenIds = new Set(
    scene.objects
      .filter((o) => o.type === 'point3' && (o as { hidden?: boolean }).hidden === true)
      .map((o) => o.id),
  );
  for (const [id, p] of pts) {
    if (movingSet.has(id) || hiddenIds.has(id)) continue;
    if (id === fold.crease[0] || id === fold.crease[1]) continue;
    const d = perpDist(p);
    if (d > fixedBest) {
      fixedBest = d;
      fixedSample = p;
    }
  }
  if (movingSample && fixedSample) {
    const got = foldAngleFrom(plan, movingSample, fixedSample);
    if (got !== null && Math.abs(got - fold.deg) > 1.5) {
      issues.push({
        level: 'warn',
        where: 'fold',
        message:
          `fold.deg 写的是 ${fold.deg}°，实测折起角是 ${got.toFixed(1)}°。` +
          `展开→折起的动画会把这两者的差补上（画面上会多折 ${Math.abs(got - fold.deg).toFixed(0)}°），` +
          `要么把顶点坐标折到位，要么把 deg 改成实测值`,
      });
    }
  }

  return issues;
}

/**
 * 折后点（derive.kind = 'fold'）的体检。
 *
 * 为什么这类点也要单独查？——它把"算坐标"这件事从模型手里拿走了，
 * 但**关系**还留在模型手里：折的是哪个点、绕哪条折痕、多少度。
 * 写错关系照样是错的图，而且错得很隐蔽（程序会算出一个精确的错位置）。
 */
function checkFoldDerives(scene: Scene3D, pts: Map<string, V3>): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map<string, Point3Object>();
  for (const o of scene.objects) {
    if (o.type === 'point3') byId.set(o.id, o as Point3Object);
  }

  scene.objects.forEach((o, i) => {
    if (o.type !== 'point3') return;
    const d = (o as Point3Object).derive;
    if (!d || d.kind !== 'fold') return;
    const tag = `objects[${i}]（${o.id} 的 fold）`;

    if (!byId.has(d.of)) {
      issues.push({
        level: 'error',
        where: `objects[${i}]`,
        message:
          `${tag}：要折的点「${d.of}」没在 objects 里声明。` +
          `折前的点连坐标一起补上、标 hidden:true（不画出来），` +
          `例如 {"type":"point3","id":"${d.of}","at":"折前坐标","hidden":true}`,
      });
      return;
    }
    const c1 = pts.get(d.crease[0]);
    const c2 = pts.get(d.crease[1]);
    if (!c1 || !c2) {
      const bad = [d.crease[0], d.crease[1]].filter((id) => !pts.get(id));
      issues.push({
        level: 'error',
        where: `objects[${i}]`,
        message: `${tag}：折痕端点 ${bad.join('、')} 图里没有——折痕只能取已声明的顶点`,
      });
      return;
    }
    if (!(d.deg > 0 && d.deg < 180)) {
      issues.push({
        level: 'error',
        where: `objects[${i}]`,
        message: `${tag}：折起角 ${d.deg}° 不合理，应当严格在 0° 和 180° 之间（90 = 折成直角）`,
      });
      return;
    }
    const src = pts.get(d.of);
    if (src) {
      const ax = sub3(c2, c1);
      const axLen = len3(ax);
      if (axLen < 1e-9) {
        issues.push({
          level: 'error',
          where: `objects[${i}]`,
          message: `${tag}：折痕两端 ${d.crease[0]}、${d.crease[1]} 重合，折痕长度为 0`,
        });
        return;
      }
      const v = sub3(src, c1);
      const off = len3(cross3(v, ax)) / axLen;
      const scale = Math.max(1, axLen);
      if (off < 1e-6 * scale) {
        issues.push({
          level: 'error',
          where: `objects[${i}]`,
          message:
            `${tag}：「${d.of}」本身落在折痕 ${d.crease[0]}${d.crease[1]} 上，绕它转多少度都不动。` +
            `折的是**离开折痕的那一块**，检查一下 of 是不是写成了折痕上的点`,
        });
        return;
      }
    } else {
      issues.push({
        level: 'error',
        where: `objects[${i}]`,
        message: `${tag}：${d.of} 的坐标算不出来（它自己的 at/derive 有问题），折后点跟着算不出`,
      });
      return;
    }

    // 和动画声明对账：坐标按 60° 折、动画按 90° 演，画面上会"多折一截"
    const fold = scene.fold;
    if (fold) {
      const same =
        (fold.crease[0] === d.crease[0] && fold.crease[1] === d.crease[1]) ||
        (fold.crease[0] === d.crease[1] && fold.crease[1] === d.crease[0]);
      if (!same) {
        issues.push({
          level: 'warn',
          where: 'fold',
          message:
            `坐标是按折痕 ${d.crease[0]}${d.crease[1]} 算的，动画声明的是 ` +
            `${fold.crease[0]}${fold.crease[1]}——两处折痕不一致，演起来会扭`,
        });
      } else if (Math.abs(fold.deg - d.deg) > 0.5) {
        issues.push({
          level: 'error',
          where: 'fold',
          message:
            `坐标按 ${d.deg}° 折好了，动画的 fold.deg 却写 ${fold.deg}°——` +
            `展开再折回时，回到的那个位置和算好的坐标差 ${Math.abs(fold.deg - d.deg).toFixed(0)}°。两边改成同一个角`,
        });
      } else if (!fold.moving.includes(o.id)) {
        issues.push({
          level: 'warn',
          where: 'fold',
          message:
            `${o.id} 的坐标是按翻折算的，但 fold.moving 里没列它——` +
            `演折起动画时它会留在折好的位置不动，被折回去的是旁边那几个点`,
        });
      }
    }
  });

  return issues;
}

/**
 * 「题面明明说了折起，图里却没有 fold 声明」——提醒一句。
 *
 * 2026-11-09 那次就是这样：模型手写了折后坐标（还没算对），
 * 既没写 fold、也没用 derive。它的断言写得漂亮，图是错的，
 * 体检只报"垂直不成立"，它不知道真正该做的是"把这一步交给程序"。
 *
 * 只给 warn、不拦：很多题只是出现「二面角」这个词（求二面角并不等于要演折起），
 * 拦下来会误伤一大片。warn 会随错误一起回传，模型看得见就够了。
 */
function checkFoldMissing(scene: Scene3D): Issue[] {
  const hasDerive = scene.objects.some(
    (o) => o.type === 'point3' && (o as Point3Object).derive?.kind === 'fold',
  );
  if (scene.fold || hasDerive) return [];

  const text = [
    scene.meta?.title ?? '',
    scene.meta?.subtitle ?? '',
    ...(scene.steps ?? []).map((s) => String(s.text ?? '')),
  ].join(' ');
  if (!/折起|翻折|折叠/.test(text)) return [];
  // 已经在正文里明确"折起到……的位置"，才算真在讲折叠动作
  if (!/折起到|折起至|翻折到|折叠到|折成/.test(text)) return [];

  return [
    {
      level: 'warn',
      where: 'fold',
      message:
        '题面写的是折起/翻折，但这张图既没有 fold 声明、也没有折后点的 derive——' +
        '说明折后的坐标是手写的。绕空间斜轴转一个角手算必错，而且错了看不出来：' +
        '断言（如 A₁O ⊥ BE）可能写着是对的，坐标已经偏了。' +
        '改法：按展开态写全部顶点，折起来的点用 ' +
        '{"derive":{"kind":"fold","of":"A","crease":["B","E"],"deg":90}} 让程序算，' +
        '再补 "fold":{"crease":["B","E"],"moving":["A1","B","E"],"deg":90} 让视频演折起过程',
    },
  ];
}

// ---------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------

/**
 * 延长线求交的派生点：两条直线必须真的相交。
 *
 * "延长 DM 交 AA₁ 于 P" 是立体几何作截面的标准手法，但它成立的前提是
 * 这两条线**共面且不平行**。模型经常随手写，方向其实异面——那样解出来的
 * 是一个"两线最近点"式的假点，位置毫无意义却看着像真的。
 * 这里按"两线最短距离"判：> 容差 就是异面，直接打回。
 */
/**
 * 「直线 K 与 L 异面/平行」时的补救提示：保留其中一条，枚举所有与它
 * 共面相交的已声明线段，给模型一份**真实可选**的清单。
 *
 * 为什么需要：体检报错里的示例线对曾是硬编码的（上一道题的答案），
 * 模型照抄就声明出第二条异面线对，越改越错。程序算得出的东西
 * 不该让模型猜——这里算出来给到报错文案里。
 *
 * 与保留线共享端点的线段跳过：交点就是已有顶点，没有构造价值。
 */
export function intersectCandidates(kept: [string, string], pts: Map<string, V3>, cap = 8): string[] {
  const A = pts.get(kept[0]);
  const B = pts.get(kept[1]);
  if (!A || !B) return [];
  const r = sub3(B, A);
  const rl = len3(r);
  if (rl < 1e-9) return [];

  let scale = 1;
  for (const p of pts.values()) {
    scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  }
  const tol = 1e-4 * scale;

  const ids = [...pts.keys()].sort();
  const out: string[] = [];
  for (let i = 0; i < ids.length && out.length < cap; i++) {
    for (let j = i + 1; j < ids.length && out.length < cap; j++) {
      const X = ids[i];
      const Y = ids[j];
      if (X === kept[0] || X === kept[1] || Y === kept[0] || Y === kept[1]) continue;
      const P = pts.get(X)!;
      const Q = pts.get(Y)!;
      const w = sub3(Q, P);
      const n = cross3(r, w);
      const nl = len3(n);
      if (nl <= 1e-9 * (rl * len3(w) + 1e-9)) continue; // 平行/重合
      const gap = Math.abs(dot3(sub3(P, A), n)) / nl;
      if (gap > tol) continue; // 异面
      // 交点若就是某个已声明顶点（如 CC1 恰好穿过 M），没有构造价值，跳过
      const n2 = nl * nl;
      const t = dot3(cross3(sub3(P, A), w), n) / n2;
      const hit: V3 = [A[0] + t * r[0], A[1] + t * r[1], A[2] + t * r[2]];
      let coincides = false;
      for (const p of pts.values()) {
        if (Math.abs(p[0] - hit[0]) + Math.abs(p[1] - hit[1]) + Math.abs(p[2] - hit[2]) <= 3 * tol) {
          coincides = true;
          break;
        }
      }
      if (coincides) continue;
      out.push(`${X}${Y}`);
    }
  }
  return out;
}

/** 把候选线对拼进报错文案（两条保留线各算一遍） */
function candidateHint(l1: [string, string], l2: [string, string], pts: Map<string, V3>): string {
  const parts: string[] = [];
  const c1 = intersectCandidates(l1, pts);
  if (c1.length > 0) parts.push(`若保留直线 ${l1[0]}${l1[1]}，与它共面相交的已声明线段有：${c1.join('、')}`);
  const c2 = intersectCandidates(l2, pts);
  if (c2.length > 0) parts.push(`若保留直线 ${l2[0]}${l2[1]}，与它共面相交的已声明线段有：${c2.join('、')}`);
  return parts.length > 0 ? `可用的候选（程序实测，不是示例）：${parts.join('；')}。` : '';
}

function checkIntersectDerives(scene: Scene3D, pts: Map<string, V3>): Issue[] {
  const issues: Issue[] = [];
  let scale = 1;
  for (const p of pts.values()) {
    scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  }
  const tol = 1e-4 * scale;

  for (const obj of scene.objects) {
    if (obj.type !== 'point3' || obj.derive?.kind !== 'intersect') continue;
    const d = obj.derive;
    const A = pts.get(d.l1[0]);
    const B = pts.get(d.l1[1]);
    const C = pts.get(d.l2[0]);
    const D = pts.get(d.l2[1]);
    if (!A || !B || !C || !D) continue; // 缺点由 collectPoints 报
    const r = sub3(B, A);
    const w = sub3(D, C);
    const n = cross3(r, w);
    const nl = len3(n);
    const pair = `直线 ${d.l1[0]}${d.l1[1]} 与 ${d.l2[0]}${d.l2[1]}`;
    if (nl <= 1e-9 * (len3(r) * len3(w) + 1e-9)) {
      issues.push({
        level: 'error',
        where: obj.id,
        message:
          `点 ${obj.id} 声明为「${pair} 的交点」，但这两条线平行或重合，交不出唯一的点。` +
          `换两条确实相交的线，或直接给 ${obj.id} 写坐标。` +
          candidateHint(d.l1, d.l2, pts),
      });
      continue;
    }
    const gap = Math.abs(dot3(sub3(C, A), n)) / nl;
    if (gap > tol) {
      issues.push({
        level: 'error',
        where: obj.id,
        message:
          `点 ${obj.id} 声明为「${pair} 的交点」，但这两条线是**异面**的` +
          `（最短距离 ${gap.toFixed(3)}），根本没有交点——算出来的位置没有意义。` +
          `检查这四点的坐标是否写错，或改用确实共面的两条线求交。` +
          candidateHint(d.l1, d.l2, pts),
      });
    }
  }
  return issues;
}

/** 分句：按中文句读把一段讲解切成小句，逐句判断"是不是在说点" */
const CLAUSE_SPLIT = /[。；;\n]/;
/** 出现这些字才认为这句话在讲"某个点"（避免把「面积 S」当成点 S） */
const POINT_CONTEXT = /[点交连延作取设过恰即]/;

/**
 * 步骤正文里点名的点，必须在图里真实存在。
 *
 * 真实事故（2026-11-06，正方体过 D、M、N 的截面）：板书逐行写着
 * 「延长 DM 交 AA₁ 于 P」「PQ ∩ AB = R」「截面为五边形 MRNDS」，
 * 但 P/Q/R/S 从来没在 objects 里声明过——图上只有 D、M、N。
 * 用户看到的是"答案上写了四个点，图上凭空少四个"。
 *
 * 旧体检只看 steps[*].highlight/reveal 里的 id，**不看正文**，
 * 所以这条一直是空的。现在补上，并且给出可执行的补法。
 *
 * 判定收得很紧，宁可漏也不误报：
 *   · 只认"独立出现"的单字母（可带下标）——ABCD、A₁B₁ 这种连写不拆；
 *   · 只在小句里出现「点/交/连/延长/作/取/设/过」等字时才当真（避开面积 S、体积 V）；
 *   · 至少要有 3 个已声明顶点（否则不是点线图，别管）。
 */
function checkStepPointRefs(scene: Scene3D, pts: Map<string, V3>): Issue[] {
  const steps = scene.steps ?? [];
  if (steps.length === 0 || pts.size < 3) return [];

  /** 画面上真的有点、有字母的那些名字（报错文案里用它当"图上有哪些点"） */
  const drawn = new Set<string>();
  /** 可以在正文里出现的名字：画出来的 + 只参与计算的那些 */
  const known = new Set<string>();
  const noteName = (v: unknown) => {
    if (typeof v !== 'string' || v.trim() === '') return null;
    const n = normalizeVertexToken(v);
    drawn.add(n);
    known.add(n);
    return n;
  };
  for (const o of scene.objects) {
    if (o.type !== 'point3') continue;
    const hidden = (o as { hidden?: boolean }).hidden === true;
    if (hidden) {
      // 折前的 A：图上是 A₁，但正文写"把 △ABE 折起"时提到 A 完全正常
      if (typeof o.id === 'string') known.add(normalizeVertexToken(o.id));
      if (typeof o.label === 'string') known.add(normalizeVertexToken(o.label));
      continue;
    }
    noteName(o.id);
    noteName(o.label);
    // 折出来的点，正文里提它的"前身"（derive.of）也是对的
    const d = (o as { derive?: { kind?: string; of?: unknown } }).derive;
    if (d && d.kind === 'fold' && typeof d.of === 'string') {
      known.add(normalizeVertexToken(d.of));
    }
  }

  /**
   * 假设点（"是否存在点 P"、"设点 P 在 A₁C 上"）不该被要求画出来——
   * 存在性问题的答案是"存在/不存在"，先把点画在某个位置反而误导。
   * 只认"点 X"这种明确写法，且小句里得有存在/假设的口气，
   * 避免把"设 O 为对角线的交点"这类真正该画的点也放过。
   */
  const hypothetical = (clause: string): Set<string> => {
    const out = new Set<string>();
    if (!/是否存在|存在|假设|不妨设|任取|设点|若点/.test(clause)) return out;
    // "设点 O 为对角线交点"是**定义**一个该画的点，不是假设点——放过它就漏了
    if (/中点|交点|垂足|重心|外心|内心|中心|分点/.test(clause)) return out;
    for (const m of clause.matchAll(/点\s*([A-Z]\d?)/g)) out.add(normalizeVertexToken(m[1]));
    for (const m of clause.matchAll(/(?:^|[^A-Za-z0-9])([A-Z]\d?)\s*点/g)) {
      out.add(normalizeVertexToken(m[1]));
    }
    return out;
  };

  const issues: Issue[] = [];
  steps.forEach((step, i) => {
    const text = String(step.text ?? '');
    const missing = new Set<string>();
    for (const clause of text.split(CLAUSE_SPLIT)) {
      if (!POINT_CONTEXT.test(clause)) continue;
      const norm = normalizeVertexToken(clause);
      const hyp = hypothetical(norm);
      // 独立出现的 大写字母 + 可选数字；前后不能粘连其它字母数字
      const re = /(^|[^A-Za-z0-9])([A-Z]\d?)(?![A-Za-z0-9])/g;
      for (const m of norm.matchAll(re)) {
        const name = m[2];
        if (known.has(name) || hyp.has(name)) continue;
        missing.add(name);
      }
    }
    if (missing.size === 0) return;
    const list = [...missing];
    issues.push({
      level: 'error',
      where: `steps[${i}]`,
      message:
        `第 ${i + 1} 步的文字里点了 ${list.join('、')} 这几个点，但图里没有它们` +
        `（objects 里声明的顶点是 ${[...drawn].join('、')}）——` +
        `读者会看到"讲解提到、图上找不到"。三选一：` +
        `① 这些点确实要画：在 objects 里补 point3，用 derive 让程序算坐标` +
        `（延长线交点用 intersect、中点用 midpoint、定比分点用 section），` +
        `**线对必须挑本题里真实共面相交的两条线**——不要照抄报错里的示例，` +
        `也不要手写坐标；` +
        `② 只是文字里的记号：改成图上已有的顶点名；` +
        `③ 不需要标到图上：把这句话删掉或改写，不要出现没画出来的点`,
    });
  });
  return issues;
}

/* ===============================================================
 * 「平面 X ∩ 平面 Y = PQ」——中文教材的标准写法，程序必须核对
 *
 * 这类断言很容易写错：把"看起来在该面上的一条线"当成交线（如把 AC 写成
 * 平面 A₁BD 与底面的交线）。错了图还是对的，只有文字错，学生照着记就记反了。
 *
 * 判定原则：
 *   ① 只认严格句式，名字必须能按已声明顶点**完整拆开**，否则静默跳过（绝不猜）
 *   ② 两个平面平行/重合 → 根本交不出这条线
 *   ③ 交线端点必须**同时落在两个平面上**（到两平面距离都在容差内）
 * =============================================================== */

/** 把「A1BD」这种连写名字按已声明顶点拆成 id 列表；拆不干净返回 null */
function splitVertexRun(token: string, byNorm: Map<string, string>): string[] | null {
  const norm = normalizeVertexToken(token);
  const pool = [...byNorm.keys()].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let i = 0;
  while (i < norm.length) {
    const hit = pool.find((id) => norm.startsWith(id, i));
    if (!hit) return null;
    out.push(byNorm.get(hit)!);
    i += hit.length;
  }
  return out;
}

/** 由一组顶点定一张平面（用不共线的三点），定不出来返回 null */
function planeOfIds(
  ids: string[],
  pts: Map<string, V3>,
): { a: V3; b: V3; c: V3; n: V3 } | null {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (let k = j + 1; k < ids.length; k++) {
        const A = pts.get(ids[i]);
        const B = pts.get(ids[j]);
        const C = pts.get(ids[k]);
        if (!A || !B || !C) continue;
        const n = cross3(sub3(B, A), sub3(C, A));
        if (len3(n) > 1e-9) return { a: A, b: B, c: C, n };
      }
    }
  }
  return null;
}

function checkPlaneIntersectClaims(scene: Scene3D, pts: Map<string, V3>): Issue[] {
  const ids = [...pts.keys()];
  if (ids.length < 5 || !(scene.steps ?? []).length) return [];

  const byNorm = new Map<string, string>();
  for (const id of ids) {
    const key = normalizeVertexToken(id);
    if (!byNorm.has(key)) byNorm.set(key, id);
  }

  let scale = 1;
  for (const p of pts.values()) {
    scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  }
  const tol = REL_TOL * scale;

  // 只认两种教材写法：`平面X ∩ 平面Y = PQ`、`平面X 与 平面Y 交于(直线) PQ`
  const RUN = '[A-Za-z0-9₀-₉]{2,12}';
  const patterns = [
    new RegExp(`平面\\s*(${RUN})\\s*[∩∩]\\s*平面\\s*(${RUN})\\s*(?:=|＝|为)\\s*(${RUN})`, 'g'),
    new RegExp(`平面\\s*(${RUN})\\s*(?:与|和)\\s*平面\\s*(${RUN})\\s*交于\\s*(?:直线)?\\s*(${RUN})`, 'g'),
  ];

  const issues: Issue[] = [];
  const seen = new Set<string>();

  (scene.steps ?? []).forEach((step, si) => {
    const text = String(step.text ?? '');
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const [whole, n1, n2, lineTok] = m;
        if (n1 === n2) continue;

        const p1 = splitVertexRun(n1, byNorm);
        const p2 = splitVertexRun(n2, byNorm);
        const ends = splitVertexRun(lineTok, byNorm);
        // 名字里有点没声明的字母 → 拆不干净，不猜（缺点由 checkStepPointRefs 报）
        if (!p1 || !p2 || !ends) continue;
        if (new Set(p1).size < 3 || new Set(p2).size < 3) continue;
        if (new Set(ends).size !== 2) continue;

        const key = `${n1}|${n2}|${lineTok}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const pl1 = planeOfIds(p1, pts);
        const pl2 = planeOfIds(p2, pts);
        if (!pl1 || !pl2) continue; // 点共线等，交给别的检查

        const n1u = mul3(pl1.n, 1 / len3(pl1.n));
        const n2u = mul3(pl2.n, 1 / len3(pl2.n));
        const half = len3(cross3(n1u, n2u));

        if (half <= 1e-6) {
          // 平行或重合
          const gap = Math.abs(dot3(sub3(pl2.a, pl1.a), n1u));
          const where = `steps[${si}]`;
          issues.push({
            level: 'error',
            where,
            message:
              gap <= tol
                ? `第 ${si + 1} 步写「${whole}」，但平面 ${n1} 与平面 ${n2} 是**同一个平面**（重合），` +
                  `重合的平面交不出唯一的一条直线。换个说法，或重新确认这两个平面的顶点`
                : `第 ${si + 1} 步写「${whole}」，但平面 ${n1} 与平面 ${n2} 是**平行**的` +
                  `（法向夹角实测 ${(Math.asin(Math.min(1, half)) * 180 / Math.PI).toFixed(1)}°，间距 ${gap.toFixed(3)}），` +
                  `平行平面没有交线。先确认这两组顶点各自是不是在同一个平面上`,
          });
          continue;
        }

        // 交线存在 → 端点必须同时落在两个平面上
        const bad: string[] = [];
        for (const id of ends) {
          const P = pts.get(id);
          if (!P) continue;
          const d1 = Math.abs(dot3(sub3(P, pl1.a), n1u));
          const d2 = Math.abs(dot3(sub3(P, pl2.a), n2u));
          if (Math.max(d1, d2) > tol) {
            bad.push(`${id}${fmtV(P)}（到平面 ${n1} 距离 ${d1.toFixed(3)}、到平面 ${n2} 距离 ${d2.toFixed(3)}）`);
          }
        }
        if (bad.length === 0) continue;

        issues.push({
          level: 'error',
          where: `steps[${si}]`,
          message:
            `第 ${si + 1} 步写「${whole}」，但交线上的端点不在两个平面上：${bad.join('；')}。` +
            `两平面的交线必须**同时属于这两个平面**——` +
            `端点要么换成同时在这两个面上的两个点，要么改成"这条线在其中一个面上"的表述，` +
            `不要把它写成两面的交线`,
        });
      }
    }
  });

  return issues;
}

export function verifyScene3D(scene: Scene3D): Issue[] {
  const scope = defaultScope(scene);
  const { pts, issues: pointIssues } = collectPoints(scene, scope);
  const hasCurved = scene.objects.some((o) => isCurved3(o));
  const solidSpecs = resolveSolidSpecs(scene, pts, scope);
  // 球心 / 内心是"算出来的结构点"，不参与"顶点重合 = 构造错误"的判定
  const specialPoints = new Set<string>();
  for (const o of scene.objects) {
    if (o.type === 'point3' && o.derive) {
      const k = o.derive.kind;
      if (k === 'circumcenter' || k === 'incenter') specialPoints.add(o.id);
    }
  }

  const sanity = checkGeometrySanity(pts, hasCurved, specialPoints);

  const all: Issue[] = [
    ...pointIssues,
    ...sanity.issues,
    ...checkEdges(scene, pts),
    ...checkFaces(scene, pts),
    ...solidSpecs.issues,
    ...checkSections(scene, pts, scope, solidSpecs.specs),
    ...checkSectionClaims(scene),
    ...checkPlaneIntersectClaims(scene, pts),
    ...checkIntersectDerives(scene, pts),
    ...checkStepPointRefs(scene, pts),
    ...checkIsolatedPoints(scene, pts),
    ...checkConstraints(scene, pts, scope),
    ...checkReadouts(scene, scope),
    ...checkSteps(scene),
    ...checkCamera(scene),
    ...checkFold(scene, pts),
    ...checkFoldDerives(scene, pts),
    ...checkFoldMissing(scene),
  ];

  // 图形整体被压扁（全部点共面/共线）时，只回传这一条根因。
  //
  // 真实事故：立方体 8 个顶点 z 全 0，体检报 9 条 error，根因「所有顶点共面」
  // 排在第 5 位，前后是"顶点重合""AB ⊥ AA₁ 不成立"这些**症状**。
  // 模型照着症状改，改了 3 轮越改越偏。补上高度后 7 条会自动消失。
  if (sanity.degenerate) {
    const extra = all.filter((i) => i.level === 'error').length + sanity.suppressed;
    const note =
      extra > 0
        ? `（另有 ${extra} 条错误是图形被压扁的连带现象，先别管它们——把厚度补上，重新体检时会自动消失）`
        : '';
    return [...pointIssues, { ...sanity.degenerate, message: sanity.degenerate.message + note }];
  }

  return all;
}
