/**
 * renderer3d.ts —— 立体几何渲染器
 *
 * 与 core/renderer.ts（2D 正交）并列，互不影响。
 * 差异不只是"多了个 z 轴"，有三处根本不同：
 *
 *   1. 相机：透视投影 + 球坐标绕物旋转（拖动改方位角/仰角，滚轮改距离）。
 *   2. 深度：面会挡住后面的棱，所以"被挡的棱要画虚线"这件事必须**算**出来，
 *      不能像 2D 那样按声明顺序画。
 *   3. 光照：没有光，多面体的面全是同一个色块，看不出立体。
 *
 * ===== 遮挡判断（这段是立体几何图和普通 3D 渲染的分水岭）=====
 *
 * 课本规矩：看得见的棱画实线，被挡住画虚线。判断分两种情况：
 *
 *   ① 棱两侧都有面（多面体的棱）——用"面朝向"判断：
 *      对凸多面体，一条棱可见 ⟺ 它两侧的面至少有一个朝向相机。
 *      朝向怎么定？不用顶点绕序（LLM 极容易写反），而是看
 *      「面中心 - 整体形心」与「相机 - 面中心」是否同向。
 *      这个判据对任意绕序都成立，代价是只适用于凸多面体。
 *
 *   ② 棱两侧没有面（正方体的体对角线、辅助线）——用射线求交：
 *      从相机射向棱的中点，如果半路撞到某个面，说明它躲在实体内部。
 *
 * 为什么不用统一射线法？因为射线法在每个旋转角度都要打一次，
 * 且采样点刚好贴着面时会在实线/虚线之间闪。① 是解析解，稳。
 */

import * as THREE from 'three';
import { evalNumber, evalVec3, normalizeExpr } from '../protocol/expr';
import { evalPointRef } from '../protocol/resolve3d';
import {
  buildPolySpec,
  solveSectionOn,
  type PlaneSpec,
  type SectionTarget,
  type SolidSpec,
} from '../protocol/sectionMath';
import { makeTextSprite } from './textSprite';
import type { AnnotationMark3D } from './annotations3d';
import { foldExtent, foldPositions, planFold, type FoldPlan } from '../protocol/fold3d';
import {
  axisFrame,
  solidCenter,
  solidExtentPoints,
  solidRuns,
  type CurveRun,
  type SolidGeom,
} from './curved3d';
import type {
  Edge3Object,
  Face3Object,
  Point3Object,
  Scene3D,
  Section3Object,
  Vec3,
  Vec3Like,
} from '../protocol/scene3d';
import { isCurved3 } from '../protocol/scene3d';

/** 截面交线的默认颜色：一抹深紫红，和蓝灰的面、深灰的棱都拉得开 */
const SECTION_COLOR = '#8a3f6b';

/** 数学坐标的三元组小工具（截面平面在数学坐标里算，和 sectionSolids 同系） */
const subM = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossM = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const COLORS = {
  point: 0x2c6fb5,
  edge: 0x33322e,
  edgeHidden: 0x8f8c83,
  face: 0x7aa7d6,
  label: '#2c2c2a',
};

/** 视频讲解的"重点色"（与 2D 一致）：本句讲到的棱换成暖橙 */
const HL_COLOR = 0xea580c;

// -------------------------------------------------------------
// 主题化颜色（与 2D 的 setBg 同一套思路）：
// 浅色工程风是默认值；课件深色主题下棱、标签、标注都要换成亮色系，
// 否则深底上深灰棱几乎隐身（真踩过：将军饮马的水面在旧默认下消失）。
// -------------------------------------------------------------
const DARK_FOLLOW = {
  edge: '#9aa6c0',
  edgeHidden: '#5f6a82',
  label: '#e8ecf6',
  ann: '#f0a468',
};

type Follow3 = { edge?: string; edgeHidden?: string; label?: string; ann?: string };

/** 三条坐标轴的颜色：沿用数学软件的约定（x 红 / y 绿 / z 蓝），但调低饱和 */
const AXIS_COLORS = {
  x: 0xb8544a,
  y: 0x4a8a5c,
  z: 0x4a6ba8,
} as const;

/** 数学坐标 (x 右, y 里, z 上) → three 坐标 (x 右, y 上, z 朝观察者) */
function toV3(p: Vec3): THREE.Vector3 {
  return new THREE.Vector3(p[0], p[2], p[1]);
}

interface EdgeItem {
  line: THREE.Line;
  solidMat: THREE.LineBasicMaterial;
  dashedMat: THREE.LineDashedMaterial;
  /** 对应的 edge3 对象 id——步骤高亮/渐显按 id 操作 */
  id: string;
  a: string;
  b: string;
  /** true=强制虚线 / false=强制实线 / undefined=自动判断 */
  forced?: boolean;
  dashedNow: boolean;
  /** 被"步骤高亮"压暗（当前步没讲到它） */
  dim: boolean;
  /** 实线/虚线各自的原本颜色——高亮结束后要能还回去 */
  baseColor: number;
  baseHiddenColor: number;
}

/** 构建动画的"已完成"状态：不在 buildMap 里的对象一律按这个算 */
const FULL_BUILD = { alpha: 1, grow: 1 };

interface FaceItem {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  /** 对应的 face3 对象 id */
  id: string;
  /** 顶点 id 列表——折起时顶点会动，几何要按它重算 */
  pids: string[];
  /** 面中心（three 坐标） */
  center: THREE.Vector3;
  /** 规范化后的顶点 id 对，用于找"这条棱的邻接面" */
  edges: Set<string>;
  opacity: number;
  dim: boolean;
  /** 入场构建的透明度系数（1=已完成；视频以外的场景恒为 1） */
  buildAlpha: number;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 旋转体轮廓的一段线。
 *
 * 为什么每个旋转体要预留一个"线段池"？
 * 圆椭的虚实分界随视角变，段的**数量**也会变（背面全被挡时是一段，
 * 正常角度是两段实+两段虚）。每帧新建/销毁 Line 会持续产生垃圾，
 * 所以预先留一批，用不到的把它 visible=false。
 */
interface CurvePiece {
  line: THREE.Line;
  solidMat: THREE.LineBasicMaterial;
  dashedMat: THREE.LineDashedMaterial;
  /** 原本的颜色：高亮换色之后要能还回去 */
  baseColor: number;
}

/** 一个解析好的截面：交线采样 + 每点法线（three 坐标），fill 是截面填充 */
interface SectionItem {
  id: string;
  /** 交线采样点（闭合，首尾不重复） */
  loop: THREE.Vector3[];
  /** 每个采样点处曲面的外法线（朝向相机 → 实线） */
  normals: THREE.Vector3[];
  /** 截面填充：以交线为边界的多边形（课本里"截面"就是画上阴影的那个椭圆） */
  fill: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  /** 截面中心（顶点是世界坐标，mesh 自身在原点，所以中心得单独存） */
  center: THREE.Vector3;
  opacity: number;
  color: THREE.Color;
  /** 这一步没讲到它 → 压暗 */
  dim: boolean;
  /** 入场构建的透明度系数（1=已完成） */
  buildAlpha: number;
}

export class Scene3DRenderer {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  /** 主题化颜色：默认浅色工程风，深色课件走 setBg 换 */
  private theme: { bg: string; edge: string; edgeHidden: string; label: string; ann: string } = {
    bg: '#f7f6f3',
    edge: '#33322e',
    edgeHidden: '#8f8c83',
    label: '#2c2c2a',
    ann: '#c2410c',
  };

  /**
   * 设置画布配色（背景 + 棱/标签/标注的跟随色）。
   * 立即生效：改清屏色 + 重建当前场景（材质颜色在建对象时取自 theme）。
   */
  setBg(bg: string, follow?: Follow3) {
    this.theme = {
      bg,
      edge: DARK_FOLLOW.edge,
      edgeHidden: DARK_FOLLOW.edgeHidden,
      label: DARK_FOLLOW.label,
      ann: DARK_FOLLOW.ann,
    };
    for (const [k, v] of Object.entries(follow ?? {})) {
      if (v != null) (this.theme as Record<string, string>)[k] = v;
    }
    this.renderer.setClearColor(new THREE.Color(this.theme.bg), 1);
    if (this.data) this.setScene(this.data, this.params, false);
  }

  /**
   * 参数被拖拽改变时回调——与 2D 的同名接口对齐。
   * 3D 场景目前没有可拖点（拖拽只用于轨道旋转），所以本字段暂无人触发；
   * 留着是为了让外壳能用同一个联合类型管理两种渲染器。
   */
  onParamChange?: (name: string, value: number) => void;
  /** 主光：方向固定在世界坐标，每帧平移到物体中心 */
  private keyLight: THREE.DirectionalLight;
  private contentGroup = new THREE.Group();
  private labelGroup = new THREE.Group();
  /**
   * 坐标轴单独一层。
   * 不放进 contentGroup 是有意的：轴是"参照系"，不属于题目内容，
   * 分步讲解压暗/渐显时不该跟着变化（否则讲第一步时坐标系先淡掉了）。
   */
  private axisGroup = new THREE.Group();

  private points = new Map<string, Vec3>();
  private edges: EdgeItem[] = [];
  private faces: FaceItem[] = [];
  private pointMeshes: THREE.Mesh[] = [];
  /** 标签：记录锚点世界坐标，位置在每帧按屏幕方向重算 */
  /** 标签：id 是它所属对象的 id，步骤渐显/压暗时要跟着一起变 */
  private labels: {
    sprite: THREE.Sprite;
    anchor: THREE.Vector3;
    id: string;
    /**
     * 锚点怎么来的：挂在哪几个顶点上、再加多少偏移。
     * 折起时顶点会动，标签必须跟着重算——不留这份来源，就只能让字母
     * 留在原地等棱转走（真实事故：折起来以后字母全飘在空中）。
     */
    src?: { pids: string[]; off: Vec3 };
  }[] = [];

  // ---- 旋转体（圆柱 / 圆锥 / 球）----
  /** 解析好的旋转体参数（半径、轴端点都算成数字了） */
  private solidGeoms: SolidGeom[] = [];
  /** 每个旋转体的轮廓线段池（每帧按视角重算） */
  private curvedPieces = new Map<string, CurvePiece[]>();
  /** 每个旋转体的曲面填充（几何固定，只有显隐和不透明度需要变） */
  private curvedFills = new Map<
    string,
    { meshes: THREE.Mesh[]; mats: THREE.MeshLambertMaterial[] }
  >();
  /** 旋转体的曲面也算"实体"，自由棱的遮挡射线要打到它 */
  private solidOccluders: THREE.Mesh[] = [];
  /** 旋转体的数学坐标版（截面求交在数学坐标里算，与 points 同系） */
  private sectionSolids = new Map<string, SolidSpec>();
  /** 截面 id → 它要切的目标（旋转体或多面体）；渲染与体检各持一份，算法同一个 */
  private sectionTargets = new Map<string, SectionTarget>();
  /** 已解析的截面：交线采样、每点法线、半透明平面 */
  private sections: SectionItem[] = [];
  /** 每个截面的交线线段池（虚实分界随视角变，同旋转体的池子一个道理） */
  private sectionPieces = new Map<string, CurvePiece[]>();
  /** 场景中心（多面体=顶点平均，有旋转体时把轴中点也算进去） */
  private sceneCenter = new THREE.Vector3();

  // ---- 分步讲解（与 2D 的 setStep 语义一致）----
  /** 对象 id → 它在三维场景里的网格/线，用于 reveal 显隐 */
  private idObjects = new Map<string, THREE.Object3D[]>();
  /** 顶点 id → 小球网格，用于高亮/压暗 */
  private pointMeshById = new Map<string, THREE.Mesh>();
  /** 当前步骤下"还没出场"的对象 id（面每帧重算可见性时要参考它） */
  private stepHidden = new Set<string>();
  private stepIndex = -1;

  // ---- 入场构建动画（视频专用）----
  //
  // 主画布从不开启，所以这里恒为空表，所有渲染行为与以前完全一致。
  // 视频打开时由 videoStudio 驱动：棱按 grow 从起点长到终点，点按 alpha 由小放大，
  // 面/截面/曲面按 alpha 淡入。为什么不用 drawRange 做棱的生长？因为一条棱只有
  // 两个顶点，drawRange 只能"有或没有"，做不到中间状态；直接改写终点坐标最稳。
  private buildOn = false;
  private buildMap = new Map<string, { alpha: number; grow: number }>();

  // ---- 步骤运镜（视频化讲解 阶段①）----
  // 切换步骤时相机不瞬移，而是在 tickCameraTween 里逐帧插值。
  // 只动 target（看向哪里）和 distance（多远），不动方位角/仰角——
  // 旋转容易让观看者晕，"飞过去看"比"转过去看"观感稳定。
  private camTween: {
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromDist: number;
    toDist: number;
    /**
     * 方位角/仰角补间：只有"转到某个视角"才给。
     * 分步运镜（flyToHighlight）刻意不转角度——旋转容易让人晕，
     * 但"讲底面就要转到能看见底面"这件事，只能靠转。
     */
    fromAz?: number;
    toAz?: number;
    fromEl?: number;
    toEl?: number;
    start: number;
    duration: number;
  } | null = null;

  private data: Scene3D | null = null;
  private params: Record<string, number> = {};

  // ---- 翻折（折起）----
  //
  // 场景里的坐标是**折好之后**的样子；播放器要在某一句把 moving 那块平面
  // 从"完全展开"折到声明的位置，所以这里存的是一份折起计划 + 当前角度偏移。
  // offset 语义：0 = 场景原样（折好），−deg = 完全展开。
  //
  // 为什么每帧不重跑 setScene？那里面要建点、建面、建棱、建标签、量尺寸、
  // 拟合相机，一套下来几百次对象分配；一秒 60 帧就是几万个垃圾对象，
  // 这台机器（i5-1035G1 + 核显）会直接掉到个位数帧率。
  // 所以折起走"只改动了的那几个顶点 + 就地重写依赖它们的几何"。
  private fold: FoldPlan | null = null;
  private foldOffset = 0;

  /**
   * 讲解视频的"红笔标注"层：本句的角度弧/直角方块/长度记号。
   * 只在本句显示——切句即整组清掉重画，不累积留痕
   * （3D 视角在慢转，多组标注叠在一起既乱又互相挡）。
   */
  private annGroup = new THREE.Group();

  /** 相机球坐标（度 / 世界单位）*/
  private azimuth = 35;
  private elevation = 18;
  private distance = 10;
  private target = new THREE.Vector3();

  /**
   * 视频板块专用：自动旋转周期（秒/圈）。0 = 不转。
   * 主画布永远是 0（视野纹丝不动）；讲解视频设成 40 秒一圈，
   * 让"这是个立体图"这件事自己交代清楚，而不靠忽远忽近的运镜。
   */
  autoRotateSeconds = 0;
  /** 非重点对象的压暗倍数（1 = 不压暗）。主画布 0.22，视频里调高让立体图别消失 */
  dimFactor = 0.22;
  private lastFrameTime = 0;

  /**
   * 取景松紧（1 = 默认）。讲解视频的画布是 16:9，比主画布更宽，
   * 按原来的距离取景图形会缩成中间一小块，静止不动的画面上尤其显空，
   * 所以视频板块会把它调小一点（相机拉近），主画布保持 1 不变。
   */
  frameScale = 1;

  /** 场景包围球半径，缩放上下限与标签尺寸都以它为基准 */
  private radius = 1;
  /** 坐标轴伸出去的长度；取景时要把它算进去，否则箭头和字母会被裁在画面外 */
  private axisExtent = 0;

  private dirty = true;
  /** 画布被隐藏时停渲染，否则每帧白算一遍 */
  private active = true;
  private raf = 0;
  private raycaster = new THREE.Raycaster();
  private resizeObserver: ResizeObserver;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };

  /** 拖拽旋转回调：给 UI 显示当前视角用（可选） */
  onViewChange?: (azimuth: number, elevation: number) => void;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xf7f6f3, 1);
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    // 和 2D 画布区分：main.ts 切换场景时靠这个标记互相隐藏
    canvas.setAttribute('data-space', '3d');
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);

    // 光照：环境光兜底 + 一盏方向固定的平行光。
    //
    // 平行光不跟着相机走是有意的：跟着相机的话，转到哪一面都同样亮，
    // 三个面的明暗差消失，立体感就没了。固定在场景里（每帧平移到物体中心），
    // 转动时才会出现"迎光面亮、背光面暗"的自然过渡。
    // 环境光留 0.75 是给背光面兜底——不能黑成一片，课本的立体图背面也是看得见的。
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambient);
    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.scene.add(this.contentGroup);
    this.scene.add(this.labelGroup);
    this.scene.add(this.axisGroup);
    // 标注独立成层：不进 contentGroup（setScene 的 clearContent 会整组清掉），
    // 由 setAnnotations3D 自己管理生命周期
    this.scene.add(this.annGroup);

    this.bindPointer();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (!this.active) {
        // 挂起时清掉时间戳：再唤醒时不会因为"停了很久"而一次转过一大截
        this.lastFrameTime = 0;
        return;
      }
      this.tickAutoRotate(performance.now());
      this.tickCameraTween();
      if (this.dirty) {
        this.dirty = false;
        this.updateCamera();
        this.updateLight();
        this.updateVisibility();
        this.updateLabels();
      }
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  // -------------------------------------------------------------
  // 对外接口
  // -------------------------------------------------------------

  /**
   * 应用一份 3D 场景。
   * resetView=false 用于"拖滑杆改参数"的场景——此时几何变了但视角该保持，
   * 否则用户刚转到想看的角度就被打回默认视角。
   */
  setScene(data: Scene3D, params: Record<string, number>, resetView = true) {
    this.data = data;
    this.params = params;
    this.clearContent();

    for (const obj of data.objects) {
      if (obj.type === 'point3') this.buildPoint(obj as Point3Object);
    }
    // 翻折：顶点求值完就能核计划了。截面的、旋转体的题一律不演——
    // 它们的几何每帧都要按顶点重算，点一动就画歪（体检器也会提示这一点）
    const blocked = data.objects.some((o) => o.type === 'section3' || isCurved3(o));
    this.fold = blocked ? null : planFold(data.fold, this.points).plan;
    this.foldOffset = 0;
    // 换场景时把上一题的运镜掐掉：不然新题一打开就被旧补间拽着转
    this.camTween = null;
    // 旋转体的圆心可以是顶点 id，所以必须等点都求值完再解析
    this.resolveSolids();
    // 截面要切谁（旋转体 id 或多面体顶点集合）也要在这里定下来
    this.resolveSectionTargets();
    // 截面要在量尺寸之前建：半透明平面四边形常伸出图形之外，
    // 不算进取景的话平面会被画面裁掉一截
    this.buildSections();
    // 先量尺寸再建对象：标签大小、点半径、虚线间距全以 radius 为基准，
    // 漏了这一步会用上一帧（甚至初始值 1）的 radius，标签会小一半、糊在点上
    this.measure();
    // 坐标轴要在量完尺寸之后画：轴长以 radius 为基准
    this.buildAxes();
    for (const obj of data.objects) {
      if (obj.type === 'face3') this.buildFace(obj as Face3Object);
    }
    for (const obj of data.objects) {
      if (obj.type === 'edge3') this.buildEdge(obj as Edge3Object);
    }
    this.buildSolids();
    this.buildLabels();
    // 步骤显隐/高亮要在对象都建好之后才能算（否则 idObjects 还是空的）
    this.applyStep();

    this.fitCamera(resetView);
    this.dirty = true;
  }

  /** 切到 2D 场景时把 3D 画布挂起，省掉每帧的无效渲染 */
  setActive(active: boolean) {
    this.active = active;
    if (active) this.dirty = true;
  }

  /**
   * 分步讲解：切到第 index 步（-1 = 不播放，全部显示）。
   * 语义与 2D 渲染器完全一致：
   *   reveal   —— 被任何一步 reveal 过的对象，只在"到达该步之后"才出现；
   *   highlight—— 本步高亮的对象正常显示，其余压暗（变淡），突出"这一步在讲什么"。
   */
  /** 步骤切换是否自动运镜（飞到高亮对象跟前）。
   *  主画布默认关闭——保持视野固定不动，避免坐标轴晃动；
   *  讲解视频板块的渲染器可以打开。 */
  stepFlyEnabled = true;

  /**
   * 视频分镜模式：显隐/高亮由播放器逐句给，不再从 steps 推。
   * 一条 step 的 highlight 是整步粒度，而讲解视频要"说到哪亮到哪"，
   * steps 里没有这个粒度，所以由播放器算好集合传进来。
   * null = 普通步骤模式（主画布走这条，互不干扰）。
   */
  private focusOverride: {
    progressive: Set<string>;
    revealed: Set<string>;
    highlight: Set<string>;
  } | null = null;

  /** 当前"在讲的重点"——运镜飞向它；分镜模式每句更新 */
  private activeHighlight: string[] = [];

  /** 本句重点的 id 集合（棱/点的染色按它判断，避免在循环里反复 new Set） */
  private hlSet = new Set<string>();

  /**
   * 高亮要不要把棱染成暖橙。默认 false = 主画布保持原样（只压淡别的），
   * 视频板块打开它，让静止的画面上有明确指向。
   */
  accentHighlight = false;

  /** 视频分镜用：按「本句高亮 / 已出现 / 会被渐进揭示的全集」渲染 */
  applyFocus(highlight: string[], revealed: string[], progressive: string[]) {
    this.focusOverride = {
      highlight: new Set(highlight),
      revealed: new Set(revealed),
      progressive: new Set(progressive),
    };
    this.applyStep();
    // 3D 是按需渲染（dirty 才画一帧）：高亮变了必须标脏，否则要等下一次转视角才刷新
    this.dirty = true;
  }

  /** 退出分镜模式，回到 steps 驱动 */
  clearFocus() {
    this.focusOverride = null;
    this.clearAnnotations();
    this.applyStep();
    this.dirty = true;
  }

  /**
   * 设置本句的空间标注（讲解视频专用）。传空数组 = 清空。
   *
   * 线一律暖橙 + depthTest:false——标注是"讲课用红笔添上去的记号"，
   * 被棱面挡住就没意义了；文字沿用标签精灵（Sprite 天然面向相机）。
   * 与 2D 的 setAnnotations 同一套语义：播放器每句算好传进来，渲染器只管画。
   */
  setAnnotations3D(marks: AnnotationMark3D[]) {
    this.clearAnnotations();
    for (const mark of marks) {
      for (const pl of mark.polylines) {
        if (pl.length < 2) continue;
        const geo = new THREE.BufferGeometry().setFromPoints(pl.map(toV3));
        const mat = new THREE.LineBasicMaterial({
          color: HL_COLOR,
          depthTest: false,
          transparent: true,
        });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 9; // 压在棱/面之上、顶点标签之下
        this.annGroup.add(line);
      }
      if (mark.text && mark.at) {
        const s = this.makeLabel(mark.text, this.theme.ann);
        s.position.copy(toV3(mark.at));
        this.annGroup.add(s);
      }
    }
    this.dirty = true;
  }

  /** 清空标注层并释放几何/材质（Group 移除后 GPU 资源不会自动回收） */
  private clearAnnotations() {
    for (const child of [...this.annGroup.children]) {
      this.annGroup.remove(child);
      const any = child as unknown as {
        geometry?: { dispose(): void };
        material?: { dispose(): void };
      };
      any.geometry?.dispose();
      any.material?.dispose();
    }
  }

  /**
   * 开启/关闭入场构建动画。关闭时立即恢复成完整图形。
   *
   * 只有视频工作台会开启；主画布保持关闭 → 打开页面就是完整立体图，
   * 不会出现"每次换题都先空一下再长出来"的干扰。
   */
  setBuildEnabled(on: boolean) {
    this.buildOn = on;
    if (!on) {
      this.buildMap.clear();
      // 透明度与几何都要归位，否则关掉动画会留下半截棱
      for (const e of this.edges) this.rewriteEdge(e, 1);
      for (const [, mesh] of this.pointMeshById) mesh.scale.setScalar(1);
      for (const l of this.labels) l.sprite.visible = true;
      for (const f of this.faces) f.buildAlpha = 1;
      for (const s of this.sections) s.buildAlpha = 1;
    }
    this.dirty = true;
  }

  /**
   * 设置各对象的构建进度。
   *
   * entries 里没有列出的对象视为"已完成"——调用方只需要关心正在长的那几个。
   * alpha：0=完全透明，1=正常；grow：棱从起点长到多长（0~1）。
   */
  setBuildProgress(entries: Array<{ id: string; alpha: number; grow: number }>) {
    this.buildMap.clear();
    for (const e of entries) this.buildMap.set(e.id, { alpha: e.alpha, grow: e.grow });

    for (const e of this.edges) this.rewriteEdge(e, this.buildOf(e.id).grow);
    // 点：小球从 0 放大（不碰透明度，避免和"压暗"逻辑打架）
    for (const [id, mesh] of this.pointMeshById) {
      const a = this.buildOf(id).alpha;
      mesh.scale.setScalar(Math.max(0.001, a));
    }
    // 标签：太小的时候先不显示，否则字母先在空处飘着
    for (const l of this.labels) l.sprite.visible = this.buildOf(l.id).alpha > 0.35;
    // 面 / 截面 / 旋转体：透明度在各自的逐帧函数里相乘
    for (const f of this.faces) f.buildAlpha = this.buildOf(f.id).alpha;
    for (const s of this.sections) s.buildAlpha = this.buildOf(s.id).alpha;
    this.dirty = true;
  }

  private buildOf(id: string): { alpha: number; grow: number } {
    return this.buildMap.get(id) ?? FULL_BUILD;
  }

  // -------------------------------------------------------------
  // 折起（翻折）
  // -------------------------------------------------------------

  /** 这一场有没有可演的翻折（没有的话播放器就不用管 fold 动作） */
  hasFold(): boolean {
    return this.fold !== null;
  }

  /**
   * 把折起演到某个角度。
   *
   * 参数是**相对声明状态的偏移**：0 = 场景原样（折好），
   * flatOffset（可能是 +deg 也可能是 −deg）= 完全展开。
   * 播放器从 flatOffset 一路推到 0，就是"把折起来的纸摊开→再折回去"那一段。
   *
   * 只改动了的顶点和依赖它们的几何，不重建整张图——见字段区的性能说明。
   */
  setFoldOffset(offset: number) {
    const plan = this.fold;
    if (!plan) return;
    const lo = Math.min(0, plan.flatOffset);
    const hi = Math.max(0, plan.flatOffset);
    const next = Math.max(lo, Math.min(hi, offset));
    // 小于千分之一度看不出区别，但每帧都会重写十条棱的顶点缓冲，划不来
    if (Math.abs(next - this.foldOffset) < 1e-3) return;
    this.foldOffset = next;
    const moved = foldPositions(plan, next);
    for (const [id, p] of moved) this.points.set(id, p);
    this.refreshAfterFold(moved);
  }

  /**
   * 完全展开对应的偏移量（±deg）。播放器要拿它当折起的起点。
   * 没有翻折时返回 0。
   */
  foldFlatOffset(): number {
    return this.fold ? this.fold.flatOffset : 0;
  }

  /** 折起后把依赖这些顶点的东西就地重写（棱 / 点 / 面 / 标签） */
  private refreshAfterFold(moved: Map<string, Vec3>) {
    for (const e of this.edges) {
      if (!moved.has(e.a) && !moved.has(e.b)) continue;
      // grow 沿用入场构建的进度：万一折起和入场撞在一起，棱不会突然变全长
      this.rewriteEdge(e, this.buildOf(e.id).grow);
    }
    for (const [id, mesh] of this.pointMeshById) {
      const p = moved.get(id);
      if (p) mesh.position.copy(toV3(p));
    }
    for (const f of this.faces) {
      if (!f.pids.some((id) => moved.has(id))) continue;
      this.writeFaceGeometry(f);
    }
    this.updateLabelAnchors(moved);
    this.dirty = true;
  }

  /** 标签锚点跟着顶点走：折起来以后字母不能留在原地等棱转走 */
  private updateLabelAnchors(moved: Map<string, Vec3>) {
    for (const l of this.labels) {
      const src = l.src;
      if (!src) continue;
      if (!src.pids.some((id) => moved.has(id))) continue;
      const ps = src.pids.map((id) => this.points.get(id)).filter(Boolean) as Vec3[];
      if (ps.length === 0) continue;
      const mean: Vec3 = [0, 0, 0];
      for (const p of ps) {
        mean[0] += p[0];
        mean[1] += p[1];
        mean[2] += p[2];
      }
      mean[0] /= ps.length;
      mean[1] /= ps.length;
      mean[2] /= ps.length;
      l.anchor.copy(toV3(mean)).add(toV3(src.off));
    }
  }

  /** 把一条棱画成"从 a 出发已走 t 比例"的样子（t=1 即整条） */
  private rewriteEdge(e: EdgeItem, t: number) {
    const pa = this.points.get(e.a);
    const pb = this.points.get(e.b);
    if (!pa || !pb) return;
    const k = Math.max(0.001, Math.min(1, t));
    const end: Vec3 = [
      pa[0] + (pb[0] - pa[0]) * k,
      pa[1] + (pb[1] - pa[1]) * k,
      pa[2] + (pb[2] - pa[2]) * k,
    ];
    (e.line.geometry as THREE.BufferGeometry).setFromPoints([toV3(pa), toV3(end)]);
    // 虚线的 dash 距离依赖顶点位置，改完必须重算
    if (e.dashedNow) e.line.computeLineDistances();
  }

  /**
   * 视频分镜：镜头飞到当前这一句的重点对象。
   * 短补间（默认 420ms）——一句话只有几秒，运镜要跟手。
   */
  flyToActive(duration = 420) {
    this.flyToHighlight(duration);
  }

  setStep(index: number) {
    this.stepIndex = index;
    this.applyStep();
    // 可选运镜：主画布关闭后，切步骤只做高亮，相机纹丝不动
    if (this.stepFlyEnabled) this.flyToHighlight();
  }

  /**
   * 步骤运镜：把本步 highlight 的对象收进一个包围盒，
   * 相机平滑飞到"正对包围盒中心、距离按包围盒大小定"的位置。
   * 没写 highlight 的步骤不动相机——没有重点时乱飞只会添乱。
   */
  private flyToHighlight(duration = 700) {
    // 飞向"当前在讲的重点"：普通步骤模式由 applyStep 从 steps 取，
    // 分镜模式由 applyFocus 逐句更新——共用同一条运镜
    const highlighted = this.activeHighlight;
    if (highlighted.length === 0) return;

    // 汇总所有高亮、且当前可见对象的包围盒
    const box = new THREE.Box3();
    let found = false;
    for (const id of highlighted) {
      for (const o of this.idObjects.get(id) ?? []) {
        if (!o.visible) continue;
        box.expandByObject(o);
        found = true;
      }
    }
    if (!found) return;

    const center = box.getCenter(new THREE.Vector3());
    const halfDiag = box.getSize(new THREE.Vector3()).length() / 2;
    // 目标距离：包围盒半径的 3.2 倍，但永远不近于整个场景半径的 2.5 倍
    // ——否则聚焦一个小点时相机会钻进图形肚子里
    const toDist = THREE.MathUtils.clamp(
      Math.max(halfDiag * 3.2, this.radius * 2.5),
      this.radius * 1.2,
      this.radius * 12,
    );

    this.camTween = {
      fromTarget: this.target.clone(),
      toTarget: center,
      fromDist: this.distance,
      toDist,
      start: performance.now(),
      duration,
    };
    this.dirty = true;
  }

  /** 每帧推进运镜补间；结束于恰好到位。缓动用 easeInOutCubic（先加速后减速） */
  private tickCameraTween() {
    const tw = this.camTween;
    if (!tw) return;
    const k = Math.min(1, (performance.now() - tw.start) / tw.duration);
    const e =
      k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    this.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
    this.distance = tw.fromDist + (tw.toDist - tw.fromDist) * e;
    if (tw.toAz !== undefined && tw.fromAz !== undefined) {
      this.azimuth = tw.fromAz + (tw.toAz - tw.fromAz) * e;
      this.onViewChange?.(this.azimuth, this.elevation);
    }
    if (tw.toEl !== undefined && tw.fromEl !== undefined) {
      this.elevation = tw.fromEl + (tw.toEl - tw.fromEl) * e;
    }
    this.dirty = true;
    if (k >= 1) {
      this.camTween = null;
      // 转完把方位角折算回 [0,360)：不然连转几圈以后数字会越来越大，
      // 自动旋转那边的取模也跟着飘
      this.azimuth = ((this.azimuth % 360) + 360) % 360;
      this.dirty = true;
    }
  }

  /** 当前视角（播放器算"只转仰角/只转方位角"时要用） */
  currentAzimuth(): number {
    return this.azimuth;
  }

  currentElevation(): number {
    return this.elevation;
  }

  /**
   * 平滑转到指定视角（方位角 / 仰角，度）。讲解视频的 view 动作用它。
   *
   * 方位角走**最短弧**：从 350° 转到 10° 应该转 +20°，而不是 −340°。
   * 不处理这件事的话，跨 0° 的一次转向会让画面原地高速转一圈。
   */
  turnTo(azimuth: number, elevation: number, duration = 1200) {
    const el = Math.max(-89, Math.min(89, elevation));
    const delta = (((azimuth - this.azimuth) % 360) + 540) % 360 - 180;
    this.camTween = {
      fromTarget: this.target.clone(),
      toTarget: this.target.clone(),
      fromDist: this.distance,
      toDist: this.distance,
      fromAz: this.azimuth,
      toAz: this.azimuth + delta,
      fromEl: this.elevation,
      toEl: el,
      start: performance.now(),
      duration: Math.max(1, duration),
    };
    this.dirty = true;
  }

  /**
   * 转到正对某个面。返回 false = 这个 id 不是面（或顶点算不出来）。
   *
   * 为什么要专门做这件事：讲"看底面 ABCD"时，默认视角往往只能看到底面的一条缝，
   * 学生根本没法把"底面是正方形"和眼前这团东西对上。转过去看是唯一解法。
   *
   * 朝哪一侧看？面有两个法向，取"背离场景中心"的那一个——
   * 那才是外表面、也是课本上画着的那一面。
   */
  turnToFace(id: string, duration = 1200): boolean {
    const f = this.faces.find((x) => x.id === id);
    if (!f || f.pids.length < 3) return false;
    const ps = f.pids.map((pid) => this.points.get(pid)).filter(Boolean) as Vec3[];
    if (ps.length < 3) return false;
    const v = ps.map(toV3);
    const n = new THREE.Vector3()
      .subVectors(v[1], v[0])
      .cross(new THREE.Vector3().subVectors(v[2], v[0]));
    if (n.lengthSq() < 1e-12) return false;
    n.normalize();
    // 朝外：面心相对场景中心的方向
    if (n.dot(f.center.clone().sub(this.sceneCenter)) < 0) n.negate();

    const el = (Math.asin(Math.max(-1, Math.min(1, n.y))) * 180) / Math.PI;
    // 正上/正下方时方位角无从判断（sin/cos 都退化），保持当前方位角
    const flat = Math.hypot(n.x, n.z);
    const az = flat < 1e-6 ? this.azimuth : (Math.atan2(n.x, n.z) * 180) / Math.PI;

    const delta = (((az - this.azimuth) % 360) + 540) % 360 - 180;
    this.camTween = {
      fromTarget: this.target.clone(),
      toTarget: f.center.clone(),
      fromDist: this.distance,
      toDist: this.distance,
      fromAz: this.azimuth,
      toAz: this.azimuth + delta,
      fromEl: this.elevation,
      toEl: Math.max(-89, Math.min(89, el)),
      start: performance.now(),
      duration: Math.max(1, duration),
    };
    this.dirty = true;
    return true;
  }

  /**
   * 每帧推进自转。
   * 用"实际经过的时间"换算角度（而不是每帧加固定角度），
   * 这样 120Hz 屏和 60Hz 屏转得一样快；单帧超过 100ms 的卡顿会被截断，
   * 免得一次跳过大半圈看起来像瞬移。
   */
  private tickAutoRotate(now: number) {
    if (this.autoRotateSeconds <= 0 || this.dragging) {
      this.lastFrameTime = now;
      return;
    }
    if (this.lastFrameTime === 0) {
      this.lastFrameTime = now;
      return;
    }
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;
    this.azimuth = (this.azimuth + (360 / this.autoRotateSeconds) * dt) % 360;
    this.dirty = true;
    this.onViewChange?.(this.azimuth, this.elevation);
  }

  /** 把对象挂到 id 名下：一个 id 可能对应多个 three 对象，所以存数组 */
  private register(id: string, obj: THREE.Object3D) {
    const list = this.idObjects.get(id);
    if (list) list.push(obj);
    else this.idObjects.set(id, [obj]);
  }

  private applyStep() {
    this.dirty = true;

    // 分镜模式优先：显隐与高亮全部由播放器逐句给（讲解视频走这条）
    if (this.focusOverride) {
      this.applyFocusSets(
        this.focusOverride.progressive,
        this.focusOverride.revealed,
        this.focusOverride.highlight,
      );
      return;
    }

    const steps = this.data?.steps;

    // 无步骤模式：全部显示、全部正常
    if (!steps || steps.length === 0 || this.stepIndex < 0) {
      this.activeHighlight = [];
      this.hlSet.clear();
      this.stepHidden.clear();
      for (const objs of this.idObjects.values()) for (const o of objs) o.visible = true;
      for (const e of this.edges) e.dim = false;
      for (const f of this.faces) f.dim = false;
      for (const g of this.solidGeoms) g.dim = false;
      for (const s of this.sections) s.dim = false;
      for (const m of this.pointMeshById.values()) this.setMatDim(m, false);
      this.applyEdgeDimAll();
      this.applyLabelDim(false, new Set());
      return;
    }

    const idx = Math.min(this.stepIndex, steps.length - 1);

    // 「渐进出现」= 被任何一步 reveal 提到过的 id。没被提到过的对象始终可见，
    // 否则一用 reveal，所有背景（面、底面）都会消失。
    const progressive = new Set<string>();
    for (const s of steps) for (const id of s.reveal ?? []) progressive.add(id);
    const revealed = new Set<string>();
    for (let i = 0; i <= idx; i++) {
      for (const id of steps[i].reveal ?? []) revealed.add(id);
    }
    this.applyFocusSets(progressive, revealed, new Set(steps[idx].highlight ?? []));
  }

  /**
   * 按三个集合落显隐与压暗——3D 侧唯一的"重点"入口。
   * 空 highlight 时不压暗任何对象：否则"这一步没写 highlight"会让整张图变灰，
   * 等于没有重点（分镜模式下每句都可能在讲背景，这个保护更要紧）。
   */
  private applyFocusSets(
    progressive: Set<string>,
    revealed: Set<string>,
    highlighted: Set<string>,
  ) {
    const dimOthers = highlighted.size > 0;
    this.activeHighlight = [...highlighted];
    // 只有视频板块才染色；主画布的 hlSet 恒为空，等于"只压淡、不改色"
    this.hlSet = this.accentHighlight ? new Set(highlighted) : new Set();

    for (const [id, objs] of this.idObjects) {
      const visible = progressive.has(id) ? revealed.has(id) : true;
      if (visible) this.stepHidden.delete(id);
      else this.stepHidden.add(id);
      for (const o of objs) o.visible = visible;
    }
    // 曲面体（圆柱/圆锥/球）不在 idObjects 里——它们的填充和轮廓是自己管的，
    // 所以必须在这里单独算一遍显隐。漏了这一步的后果是：
    // 步骤里把球放进 reveal 也藏不住它（球照样画着），而球心点却按 reveal 藏了，
    // 画面上就出现"一个球悬在空中、球心不见了"的怪图。
    for (const g of this.solidGeoms) {
      const visible = progressive.has(g.id) ? revealed.has(g.id) : true;
      if (visible) this.stepHidden.delete(g.id);
      else this.stepHidden.add(g.id);
    }
    for (const e of this.edges) e.dim = dimOthers && !highlighted.has(e.id);
    for (const f of this.faces) f.dim = dimOthers && !highlighted.has(f.id);
    for (const g of this.solidGeoms) g.dim = dimOthers && !highlighted.has(g.id);
    for (const s of this.sections) s.dim = dimOthers && !highlighted.has(s.id);
    for (const [id, mesh] of this.pointMeshById) {
      const hl = highlighted.has(id);
      this.setMatDim(mesh, dimOthers && !hl, hl);
    }
    this.applyEdgeDimAll();
    this.applyLabelDim(dimOthers, highlighted);
  }

  /**
   * 顶点小球的三态：正常 / 压暗 / 高亮（换暖橙）。
   * 与 2D 的 setBucketState 同一套语义，只是一次只处理一个网格。
   */
  private setMatDim(mesh: THREE.Mesh, dim: boolean, hl = false) {
    const m = mesh.material as THREE.MeshBasicMaterial;
    if (!m) return;
    if (m.userData.__baseColor === undefined) {
      m.userData.__baseColor = m.color.getHex();
    }
    m.color.setHex(hl ? HL_COLOR : (m.userData.__baseColor as number));
    m.transparent = dim;
    m.opacity = dim ? this.dimFactor : 1;
    m.needsUpdate = true;
  }

  /** 棱的颜色：本步重点是暖橙，其余按原色。
   * 3D 这边只换色不加粗——用 TubeGeometry 给每条棱做粗管成本太高，
   * 而且棱的虚实每帧都在重算，粗细一改就要重建几何，得不偿失。
   */
  private applyEdgeDimAll() {
    for (const e of this.edges) {
      const hl = this.hlSet.has(e.id);
      const pairs: Array<[THREE.LineBasicMaterial, number]> = [
        [e.solidMat, e.baseColor],
        [e.dashedMat, e.baseHiddenColor],
      ];
      for (const [m, base] of pairs) {
        m.transparent = e.dim;
        m.opacity = e.dim ? this.dimFactor : 1;
        m.color.setHex(hl ? HL_COLOR : base);
        m.needsUpdate = true;
      }
    }
  }

  /** 标签的压暗：字母不跟着变淡的话，被压暗的顶点旁边会挂着一个醒目的黑字 */
  private applyLabelDim(dimOthers: boolean, highlighted: Set<string>) {
    for (const l of this.labels) {
      const m = l.sprite.material as THREE.SpriteMaterial | undefined;
      if (!m) continue;
      m.transparent = true;
      m.opacity = dimOthers && !highlighted.has(l.id) ? 0.28 : 1;
      m.needsUpdate = true;
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.clearContent();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.container.removeEventListener('wheel', this.onWheel);
  }

  // -------------------------------------------------------------
  // 构建对象
  // -------------------------------------------------------------

  private scope(): Record<string, number> {
    return { ...this.params };
  }

  private buildPoint(obj: Point3Object) {
    // 派生点在 resolve3d 阶段已经算成 at 了；走到这里还没有 at 说明是坏数据
    if (obj.at === undefined) return;
    const p = evalVec3(obj.at, this.scope());
    if (!p) return; // 算不出来的点直接跳过，体检器会单独报
    this.points.set(obj.id, p);
  }

  private pointRadius(): number {
    return this.radius * 0.013;
  }

  /** 第二遍：点必须先全部求值完，面和棱才有坐标可用 */
  private buildPointMeshes() {
    const r = this.pointRadius();
    const geo = new THREE.SphereGeometry(r, 14, 10);
    for (const obj of this.data?.objects ?? []) {
      if (obj.type !== 'point3') continue;
      // hidden 的点只提供坐标（折前的位置、折叠计算的输入），画面上不该有球
      if ((obj as Point3Object).hidden) continue;
      const p = this.points.get(obj.id);
      if (!p) continue;
      const mat = new THREE.MeshBasicMaterial({ color: obj.color ?? COLORS.point });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(toV3(p));
      this.contentGroup.add(mesh);
      this.pointMeshes.push(mesh);
      this.pointMeshById.set(obj.id, mesh);
      this.register(obj.id, mesh);
    }
  }

  private buildFace(obj: Face3Object) {
    const ids = obj.points.filter((id) => this.points.has(id));
    if (ids.length < 3) return;

    const opacity = obj.opacity ?? 0.16;
    const mat = new THREE.MeshLambertMaterial({
      color: obj.color ? new THREE.Color(obj.color) : COLORS.face,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      // 关掉深度写入：半透明的面不该挡住后面的棱，
      // 棱的虚实是几何算出来的（见文件头），不靠渲染遮挡
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.contentGroup.add(mesh);
    this.register(obj.id, mesh);

    const edges = new Set<string>();
    for (let i = 0; i < obj.points.length; i++) {
      edges.add(edgeKey(obj.points[i], obj.points[(i + 1) % obj.points.length]));
    }
    const item: FaceItem = {
      mesh,
      mat,
      id: obj.id,
      pids: ids,
      center: new THREE.Vector3(),
      edges,
      opacity,
      dim: false,
      buildAlpha: 1,
    };
    this.faces.push(item);
    this.writeFaceGeometry(item);
  }

  /**
   * 按当前顶点位置重写一个面的几何（三角扇 + 朝外的法线）。
   *
   * 抽出来是因为它有两个调用方：初次建面、折起时逐帧重写。
   * 折起那条路只在顶点真的动了的时候才走，一秒几十次，
   * 所以每帧换一块新的 BufferGeometry 并把旧的 dispose 掉——
   * 在旧几何上 setAttribute 会把顶点缓冲换掉却留下旧的 GPU 缓冲，转两秒就积一堆。
   */
  private writeFaceGeometry(f: FaceItem) {
    const ps = f.pids.map((id) => this.points.get(id)).filter(Boolean) as Vec3[];
    if (ps.length < 3) return;
    const verts = ps.map(toV3);

    const center = new THREE.Vector3();
    for (const v of verts) center.add(v);
    center.multiplyScalar(1 / verts.length);

    // 三角扇拆分：面可以是四边形、五边形，three 只吃三角形
    const positions: number[] = [];
    for (let i = 1; i < verts.length - 1; i++) {
      positions.push(...verts[0].toArray(), ...verts[i].toArray(), ...verts[i + 1].toArray());
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    // 法线显式给，不用 computeVertexNormals：
    // 后者按顶点绕序算，绕序一反法线就朝里，整个面的光照全塌成环境光
    // （实测表现就是三个面一样亮、看不出立体）。多面体的面都是平面，
    // 法线方向只有"从形心朝外"这一个正确答案，绕序不该参与决定。
    const outward = center.clone().sub(this.sceneCenter).normalize();
    const normals: number[] = [];
    for (let i = 0; i < positions.length / 3; i++) {
      normals.push(outward.x, outward.y, outward.z);
    }
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));

    const old = f.mesh.geometry;
    f.mesh.geometry = geo;
    old?.dispose();
    f.center.copy(center);
  }

  private buildEdge(obj: Edge3Object) {
    const pa = this.points.get(obj.a);
    const pb = this.points.get(obj.b);
    if (!pa || !pb) return; // 引用了不存在的顶点：跳过，体检器会报

    const geo = new THREE.BufferGeometry().setFromPoints([toV3(pa), toV3(pb)]);
    const solidMat = new THREE.LineBasicMaterial({ color: obj.color ? new THREE.Color(obj.color)  : this.theme.edge });
    const dashedMat = new THREE.LineDashedMaterial({
      color: obj.color ? new THREE.Color(obj.color)  : this.theme.edgeHidden,
      dashSize: this.radius * 0.06,
      gapSize: this.radius * 0.045,
    });
    const line = new THREE.Line(geo, solidMat);
    line.computeLineDistances();
    this.contentGroup.add(line);

    const item: EdgeItem = {
      line,
      solidMat,
      dashedMat,
      id: obj.id,
      a: obj.a,
      b: obj.b,
      forced: obj.dashed,
      dashedNow: false,
      dim: false,
      baseColor: solidMat.color.getHex(),
      baseHiddenColor: dashedMat.color.getHex(),
    };
    this.edges.push(item);
    this.register(obj.id, line);

    if (obj.label) {
      const mid = toV3([
        (pa[0] + pb[0]) / 2,
        (pa[1] + pb[1]) / 2,
        (pa[2] + pb[2]) / 2,
      ]);
      const off = obj.labelOffset ?? [0, 0, 0];
      const s = this.makeLabel(obj.label, obj.color);
      const anchor = mid.clone().add(toV3(off as Vec3));
      this.labelGroup.add(s);
      this.labels.push({
        sprite: s,
        anchor,
        id: obj.id,
        src: { pids: [obj.a, obj.b], off: off as Vec3 },
      });
      this.register(obj.id, s);
    }
  }

  // -------------------------------------------------------------
  // 旋转体（圆柱 / 圆锥 / 球）
  //
  // 分工：curved3d.ts 算"该画哪些段、哪段虚线"，这里只负责把段画出来。
  // 曲面的虚实不像多面体的棱那样一次算完就定——
  // 椭圆上的虚实分界点跟着视角走，所以 updateCurved() 每帧重算。
  // -------------------------------------------------------------

  /** 把协议里的旋转体对象解析成数字（半径、两个轴端点） */
  private resolveSolids() {
    this.solidGeoms = [];
    const scope = this.scope();
    const lookup = (id: string) => this.points.get(id);

    for (const obj of this.data?.objects ?? []) {
      if (!isCurved3(obj)) continue;

      // 半径：可以是数字，也可以是引用 params 的表达式（"r"、"a/2"）
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
      // 半径不合法就跳过：体检器已经点名报错了，
      // 这里再画一个半径为负/NaN 的体只会把画面搞成空白
      if (!Number.isFinite(r) || r <= 0) continue;

      let a: Vec3 | null = null;
      let b: Vec3 | null = null;
      if (obj.type === 'cylinder3') {
        a = evalPointRef(obj.a, lookup, scope).value;
        b = evalPointRef(obj.b, lookup, scope).value;
      } else if (obj.type === 'cone3') {
        a = evalPointRef(obj.base, lookup, scope).value;
        b = evalPointRef(obj.apex, lookup, scope).value;
      } else {
        a = evalPointRef(obj.center, lookup, scope).value;
        b = a;
      }
      if (!a || !b) continue;

      this.sectionSolids.set(obj.id, {
        kind:
          obj.type === 'cylinder3' ? 'cylinder' : obj.type === 'cone3' ? 'cone' : 'sphere',
        a,
        b,
        r,
      });

      this.solidGeoms.push({
        id: obj.id,
        kind:
          obj.type === 'cylinder3' ? 'cylinder' : obj.type === 'cone3' ? 'cone' : 'sphere',
        a: toV3(a),
        b: toV3(b),
        r,
        opacity: obj.opacity ?? 0.2,
        color: obj.color,
        label: obj.label,
        labelOffset: obj.labelOffset,
        dim: false,
      });
    }
  }

  /**
   * 把每个 section3 的「切谁」解析成可计算的目标。
   *
   * 与体检器里的同名逻辑一致（那边在 protocol 里，这边在渲染器里）：
   *   - cut 是字符串 → 查已解析的旋转体；
   *   - cut 是 { vertices } → 用场景里的 face3 组装出多面体的面。
   * 两边都调用 sectionMath 的 buildPolySpec，所以"哪些面属于这个多面体"
   * 的判定不会出现两套。
   */
  private resolveSectionTargets() {
    this.sectionTargets.clear();
    const faceObjs = (this.data?.objects ?? []).filter(
      (o): o is Face3Object => o.type === 'face3',
    );
    const lookup = (id: string) => this.points.get(id);

    for (const obj of this.data?.objects ?? []) {
      if (obj.type !== 'section3') continue;
      if (typeof obj.cut === 'string') {
        const spec = this.sectionSolids.get(obj.cut);
        if (spec) this.sectionTargets.set(obj.id, { kind: 'solid', spec });
        continue;
      }
      const built = buildPolySpec(
        obj.cut.vertices,
        obj.cut.faces,
        lookup,
        faceObjs.map((f) => ({ points: f.points })),
      );
      if ('spec' in built) this.sectionTargets.set(obj.id, { kind: 'poly', spec: built.spec });
    }
  }

  /**
   * 建截面：调 solveSection 求交线，画半透明平面四边形；
   * 交线的线段留给每帧的 updateSections 按视角分虚实。
   *
   * 求不出交线（切空了/切穿了）这里直接跳过——体检器已经把原因
   * 原话报给模型了，渲染器再画一个错误示意反而添乱。
   */
  private buildSections() {
    const scope = this.scope();
    const lookup = (id: string) => this.points.get(id);

    for (const obj of this.data?.objects ?? []) {
      if (obj.type !== 'section3') continue;
      const target = this.sectionTargets.get(obj.id);
      if (!target) continue; // cut 写错：体检器报

      let plane: PlaneSpec | null = null;
      if (Array.isArray(obj.plane)) {
        const vals = obj.plane.map((ref) => evalPointRef(ref, lookup, scope).value);
        if (vals.some((v) => !v)) continue;
        const [P1, P2, P3] = vals as Vec3[];
        const n = crossM(subM(P2, P1), subM(P3, P1));
        if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue; // 三点共线：体检器报
        plane = { p: P1, n };
      } else if (obj.p !== undefined && obj.normal !== undefined) {
        const pv = evalPointRef(obj.p, lookup, scope).value;
        const nv = evalVec3(obj.normal as Vec3Like, scope);
        if (!pv || !nv) continue;
        plane = { p: pv, n: nv };
      }
      if (!plane) continue;

      const sol = solveSectionOn(target, plane);
      if (!sol.ok) continue;

      // 数学坐标 → three 坐标（线性映射，方向向量直接换）
      const loop = sol.loop.map(toV3);
      const normals = sol.normals.map(toV3);
      const center = toV3(sol.center);

      const color = new THREE.Color(obj.color ?? SECTION_COLOR);
      // 填充**交线围成的多边形**，而不是一个更大的四边形：
      // 四边形投影出来是个悬空的平行四边形，和"截面"对不上；
      // 填椭圆正好是课本的阴影画法。用 MeshBasicMaterial 是因为
      // 截平面是平的，不需要光照——平面的两面同色才对。
      const positions: number[] = [];
      for (let i = 1; i < loop.length - 1; i++) {
        positions.push(...loop[0].toArray(), ...loop[i].toArray(), ...loop[i + 1].toArray());
      }
      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: obj.opacity ?? 0.14,
        side: THREE.DoubleSide,
        // 和面一致：不写深度，免得把背面的虚线挡掉
        depthWrite: false,
      });
      const fill = new THREE.Mesh(fillGeo, mat);
      fill.frustumCulled = false;
      this.contentGroup.add(fill);
      this.register(obj.id, fill);

      if (obj.label) {
        const s = this.makeLabel(obj.label, obj.color);
        s.position.copy(center);
        this.labelGroup.add(s);
        this.labels.push({ sprite: s, anchor: center.clone(), id: obj.id });
        this.register(obj.id, s);
      }

      this.sections.push({
        id: obj.id,
        loop,
        normals,
        fill,
        mat,
        center,
        opacity: obj.opacity ?? 0.14,
        color,
        dim: false,
        buildAlpha: 1,
      });
    }
  }

  /**
   * 建曲面填充。
   *
   * 两个关键设置：
   *   side: FrontSide —— 只画朝向相机的半面。用 DoubleSide 的话背面也会染一遍色，
   *                      圆柱中间会出现一道明显的"叠色带"，看着像两个半圆柱。
   *   depthWrite: false —— 和 face3 一致：不写深度，免得把虚线挡掉。
   */
  private buildSolids() {
    const Y = new THREE.Vector3(0, 1, 0);
    const Z = new THREE.Vector3(0, 0, 1);

    for (const g of this.solidGeoms) {
      const color = new THREE.Color(g.color ?? COLORS.face);
      const mkMat = () =>
        new THREE.MeshLambertMaterial({
          color,
          transparent: true,
          opacity: g.opacity,
          side: THREE.FrontSide,
          depthWrite: false,
        });
      const meshes: THREE.Mesh[] = [];
      const mats: THREE.MeshLambertMaterial[] = [];
      const add = (
        geo: THREE.BufferGeometry,
        mat: THREE.MeshLambertMaterial,
        /** 是否参与"自由棱是否被挡"的射线求交 */
        occlude = true,
      ) => {
        const mesh = new THREE.Mesh(geo, mat);
        this.contentGroup.add(mesh);
        meshes.push(mesh);
        mats.push(mat);
        if (occlude) this.solidOccluders.push(mesh);
        return mesh;
      };

      if (g.kind === 'sphere') {
        // 球**不参与**遮挡射线：外接球把整个几何体包在里面，
        // 从相机射向棱中点的射线会先打穿球面，于是每条棱都被判成"被挡住"，
        // 整张图变成一团虚线。球是参照物（相当于"内切/外接"的示意），
        // 不该决定棱的虚实。
        add(new THREE.SphereGeometry(g.r, 48, 32), mkMat(), false).position.copy(g.a);
      } else {
        const f = axisFrame(g.a, g.b);
        if (!f) continue;
        // three 的圆柱/圆锥默认沿 y 轴、以原点为中心，所以要转 + 平移
        const side =
          g.kind === 'cylinder'
            ? new THREE.CylinderGeometry(g.r, g.r, f.h, 72, 1, true)
            : new THREE.ConeGeometry(g.r, f.h, 72, 1, true);
        const body = add(side, mkMat());
        body.quaternion.setFromUnitVectors(Y, f.u);
        body.position.copy(g.a).addScaledVector(f.u, f.h / 2);

        // 底盖：法线朝下
        const bottom = add(new THREE.CircleGeometry(g.r, 72), mkMat());
        bottom.quaternion.setFromUnitVectors(Z, f.u.clone().negate());
        bottom.position.copy(g.a);

        // 顶盖（只有圆柱有；圆锥的"顶"是锥尖）
        if (g.kind === 'cylinder') {
          const top = add(new THREE.CircleGeometry(g.r, 72), mkMat());
          top.quaternion.setFromUnitVectors(Z, f.u);
          top.position.copy(g.b);
        }
      }

      this.curvedFills.set(g.id, { meshes, mats });

      if (g.label) {
        const s = this.makeLabel(g.label);
        const off = g.labelOffset ?? [0, 0, 0];
        s.position.copy(solidCenter(g)).add(toV3(off as Vec3));
        this.labelGroup.add(s);
      }
    }
  }

  /** 取（或新建）第 i 段线的对象 */
  private pieceFor(list: CurvePiece[], i: number, color: THREE.Color): CurvePiece {
    const hit = list[i];
    if (hit) return hit;
    const solidMat = new THREE.LineBasicMaterial({ color });
    const dashedMat = new THREE.LineDashedMaterial({
      color,
      dashSize: this.radius * 0.06,
      gapSize: this.radius * 0.045,
    });
    const line = new THREE.Line(new THREE.BufferGeometry(), solidMat);
    // 几何每帧换，包围球会过期，交给 three 剔除会被误剔掉
    line.frustumCulled = false;
    this.contentGroup.add(line);
    const piece: CurvePiece = {
      line,
      solidMat,
      dashedMat,
      baseColor: color.getHex(),
    };
    list.push(piece);
    return piece;
  }

  /** 每帧（相机或步骤变化时）按当前视角重算旋转体的虚实轮廓 */
  private updateCurved() {
    const camPos = this.camera.position;

    for (const g of this.solidGeoms) {
      const hidden = this.stepHidden.has(g.id);
      const runs: CurveRun[] = hidden ? [] : solidRuns(g, camPos);

      let list = this.curvedPieces.get(g.id);
      if (!list) {
        list = [];
        this.curvedPieces.set(g.id, list);
      }
      const color = new THREE.Color(g.color ?? this.theme.edge);

      // 段数每帧会变（视角一转，虚实分界点就移动），所以按 runs 的长度
      // 现取现建；多出来的旧段藏起来，不删——下一帧可能又用得上
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (run.pts.length < 2) continue;
        const p = this.pieceFor(list, i, color);
        p.line.visible = true;
        const pos = new Float32Array(run.pts.length * 3);
        run.pts.forEach((v, k) => {
          pos[k * 3] = v.x;
          pos[k * 3 + 1] = v.y;
          pos[k * 3 + 2] = v.z;
        });
        const geo = p.line.geometry as THREE.BufferGeometry;
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        p.line.computeLineDistances();
        p.line.material = run.dashed ? p.dashedMat : p.solidMat;
      }
      for (let i = runs.length; i < list.length; i++) list[i].line.visible = false;

      // 压暗：和棱的处理一致（这一步没讲到它就变淡）；讲到它就把轮廓染成重点色
      const hl = this.hlSet.has(g.id);
      // 入场构建：曲面体（圆柱/圆锥/球）整体淡入，避免"球先在那儿、截面后画"的错位
      const buildA = this.buildOf(g.id).alpha;
      for (const p of list) {
        for (const m of [p.solidMat, p.dashedMat]) {
          m.transparent = g.dim === true || buildA < 1;
          m.opacity = (g.dim ? this.dimFactor : 1) * buildA;
          m.color.setHex(hl ? HL_COLOR : p.baseColor);
          m.needsUpdate = true;
        }
      }

      const fill = this.curvedFills.get(g.id);
      if (fill) {
        for (const [i, m] of fill.mats.entries()) {
          m.transparent = true;
          m.opacity = g.opacity * (g.dim ? 0.3 : 1) * buildA;
          fill.meshes[i].visible = !hidden;
        }
      }
    }
  }

  /**
   * 每帧按视角重算截面的虚实。
   *
   * 交线贴在旋转体表面上：采样点的外法线朝向相机 → 这段在眼前，实线；
   * 背对相机 → 被实体挡住，虚线。和旋转体轮廓是同一个判据，
   * 所以直接复用 splitRuns（含"首尾接缝合并"，避免环上多出断口）。
   */
  private updateSections() {
    for (const s of this.sections) {
      const hidden = this.stepHidden.has(s.id);
      const runs: CurveRun[] = hidden ? [] : this.sectionRuns(s);

      let list = this.sectionPieces.get(s.id);
      if (!list) {
        list = [];
        this.sectionPieces.set(s.id, list);
      }
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (run.pts.length < 2) continue;
        const p = this.pieceFor(list, i, s.color);
        p.line.visible = true;
        const pos = new Float32Array(run.pts.length * 3);
        run.pts.forEach((v, k) => {
          pos[k * 3] = v.x;
          pos[k * 3 + 1] = v.y;
          pos[k * 3 + 2] = v.z;
        });
        const geo = p.line.geometry as THREE.BufferGeometry;
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        p.line.computeLineDistances();
        p.line.material = run.dashed ? p.dashedMat : p.solidMat;
      }
      for (let i = runs.length; i < list.length; i++) list[i].line.visible = false;

      // 压暗：交线和平面一起淡；讲到截面时交线染成重点色
      const hl = this.hlSet.has(s.id);
      for (const p of list) {
        for (const m of [p.solidMat, p.dashedMat]) {
          m.transparent = s.dim || s.buildAlpha < 1;
          m.opacity = (s.dim ? this.dimFactor : 1) * s.buildAlpha;
          m.color.setHex(hl ? HL_COLOR : p.baseColor);
          m.needsUpdate = true;
        }
      }
      s.mat.opacity = s.opacity * (s.dim ? 0.3 : 1) * s.buildAlpha;
    }
  }

  /**
   * 截面交线的虚实分段。
   *
   * 判据是「每一条**边**正对相机还是背对」，不是每个点：
   *   - 旋转体的截面有 96 个采样点，逐点算和逐边算看不出差别；
   *   - 多面体的截面只有 5～6 个点，逐点算会把"一整段实线"切成一个孤点，
   *     再被 splitRuns 的 length>=2 过滤掉 —— 结果整圈全变虚线（真实事故）。
   * 所以统一按边算：用边的中点做朝向判断，再把连续的同类边合并成一段。
   */
  private sectionRuns(s: SectionItem): CurveRun[] {
    const n = s.loop.length;
    if (n < 2) return [];
    const camPos = this.camera.position;
    const flags = Array.from({ length: n }, (_, i) => {
      const a = s.loop[i];
      const b = s.loop[(i + 1) % n];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const nrm = s.normals[i % s.normals.length];
      return nrm.dot(camPos.clone().sub(mid)) > 0;
    });

    // 全在眼前（截平面正对自己）/ 全在背后：整圈一段，省得切碎
    if (flags.every(Boolean) || !flags.some(Boolean)) {
      return [{ pts: [...s.loop, s.loop[0]], dashed: !flags[0] }];
    }

    // 从一个"状态翻转处"起步，避免同一个 run 被首尾切成两段
    let start = 0;
    for (let i = 0; i < n; i++) {
      if (flags[i] !== flags[(i - 1 + n) % n]) {
        start = i;
        break;
      }
    }
    const runs: CurveRun[] = [];
    let cur: CurveRun | null = null;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const dashed = !flags[i];
      if (!cur || cur.dashed !== dashed) {
        cur = { pts: [s.loop[i]], dashed };
        runs.push(cur);
      }
      cur.pts.push(s.loop[(i + 1) % n]);
    }
    return runs.filter((r) => r.pts.length >= 2);
  }

  private labelHeight(): number {
    return this.radius * 0.11;
  }

  /**
   * 造一个标签精灵。
   *
   * depthTest 必须关掉、renderOrder 必须抬高：立体图里被挡住的那个顶点
   * （正方体的 A）离相机最远，按深度排序它会被前方的面和棱压掉，
   * 但课本的规矩是"顶点标号永远看得见"。
   */
  private makeLabel(text: string, color?: string): THREE.Sprite {
    const s = makeTextSprite(text, {
      worldHeight: this.labelHeight(),
      color: color ?? this.theme.label,
    });
    s.material.depthTest = false;
    s.renderOrder = 10;
    return s;
  }

  /**
   * 顶点标签。位置不在这里定死——交给 updateLabels 按**屏幕方向**每帧重算。
   * 为什么不直接用 3D 方向往外推？因为正方体离相机最近的那个顶点（C₁），
   * "往外"恰好等于"朝相机"，投影上几乎不动，标签就压在点和棱上了。
   * 屏幕空间推才解决得了这件事。
   */
  private buildLabels() {
    this.buildPointMeshes();
    if (!this.data) return;
    for (const obj of this.data.objects) {
      if (obj.type !== 'point3' || !obj.label) continue;
      if ((obj as Point3Object).hidden) continue;
      const p = this.points.get(obj.id);
      if (!p) continue;
      const off = obj.labelOffset ?? [0, 0, 0];
      const anchor = toV3(p).add(toV3(off as Vec3));
      // 标签跟着点的颜色走：球心 O 标蓝、内心 I 标红，与对应的球一眼对得上。
      // 普通顶点没给 color，仍用默认深灰。
      const s = this.makeLabel(obj.label, obj.color);
      this.labelGroup.add(s);
      this.labels.push({
        sprite: s,
        anchor,
        id: obj.id,
        src: { pids: [obj.id], off: off as Vec3 },
      });
      // 标签也要挂到 id 名下：否则 reveal 把顶点藏了，字母还留在原地
      this.register(obj.id, s);
    }
  }

  /**
   * 把标签沿"屏幕上的离心方向"推开 16px。
   *
   * 特殊处理：投影几乎落在图形中心的顶点（正方体的 A 和最前面的 C₁），
   * 屏幕方向无从判断。这时按深度分家——离相机远的往左下、近的往右上，
   * 正好是课本的习惯画法，也不会两个标签叠死。
   */
  private updateLabels() {
    const cam = this.camera;
    const h = this.container.clientHeight || 1;
    const visibleH = 2 * this.distance * Math.tan((cam.fov * Math.PI) / 360);
    const worldPerPx = visibleH / h;

    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
    const cNdc = this.target.clone().project(cam);
    const camToTarget = cam.position.distanceTo(this.target);
    /** 已经放好的标签（NDC 坐标），用于"两个标签叠在一起"的避让 */
    const placed: THREE.Vector3[] = [];

    for (const { sprite, anchor } of this.labels) {
      const ndc = anchor.clone().project(cam);
      let dx = ndc.x - cNdc.x;
      let dy = ndc.y - cNdc.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.08) {
        const farther = cam.position.distanceTo(anchor) > camToTarget;
        dx = farther ? -0.7 : 0.7;
        dy = farther ? -0.7 : 0.7;
      } else {
        dx /= len;
        dy /= len;
      }
      const px = 26 * worldPerPx;
      sprite.position
        .copy(anchor)
        .addScaledVector(right, dx * px)
        .addScaledVector(up, dy * px);

      // 避让：两个点投影靠得很近时（球的内心与原点、正四面体的顶点与底面重心），
      // 上面那套"沿离心方向外推"会把两个标签推到同一处，最后只剩一个字母。
      // 这里做一遍简单的占位检查：撞上了就往下错开，宁可偏一点也不能叠死。
      let spot = sprite.position.clone().project(cam);
      for (let k = 0; k < 6 && this.labelCollides(placed, spot, cam.aspect); k++) {
        sprite.position.addScaledVector(up, -px * 0.85);
        spot = sprite.position.clone().project(cam);
      }
      placed.push(spot);
    }
  }

  /** 这个 NDC 位置是否已经压住了别的标签（x 按宽高比换算，别用裸 NDC 距离） */
  private labelCollides(placed: THREE.Vector3[], spot: THREE.Vector3, aspect: number): boolean {
    for (const p of placed) {
      if (Math.hypot((spot.x - p.x) * aspect, spot.y - p.y) < 0.055) return true;
    }
    return false;
  }

  // -------------------------------------------------------------
  // 相机与遮挡
  // -------------------------------------------------------------

  private centroid(): THREE.Vector3 {
    // 有旋转体时用 measure() 算出的场景中心（把轴中点也算进平均），
    // 否则"面朝外"的判据会被一个孤零零的点拉偏
    return this.sceneCenter.clone();
  }

  /**
   * 量出场景尺寸：中心与包围球半径。所有尺寸基准都从这里来。
   *
   * 中心用"结构中心"（顶点 + 旋转体轴中点）的平均，不用曲面上的采样点——
   * 采样点数量多，会把中心硬拽向旋转体那一侧。
   * 半径则必须用**极值点**（含圆周采样），否则圆柱会被画面裁掉。
   */
  private measure() {
    // hidden 点不算进取景：折前那块摊平的位置往往比折好的图"探出去"一截，
    // 拿它量包围盒会把整个画面压小。展开态的尺寸由下面的 foldExtent 负责。
    const hidden = new Set(
      (this.data?.objects ?? [])
        .filter((o) => o.type === 'point3' && (o as Point3Object).hidden)
        .map((o) => o.id),
    );
    const centers: THREE.Vector3[] = [...this.points.entries()]
      .filter(([id]) => !hidden.has(id))
      .map(([, p]) => toV3(p));
    const extents: THREE.Vector3[] = [...centers];
    // 折起题：取景要按"完全展开"那一片算。展开态通常比折好态横向更宽，
    // 只按折好态取景的话，视频开头（还没折）那块平面会被裁掉一角。
    if (this.fold) {
      for (const p of foldExtent(this.fold)) extents.push(toV3(p));
    }
    for (const g of this.solidGeoms) {
      centers.push(solidCenter(g));
      extents.push(...solidExtentPoints(g));
    }
    // 截面交线贴在实体表面，本来就在包围范围内；
    // 但它会自己标字母（α），所以中心要参与"结构中心"的平均
    for (const s of this.sections) centers.push(s.center.clone());

    const c = new THREE.Vector3();
    if (centers.length > 0) {
      for (const p of centers) c.add(p);
      c.multiplyScalar(1 / centers.length);
    }
    let maxR = 0.5;
    for (const p of extents) maxR = Math.max(maxR, p.distanceTo(c));

    this.sceneCenter.copy(c);
    this.radius = maxR;
    this.target.copy(c);
  }

  // -------------------------------------------------------------
  // 坐标轴
  //
  // 为什么立体图需要它？——因为"这个点在哪个高度"是立体几何最容易看错的事。
  // 有了 z 轴，"底面 z=0、顶点 z=h" 一眼就能对上；
  // 没有它，学生只能靠"看着像不像"猜，而这正是我们一直在防的事情。
  //
  // 三条轴按数学软件的习惯上色（x 红、y 绿、z 蓝），但压得比较淡：
  // 它们只是参照系，不该抢图形的戏。
  // -------------------------------------------------------------

  private axesClear() {
    for (const child of [...this.axisGroup.children]) {
      this.axisGroup.remove(child);
      const any = child as unknown as {
        geometry?: { dispose(): void };
        material?: { dispose(): void } | { dispose(): void }[];
      };
      any.geometry?.dispose();
      if (Array.isArray(any.material)) any.material.forEach((m) => m.dispose());
      else any.material?.dispose();
    }
  }

  private buildAxes() {
    this.axesClear();
    this.axisExtent = 0;
    if (this.data?.axes === false) return;

    const base = Math.max(this.radius * 1.2, 1);
    // 数学坐标 → three 坐标：x→x，y→+z，z→+y（见文件顶部的 toV3）
    const list: Array<{ dir: THREE.Vector3; name: 'x' | 'y' | 'z'; axis: 0 | 1 | 2 }> = [
      { dir: new THREE.Vector3(1, 0, 0), name: 'x', axis: 0 },
      { dir: new THREE.Vector3(0, 0, 1), name: 'y', axis: 1 },
      { dir: new THREE.Vector3(0, 1, 0), name: 'z', axis: 2 },
    ];

    for (const { dir, name, axis } of list) {
      // 轴长：至少 base；如果图形在正方向伸得更远，就跟着伸出去。
      // 关键在"伸出去"这三个字——轴若被图形完全盖住，画了也等于没画
      // （本题的 AB、AC、AV 正好压在三条轴上，就是这种情况）。
      let far = 0;
      for (const p of this.points.values()) far = Math.max(far, p[axis]);
      const len = Math.max(base, far > 0 ? far * 1.18 : 0);
      this.axisExtent = Math.max(this.axisExtent, len + this.radius * 0.14);

      const color = AXIS_COLORS[name];
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), len, color, len * 0.055, len * 0.03);
      // 只当参照物：不写深度、排在最底层，这样棱和面永远压在轴上，
      // 重合的那一段看不出"两条线打架"（AB 与 x 轴就重合）。
      arrow.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (mat) {
          mat.depthWrite = false;
          mat.transparent = true;
          mat.opacity = 0.85;
        }
        o.renderOrder = -2;
        // 几何是现算的，包围球容易过期被误剔除
        o.frustumCulled = false;
      });
      this.axisGroup.add(arrow);

      // 轴名：画在箭头外面一段距离。不能只放 1.06 倍处——
      // 顶点常常正压在轴上（墙角模型的 B 就在 x 轴上），那个位置会被顶点的字母占掉。
      const tag = makeTextSprite(name, {
        worldHeight: this.radius * 0.1,
        color: `#${color.toString(16).padStart(6, '0')}`,
      });
      tag.material.depthTest = false;
      tag.renderOrder = 11;
      tag.position.copy(dir).multiplyScalar(len + this.radius * 0.14);
      this.axisGroup.add(tag);
    }
  }

  private fitCamera(resetView: boolean) {
    // 取景半径要把坐标轴也算进去：轴常伸出图形之外（墙角模型的 AB 就压在 x 轴上），
    // 只按图形算的话，箭头和 x/y/z 字母会被裁到画面外，等于白画。
    const maxR = Math.max(this.radius, this.axisExtent);

    if (resetView) {
      const cam = this.data?.camera;
      this.azimuth = cam?.azimuth ?? 35;
      this.elevation = cam?.elevation ?? 18;
      const fov = cam?.fov ?? 45;
      this.camera.fov = fov;
      // 让半径为 r 的球刚好占满画面高度的 ~75%
      const need = (maxR / Math.sin((fov * Math.PI) / 360)) * 1.35;
      this.distance =
        cam?.distance ?? Math.max(need, maxR * 1.6) * this.frameScale;
    }
    this.camera.near = Math.max(0.01, this.distance * 0.02);
    this.camera.far = this.distance * 20;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** 播放器专用推近倍率（1 = 原样）；乘在相机距离上，不改 target/角度 */
  private zoomScale = 1;

  /**
   * 设置推近倍率。讲解视频在一步之内从 1.00 缓慢推到 1.06 制造"呼吸感"；
   * 主画布不调用，视野保持固定。
   */
  setZoomScale(scale: number) {
    const s = Math.max(0.6, Math.min(2, scale));
    if (Math.abs(s - this.zoomScale) < 0.0005) return;
    this.zoomScale = s;
    this.dirty = true;
  }

  private updateCamera() {
    const az = (this.azimuth * Math.PI) / 180;
    const el = (this.elevation * Math.PI) / 180;
    const d = this.distance / this.zoomScale;
    this.camera.position.set(
      this.target.x + d * Math.cos(el) * Math.sin(az),
      this.target.y + d * Math.sin(el),
      this.target.z + d * Math.cos(el) * Math.cos(az),
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /**
   * 主光方向固定（左上前方），但每帧把光源平移到物体中心 ——
   * 距离跟着场景尺寸走，大场景小场景的明暗关系一致。
   */
  private updateLight() {
    const dir = new THREE.Vector3(2.5, 4, 3)
      .normalize()
      .multiplyScalar(Math.max(this.radius * 6, 10));
    this.keyLight.position.copy(this.target).add(dir);
    this.keyLight.target.position.copy(this.target);
    this.keyLight.target.updateMatrixWorld();
  }

  /** 棱的虚实：先看邻接面朝向，没有邻接面就用射线求交 */
  private updateVisibility() {
    const camPos = this.camera.position;
    const centroid = this.centroid();

    // 旋转体的轮廓随视角变化，必须每帧（相机变动时）重算
    this.updateCurved();
    // 截面交线的虚实同理
    this.updateSections();

    const faceFront = this.faces.map((f) => {
      const outward = f.center.clone().sub(centroid);
      const towardCam = camPos.clone().sub(f.center);
      const front = outward.dot(towardCam) > 0;
      // 背面不画：课本立体图不画背后的面，画了反而糊。
      // 注意还要叠加步骤的 reveal：面是**每帧重算**可见性的，
      // 直接写 visible = front 会把 applyStep 设的显隐冲掉，
      // 所以两个条件在这里合并。
      const base = front ? f.opacity : f.opacity * 0.25;
      f.mat.opacity = base * (f.dim ? 0.3 : 1) * f.buildAlpha;
      f.mesh.visible = front && !this.stepHidden.has(f.id);
      return front;
    });

    for (const e of this.edges) {
      let dashed: boolean;
      if (e.forced === true) {
        dashed = true;
      } else if (e.forced === false) {
        dashed = false;
      } else {
        const key = edgeKey(e.a, e.b);
        const adj = this.faces.reduce<number[]>((acc, f, i) => {
          if (f.edges.has(key)) acc.push(i);
          return acc;
        }, []);
        if (adj.length > 0) {
          // 凸多面体解析判据：任一侧的面朝向相机即可见
          dashed = !adj.some((i) => faceFront[i]);
        } else {
          dashed = this.occludedByRay(e);
        }
      }
      if (dashed !== e.dashedNow) {
        e.dashedNow = dashed;
        e.line.material = dashed ? e.dashedMat : e.solidMat;
      }
    }
  }

  /** 自由棱（体对角线等）：从相机射向棱中点，半路撞到面就是被挡 */
  private occludedByRay(e: EdgeItem): boolean {
    const pa = this.points.get(e.a);
    const pb = this.points.get(e.b);
    if (!pa || !pb) return false;
    const mid = toV3([
      (pa[0] + pb[0]) / 2,
      (pa[1] + pb[1]) / 2,
      (pa[2] + pb[2]) / 2,
    ]);
    const camPos = this.camera.position;
    const dir = mid.clone().sub(camPos);
    const dist = dir.length();
    if (dist < 1e-6) return false;
    dir.normalize();
    this.raycaster.set(camPos, dir);
    this.raycaster.far = dist;
    const hits = this.raycaster.intersectObjects(
      [...this.faces.map((f) => f.mesh), ...this.solidOccluders],
      false,
    );
    // 交点明显在半路（不是贴着中点本身）
    return hits.length > 0 && hits[0].distance < dist * 0.98;
  }

  // -------------------------------------------------------------
  // 交互：拖动旋转 / 滚轮缩放
  // -------------------------------------------------------------

  private onPointerDown = (ev: PointerEvent) => {
    this.dragging = true;
    this.camTween = null; // 用户想自己看：立刻停掉运镜，别跟人抢相机
    this.lastPointer = { x: ev.clientX, y: ev.clientY };
    this.renderer.domElement.style.cursor = 'grabbing';
  };

  private onPointerMove = (ev: PointerEvent) => {
    if (!this.dragging) return;
    const dx = ev.clientX - this.lastPointer.x;
    const dy = ev.clientY - this.lastPointer.y;
    this.lastPointer = { x: ev.clientX, y: ev.clientY };
    this.azimuth -= dx * 0.4;
    // 仰角限制在 ±88°：越过极点相机会翻面，画面会突然上下颠倒
    this.elevation = Math.max(-88, Math.min(88, this.elevation + dy * 0.4));
    this.dirty = true;
    this.onViewChange?.(this.azimuth, this.elevation);
  };

  private onPointerUp = () => {
    this.dragging = false;
    this.renderer.domElement.style.cursor = 'grab';
  };

  private onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    this.camTween = null; // 滚轮缩放同理，运镜让位
    const factor = 1 + Math.sign(ev.deltaY) * 0.08;
    this.distance = Math.max(this.radius * 0.8, Math.min(this.radius * 12, this.distance * factor));
    this.dirty = true;
  };

  private bindPointer() {
    this.container.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.container.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // -------------------------------------------------------------
  // 清理
  // -------------------------------------------------------------

  private clearContent() {
    const disposeGroup = (g: THREE.Group) => {
      for (const child of [...g.children]) {
        g.remove(child);
        const any = child as unknown as {
          geometry?: { dispose(): void };
          material?: { dispose(): void } | { dispose(): void }[];
        };
        any.geometry?.dispose();
        if (Array.isArray(any.material)) any.material.forEach((m) => m.dispose());
        else any.material?.dispose();
      }
    };
    disposeGroup(this.contentGroup);
    disposeGroup(this.labelGroup);
    this.clearAnnotations();
    this.axesClear();
    this.points.clear();
    this.edges = [];
    this.faces = [];
    this.pointMeshes = [];
    this.labels = [];
    this.solidGeoms = [];
    this.curvedPieces.clear();
    this.curvedFills.clear();
    this.solidOccluders = [];
    this.sectionSolids.clear();
    this.sectionTargets.clear();
    this.sections = [];
    this.sectionPieces.clear();
    this.idObjects.clear();
    this.pointMeshById.clear();
    this.stepHidden.clear();
  }
}
