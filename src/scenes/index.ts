/**
 * scenes/index.ts —— 场景注册表
 *
 * 新增场景的步骤：
 *   1. 在 scenes/ 下新建一个文件，导出一个 defaults 和一个 build(params)；
 *   2. 在下面的数组里加一行；
 *   3. 完事——UI 的标签页、滑杆、渲染全部自动生效。
 */
import type { Scene } from '../protocol/scene';
import type { Scene3D } from '../protocol/scene3d';
import { buildParabola, parabolaDefaults } from './parabola';
import { buildUnitCircle, unitCircleDefaults } from './unitCircle';
import { buildTriangle, triangleDefaults } from './triangle';
import { buildLine, lineDefaults } from './exercise-line';
import { buildTangent, tangentDefaults } from './exercise-tangent';
import { buildCube, cubeDefaults, buildTetra, tetraDefaults } from './solid';
import {
  buildCylinder,
  cylinderDefaults,
  buildRevolution,
  revDefaults,
  buildTetraSpheres,
  tetraSpheresDefaults,
  buildCylSection,
  cylSectionDefaults,
  buildCubeSection,
  cubeSectionDefaults,
} from './solid';

export interface SceneEntry {
  key: string;
  name: string;
  defaults: Record<string, number>;
  /** 2D 场景返回 Scene，立体场景返回 Scene3D（带 space:'3d' 判别字段）*/
  build: (params: Record<string, number>) => Scene | Scene3D;
}

export const sceneRegistry: SceneEntry[] = [
  {
    key: 'parabola',
    name: '二次函数',
    defaults: parabolaDefaults,
    build: buildParabola,
  },
  {
    key: 'unitCircle',
    name: '单位圆与正弦',
    defaults: unitCircleDefaults,
    build: buildUnitCircle,
  },
  {
    key: 'triangle',
    name: '可拖拽三角形',
    defaults: triangleDefaults,
    build: buildTriangle,
  },
  {
    key: 'exLine',
    name: '练习 1：两点定直线',
    defaults: lineDefaults,
    build: buildLine,
  },
  {
    key: 'exTangent',
    name: '练习 2：圆的切线',
    defaults: tangentDefaults,
    build: buildTangent,
  },
  {
    key: 'cube',
    name: '正方体（立体）',
    defaults: cubeDefaults,
    build: buildCube,
  },
  {
    key: 'tetra',
    name: '正四面体（立体）',
    defaults: tetraDefaults,
    build: buildTetra,
  },
  {
    key: 'cylinder',
    name: '圆柱（立体）',
    defaults: cylinderDefaults,
    build: buildCylinder,
  },
  {
    key: 'revolution',
    name: '圆锥与球（立体）',
    defaults: revDefaults,
    build: buildRevolution,
  },
  {
    key: 'tetraSpheres',
    name: '内切球与外接球（立体）',
    defaults: tetraSpheresDefaults,
    build: buildTetraSpheres,
  },
  {
    key: 'cylSection',
    name: '斜截圆柱（立体）',
    defaults: cylSectionDefaults,
    build: buildCylSection,
  },
  {
    key: 'cubeSection',
    name: '正方体截面（立体）',
    defaults: cubeSectionDefaults,
    build: buildCubeSection,
  },
];
