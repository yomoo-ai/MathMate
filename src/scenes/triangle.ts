/**
 * triangle.ts —— 场景三：可拖拽三角形
 *
 * 教学点：三边长度、三个内角随顶点拖拽实时变化。
 * 技巧：顶点坐标本身就是参数（slider: false，不显示滑杆），
 * 拖拽写回参数 → 场景重建 → 边和角全部自动更新。
 * 角度弧用 ang() 辅助函数算方向，readouts 用余弦定理反解内角。
 */
import type { Scene } from '../protocol/scene';

export const triangleDefaults: Record<string, number> = {
  ax: -2,
  ay: -1,
  bx: 2,
  by: -1,
  cx: 0,
  cy: 2,
};

/** 余弦定理：已知三边，求 A 点的对角 */
const angleExpr = (px: string, py: string, qx: string, qy: string, rx: string, ry: string) =>
  `deg(acos((dist(${px},${py},${qx},${qy})^2 + dist(${px},${py},${rx},${ry})^2 - dist(${qx},${qy},${rx},${ry})^2) / (2*dist(${px},${py},${qx},${qy})*dist(${px},${py},${rx},${ry}))))`;

export function buildTriangle(params: Record<string, number>): Scene {
  return {
    meta: {
      title: '可拖拽三角形',
      subtitle: '拖动三个顶点，实时观察边长与内角变化',
    },
    view: { xMin: -4, xMax: 4, yMin: -3, yMax: 3.5 },
    params: [
      // slider: false —— 这些参数只靠拖拽修改，不出现在滑杆区
      { name: 'ax', label: 'A 的 x', min: -6, max: 6, step: 0.01, value: triangleDefaults.ax, slider: false },
      { name: 'ay', label: 'A 的 y', min: -6, max: 6, step: 0.01, value: triangleDefaults.ay, slider: false },
      { name: 'bx', label: 'B 的 x', min: -6, max: 6, step: 0.01, value: triangleDefaults.bx, slider: false },
      { name: 'by', label: 'B 的 y', min: -6, max: 6, step: 0.01, value: triangleDefaults.by, slider: false },
      { name: 'cx', label: 'C 的 x', min: -6, max: 6, step: 0.01, value: triangleDefaults.cx, slider: false },
      { name: 'cy', label: 'C 的 y', min: -6, max: 6, step: 0.01, value: triangleDefaults.cy, slider: false },
    ],
    objects: [
      {
        type: 'polygon',
        id: 'tri',
        points: ['ax, ay', 'bx, by', 'cx, cy'],
        fill: true,
        color: '#185fa5',
      },
      // 三个顶点，自由拖拽
      {
        type: 'point',
        id: 'A',
        at: 'ax, ay',
        draggable: true,
        dragBind: { x: 'ax', y: 'ay' },
        label: 'A',
      },
      {
        type: 'point',
        id: 'B',
        at: 'bx, by',
        draggable: true,
        dragBind: { x: 'bx', y: 'by' },
        label: 'B',
      },
      {
        type: 'point',
        id: 'C',
        at: 'cx, cy',
        draggable: true,
        dragBind: { x: 'cx', y: 'cy' },
        label: 'C',
      },
      // 三个内角弧（顶点退化共线时自动跳过）
      {
        type: 'arc',
        id: 'arcA',
        center: 'ax, ay',
        radius: '0.5',
        from: 'ang(ax,ay,bx,by)',
        to: 'ang(ax,ay,cx,cy)',
        color: '#d85a30',
      },
      {
        type: 'arc',
        id: 'arcB',
        center: 'bx, by',
        radius: '0.5',
        from: 'ang(bx,by,ax,ay)',
        to: 'ang(bx,by,cx,cy)',
        color: '#d85a30',
      },
      {
        type: 'arc',
        id: 'arcC',
        center: 'cx, cy',
        radius: '0.5',
        from: 'ang(cx,cy,ax,ay)',
        to: 'ang(cx,cy,bx,by)',
        color: '#d85a30',
      },
    ],
    readouts: [
      { label: 'AB', expr: 'dist(ax,ay,bx,by)' },
      { label: 'BC', expr: 'dist(bx,by,cx,cy)' },
      { label: 'CA', expr: 'dist(cx,cy,ax,ay)' },
      { label: '∠A', expr: angleExpr('ax', 'ay', 'bx', 'by', 'cx', 'cy'), unit: '°' },
      { label: '∠B', expr: angleExpr('bx', 'by', 'ax', 'ay', 'cx', 'cy'), unit: '°' },
      { label: '∠C', expr: angleExpr('cx', 'cy', 'ax', 'ay', 'bx', 'by'), unit: '°' },
    ],
  };
}
