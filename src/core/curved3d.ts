/**
 * curved3d.ts —— 旋转体（圆柱 / 圆锥 / 球）的轮廓计算
 *
 * 这个文件只做**数学**，不碰 three 的渲染对象。返回的是"该画哪些折线段、
 * 哪几段是虚线"，renderer3d 拿去做成 Line。
 *
 * ===== 为什么旋转体不能沿用多面体那套虚实判断 =====
 *
 * 多面体的棱是有限的，可以逐条用"两侧的面是否朝向相机"来判。
 * 旋转体没有棱：它的轮廓是**随视角连续变化**的曲线——
 * 圆柱的母线位置、椭圆的虚实分界点，转一个角度就换一批。
 * 所以必须每帧按当前相机位置重算，这也是它单独成模块的原因。
 *
 * ===== 课本画法（本条最重要）=====
 *
 * 圆柱：上下两个椭圆 + 两条母线。对着相机的那个底面椭圆整圈实线；
 *       背对相机的那个椭圆，靠观察者的一半实线、另一半虚线。
 * 圆锥：底面椭圆 + 从锥尖到椭圆的**两条切线**（母线）。
 * 球：  一个轮廓圆 + 赤道椭圆（前半实线、后半虚线）。
 *
 * 这套画法由"侧面外法线是否朝向相机"统一决定，三个体共用一套判据。
 */

import * as THREE from 'three';

const TAU = Math.PI * 2;
/** 椭圆采样段数。128 段在 1440px 宽的画布上看不出折线 */
const SEG = 128;

/** 解析后的旋转体（值都算成数字了，渲染和体检用同一份） */
export interface SolidGeom {
  id: string;
  kind: 'cylinder' | 'cone' | 'sphere';
  /** 轴起点：圆柱/圆锥的底面圆心；球心 */
  a: THREE.Vector3;
  /** 轴终点：圆柱顶面圆心 / 圆锥锥尖；球与 a 相同 */
  b: THREE.Vector3;
  r: number;
  opacity: number;
  color?: string;
  label?: string;
  labelOffset?: [number, number, number];
  /** = true 表示这一步没讲到它，整体压暗（由 applyStep 设置） */
  dim?: boolean;
}

/** 一段待画的折线 */
export interface CurveRun {
  pts: THREE.Vector3[];
  dashed: boolean;
}

/** 与 u 垂直的任意单位向量：跟三个坐标轴里"最不平行的那个"叉乘，避免退化 */
function perpTo(u: THREE.Vector3): THREE.Vector3 {
  const ax = Math.abs(u.x);
  const ay = Math.abs(u.y);
  const az = Math.abs(u.z);
  const axis =
    ax <= ay && ax <= az
      ? new THREE.Vector3(1, 0, 0)
      : ay <= az
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3().crossVectors(u, axis).normalize();
}

interface AxisFrame {
  u: THREE.Vector3;
  e1: THREE.Vector3;
  e2: THREE.Vector3;
  h: number;
}

/** 轴 a→b 的正交基；轴长为 0 返回 null（体检器会单独报错） */
export function axisFrame(a: THREE.Vector3, b: THREE.Vector3): AxisFrame | null {
  const axis = b.clone().sub(a);
  const h = axis.length();
  if (h < 1e-9) return null;
  const u = axis.divideScalar(h);
  const e1 = perpTo(u);
  const e2 = new THREE.Vector3().crossVectors(u, e1).normalize();
  return { u, e1, e2, h };
}

/** 圆周上均匀采样的点（首尾不重复，方便按"闭合环"处理） */
function ring(
  center: THREE.Vector3,
  e1: THREE.Vector3,
  e2: THREE.Vector3,
  r: number,
  n = SEG,
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    out.push(
      center
        .clone()
        .addScaledVector(e1, r * Math.cos(t))
        .addScaledVector(e2, r * Math.sin(t)),
    );
  }
  return out;
}

/** 圆周第 i 个采样点的径向单位向量 */
function radialAt(i: number, n: number, e1: THREE.Vector3, e2: THREE.Vector3): THREE.Vector3 {
  const t = (i / n) * TAU;
  return e1.clone().multiplyScalar(Math.cos(t)).addScaledVector(e2, Math.sin(t));
}

/**
 * 把闭合环按标记拆成连续段。
 *
 * 为什么要"合并首尾"：环是从 0° 开始采样的，如果 0° 恰好落在可见区中间，
 * 就会得到"开头一小段 + 结尾一小段"，其实是同一段。不合并的话接缝处会
 * 多出一个断口，看着像画错了。
 */
function splitRuns(
  pts: THREE.Vector3[],
  flags: boolean[],
  want: boolean,
): THREE.Vector3[][] {
  const n = pts.length;
  const runs: THREE.Vector3[][] = [];
  let cur: THREE.Vector3[] | null = null;
  for (let i = 0; i < n; i++) {
    if (flags[i] === want) {
      if (cur) {
        cur.push(pts[i]);
      } else {
        cur = [pts[i]];
        runs.push(cur);
      }
    } else {
      cur = null;
    }
  }
  if (runs.length > 1 && flags[0] === want && flags[n - 1] === want) {
    runs[0] = [...runs[runs.length - 1], ...runs[0]];
    runs.pop();
  }
  // 一个点的段画不出线
  return runs.filter((r) => r.length >= 2);
}
/** 截面曲线也按"外法线朝向相机"分虚实，共用这个拆段逻辑 */
export { splitRuns };

/**
 * 解 A·cosθ + B·sinθ = K，返回 0~2 个角度。
 * 轮廓线的位置就是这个方程的解：法线与视线垂直的地方。
 * 无解（相机跑到物体内部）时返回空——这时没有轮廓线可画。
 */
function solveSilhouette(A: number, B: number, K: number): number[] {
  const R = Math.hypot(A, B);
  if (R < 1e-9) return [];
  const c = K / R;
  if (Math.abs(c) > 1) return [];
  const phi = Math.atan2(B, A);
  const ac = Math.acos(c);
  return [phi + ac, phi - ac];
}

/**
 * 侧面外法线是否朝向相机（逐采样点）。
 *
 * 法线 = radialWeight · 径向 + axialWeight · 轴向：
 *   圆柱  → 法线纯径向（权重 0 / 1）；
 *   圆锥  → 法线 ∝ h·径向 + r·轴向（越高的锥越"平"，法线越贴近水平）。
 * 只关心正负号，所以不必归一化。
 */
function lateralFlags(
  pts: THREE.Vector3[],
  e1: THREE.Vector3,
  e2: THREE.Vector3,
  cam: THREE.Vector3,
  u?: THREE.Vector3,
  axialWeight = 0,
  radialWeight = 1,
): boolean[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const nrm = radialAt(i, n, e1, e2).multiplyScalar(radialWeight);
    if (u) nrm.addScaledVector(u, axialWeight);
    return nrm.dot(cam.clone().sub(p)) > 0;
  });
}

/** 一个端点圆的虚实：对着相机的那圈整圈实线，背对的那圈拆前半/后半 */
function pushRimRuns(
  runs: CurveRun[],
  pts: THREE.Vector3[],
  capFacesCamera: boolean,
  lateral: boolean[],
) {
  if (capFacesCamera) {
    // 整个底面/顶面看得见 → 它是外轮廓的一部分，整圈实线
    runs.push({ pts: [...pts, pts[0]], dashed: false });
    return;
  }
  for (const r of splitRuns(pts, lateral, true)) runs.push({ pts: r, dashed: false });
  for (const r of splitRuns(pts, lateral, false)) runs.push({ pts: r, dashed: true });
}

export function cylinderRuns(g: SolidGeom, cam: THREE.Vector3): CurveRun[] {
  const f = axisFrame(g.a, g.b);
  if (!f) return [];
  const runs: CurveRun[] = [];

  const bottom = ring(g.a, f.e1, f.e2, g.r);
  const top = ring(g.b, f.e1, f.e2, g.r);
  const lateralBottom = lateralFlags(bottom, f.e1, f.e2, cam);
  const lateralTop = lateralFlags(top, f.e1, f.e2, cam);

  // 底面法线朝下，顶面法线朝上
  const bottomFaces = f.u.clone().negate().dot(cam.clone().sub(g.a)) > 0;
  const topFaces = f.u.dot(cam.clone().sub(g.b)) > 0;

  pushRimRuns(runs, bottom, bottomFaces, lateralBottom);
  pushRimRuns(runs, top, topFaces, lateralTop);

  // 两条母线：法线与视线垂直处。圆柱的轴向不影响这个方程，
  // 因为法线没有轴向分量 → 上下两个椭圆的轮廓点在同一角度上。
  const mid = g.a.clone().add(g.b).multiplyScalar(0.5);
  const d = cam.clone().sub(mid);
  for (const th of solveSilhouette(f.e1.dot(d), f.e2.dot(d), g.r)) {
    const dir = f.e1
      .clone()
      .multiplyScalar(Math.cos(th))
      .addScaledVector(f.e2, Math.sin(th));
    runs.push({
      pts: [g.a.clone().addScaledVector(dir, g.r), g.b.clone().addScaledVector(dir, g.r)],
      dashed: false,
    });
  }
  return runs;
}

export function coneRuns(g: SolidGeom, cam: THREE.Vector3): CurveRun[] {
  const f = axisFrame(g.a, g.b); // a = 底面圆心, b = 锥尖
  if (!f) return [];
  const runs: CurveRun[] = [];

  const base = ring(g.a, f.e1, f.e2, g.r);
  // 圆锥侧面在底面圆周处的法线 ∝ h·径向 + r·轴向（见文件头推导）
  const lateral = lateralFlags(base, f.e1, f.e2, cam, f.u, g.r, f.h);
  const baseFaces = f.u.clone().negate().dot(cam.clone().sub(g.a)) > 0;
  pushRimRuns(runs, base, baseFaces, lateral);

  // 母线：从锥尖到底面圆周的切线。
  // 方程 A cosθ + B sinθ = r·(1 − (u·d)/h)，推导：
  //   法线 n = h·n̂ + r·u，点 P = C + r·n̂，n·(cam − P) = 0
  //   → h(n̂·d) − h·r + r(u·d) = 0 → n̂·d = r(1 − (u·d)/h)
  const d = cam.clone().sub(g.a);
  const K = g.r * (1 - f.u.dot(d) / f.h);
  for (const th of solveSilhouette(f.e1.dot(d), f.e2.dot(d), K)) {
    const dir = f.e1
      .clone()
      .multiplyScalar(Math.cos(th))
      .addScaledVector(f.e2, Math.sin(th));
    runs.push({
      pts: [g.a.clone().addScaledVector(dir, g.r), g.b.clone()],
      dashed: false,
    });
  }
  return runs;
}

export function sphereRuns(g: SolidGeom, cam: THREE.Vector3): CurveRun[] {
  const runs: CurveRun[] = [];

  // ① 轮廓圆：平面垂直于视线、过球心、半径 = r。它随视角转，必须每帧算
  const toCam = cam.clone().sub(g.a);
  if (toCam.lengthSq() < 1e-12) return runs;
  const n = toCam.normalize();
  const e1 = perpTo(n);
  const e2 = new THREE.Vector3().crossVectors(n, e1).normalize();
  const outline = ring(g.a, e1, e2, g.r, 96);
  runs.push({ pts: [...outline, outline[0]], dashed: false });

  // ② 赤道（水平大圆）：圆心正对观察者的那半实线，背面的半圈虚线。
  // 世界坐标里"上"是 three 的 y 轴，所以水平面的两个基向量取 x 和 z。
  const ex = new THREE.Vector3(1, 0, 0);
  const ez = new THREE.Vector3(0, 0, 1);
  const eq = ring(g.a, ex, ez, g.r, 96);
  const flags = eq.map((p, i) => radialAt(i, eq.length, ex, ez).dot(cam.clone().sub(p)) > 0);
  for (const r of splitRuns(eq, flags, true)) runs.push({ pts: r, dashed: false });
  for (const r of splitRuns(eq, flags, false)) runs.push({ pts: r, dashed: true });

  return runs;
}

/** 统一入口：按视角算出这个旋转体该画的全部线段 */
export function solidRuns(g: SolidGeom, cam: THREE.Vector3): CurveRun[] {
  if (g.kind === 'cylinder') return cylinderRuns(g, cam);
  if (g.kind === 'cone') return coneRuns(g, cam);
  return sphereRuns(g, cam);
}

/** 取景用的极值点：保证圆柱/球不会被画面裁掉 */
export function solidExtentPoints(g: SolidGeom): THREE.Vector3[] {
  if (g.kind === 'sphere') {
    return [
      g.a.clone().add(new THREE.Vector3(g.r, 0, 0)),
      g.a.clone().add(new THREE.Vector3(-g.r, 0, 0)),
      g.a.clone().add(new THREE.Vector3(0, g.r, 0)),
      g.a.clone().add(new THREE.Vector3(0, -g.r, 0)),
      g.a.clone().add(new THREE.Vector3(0, 0, g.r)),
      g.a.clone().add(new THREE.Vector3(0, 0, -g.r)),
    ];
  }
  const f = axisFrame(g.a, g.b);
  if (!f) return [g.a.clone(), g.b.clone()];
  const pts = [g.a.clone(), g.b.clone()];
  for (const center of [g.a, g.b]) {
    for (let i = 0; i < 8; i++) {
      const t = (i / 8) * TAU;
      pts.push(
        center
          .clone()
          .addScaledVector(f.e1, g.r * Math.cos(t))
          .addScaledVector(f.e2, g.r * Math.sin(t)),
      );
    }
  }
  return pts;
}

/** 视觉中心（取景与"朝外"判定都用它）：圆柱/圆锥取轴中点，球取球心 */
export function solidCenter(g: SolidGeom): THREE.Vector3 {
  if (g.kind === 'sphere') return g.a.clone();
  return g.a.clone().add(g.b).multiplyScalar(0.5);
}
