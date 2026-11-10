/**
 * renderer.ts —— 场景渲染器（本工程的核心）
 *
 * 职责：把一份 Scene 数据（protocol/scene.ts）画成可交互的 Three.js 画面。
 *
 * 关键设计：
 *   1. 正交相机：数学场景不需要透视，正交相机下坐标即所见；
 *      相机的可视范围随 Scene.view 自适应，并保持画面宽高比不变形。
 *   2. 「数据驱动」：每次参数变化都重新 build → setScene 整体重建。
 *      场景很小（几十个对象），全量重建比做差量更新简单得多，也更适合学习。
 *   3. 交互只改参数：拖拽点 → 算出新参数值 → 重建场景。
 *      场景代码（scenes/*.ts）永远只是「参数的函数」，不含交互逻辑。
 *   4. 容错：任何对象求值出错（NaN/Infinity）就跳过它，绝不让整个画面崩。
 */
import * as THREE from 'three';
import type {
  ArcObject,
  CircleObject,
  CurveObject,
  ParamDef,
  ParametricObject,
  PointObject,
  PolygonObject,
  Scene,
  SceneObject,
  SegmentObject,
  VectorObject,
  Vec2Like,
  ViewRange,
} from '../protocol/scene';
import { evalNumber, evalVec2 } from '../protocol/expr';
import { makeTextSprite } from './textSprite';
import type { AnnotationMark } from './annotations';

/** 视频讲解的"重点色"：暖橙。高亮的边、角、标注都用它，和界面主色一致 */
const ACCENT = 0xea580c;
const ACCENT_CSS = '#c2410c';
/** 覆盖层的 z：压在对象层之上，与标注层错开一点（正交相机下只是渲染顺序的保险） */
const OVERLAY_Z = 0.8;

const COLORS = {
  grid: 0xd8d5cc,
  axis: 0x6b6960,
  tick: '#6b6960',
  point: 0xd85a30,
  segment: 0x5f5e5a,
  curve: 0x185fa5,
  circle: 0x888780,
  polygon: 0x185fa5,
  arc: 0xd85a30,
  vector: 0x185fa5,
  label: '#2c2c2a',
};

interface DragUserData {
  objId: string;
  bind?: { x?: string; y?: string; angle?: string };
  constraint?: { type: 'circle'; center: [number, number]; radius: number };
}

/**
 * 一条"正在演出来"的覆盖图形。
 *
 * progress 是这条线目前画了百分之几：0 = 还没动笔，1 = 画完。
 * 渲染器按折线弧长截断，于是"作辅助线"真的看起来像有人从 A 画到 B，
 * 角度弧也会像圆规一样一点点扫出来。
 */
export interface OverlayShape {
  /** 稳定标识：同一动作在每一帧都用同一个 key，渲染器才能复用几何体 */
  key: string;
  /** 世界坐标折线 */
  points: Array<[number, number]>;
  /** 0~1：按弧长截断到百分之几 */
  progress: number;
  /** 可选文字（度数、长度） */
  text?: string;
  textAt?: [number, number];
  /** 文字淡入进度（0~1），不传按 progress 算 */
  textProgress?: number;
  /** 颜色，默认暖橙 */
  color?: string | number;
  dashed?: boolean;
  /** 整体透明度（旧句留下的记号压到 0.45，让当前句仍是视觉中心） */
  opacity?: number;
  /**
   * 大于 0 时改用"面片"画（宽度为世界单位）。
   * 为什么需要：WebGL 在 Windows 上忽略 linewidth，线永远 1 像素；
   * 辅助线是讲解的主线，1 像素在投影上看不清，只能拿一圈面片冒充粗线。
   */
  width?: number;
}

interface OverlayItem {
  obj: THREE.Object3D;
  geo: THREE.BufferGeometry;
  mat: THREE.LineBasicMaterial | THREE.MeshBasicMaterial;
  /** 顶点容量（点数），不够时扩容一次 */
  capacity: number;
  sprite?: THREE.Sprite;
  spriteText?: string;
  ribbon: boolean;
}

export class SceneRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  /** 场景对象层：每次 setScene 全量重建 */
  private objectGroup = new THREE.Group();
  /** 网格/坐标轴层：随视图范围重建 */
  private gridGroup = new THREE.Group();
  /**
   * 标注层（视频讲解用）。
   * 单独一层而不是塞进对象桶：标注是"讲到才出现"的临时记号，
   * 与场景对象生命周期不同，混在一起会在 rebuild 时被一起清掉。
   */
  private annotationGroup = new THREE.Group();
  /** 当前要显示的标注（rebuild 之后要能照原样重画——缩放/改参数都会重建） */
  private pendingAnnotations: AnnotationMark[] = [];
  /**
   * 逐帧覆盖层（讲解视频专用）：辅助线的"生长"、角度弧的"扫出"、
   * 板书里的动态记号都画在这一层。
   *
   * 为什么不复用 annotationGroup：标注是"整条一起出现"的静态记号，
   * 而这层每一帧都在变长度——两者的生命周期和更新频率完全不同，
   * 混在一起会导致每帧重建整个标注层（文字贴图重建非常贵）。
   */
  private overlayGroup = new THREE.Group();
  private pendingOverlay: OverlayShape[] = [];
  private overlayItems = new Map<string, OverlayItem>();
  /** 覆盖层文字的相对字号（主画布 1，视频板块会调大一点） */
  overlayTextScale = 1;
  private container: HTMLElement;

  private currentScene: Scene | null = null;
  private params: Record<string, number> = {};

  /** 本轮重建中收集到的内容点坐标（供自动兜底取景用） */
  private contentPts: Array<{ x: number; y: number }> = [];
  /** setScene 时的原始 view——兜底扩视野的幅度以它为基准，防止无限放大 */
  private baseView: ViewRange | null = null;

  /** 可拖拽的拾取热区 */
  private pickables: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private dragging: DragUserData | null = null;
  /** 拖拽时，指针射线与 z=0 平面的交点就是世界坐标 */
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private hitPoint = new THREE.Vector3();

  /** 容器尺寸变化的尾延迟防抖句柄（0 = 没有待处理的） */
  private resizeTimer = 0;

  /** 参数被拖拽改变时回调，供 UI（滑杆、数值）同步 */
  onParamChange?: (name: string, value: number) => void;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xf7f6f3);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.camera.position.z = 10;

    this.scene.add(this.gridGroup, this.objectGroup, this.annotationGroup, this.overlayGroup);

    const el = this.renderer.domElement;
    el.style.cursor = 'crosshair';
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    el.addEventListener('pointerup', () => this.endDrag());
    el.addEventListener('pointercancel', () => this.endDrag());
    window.addEventListener('resize', () => this.onResize());
    // 容器自身也会变宽变窄（右侧知识点抽屉展开时舞台让步）。
    // 只监听 window 的话，那种情况下画布尺寸不更新，图会被压扁或裁掉一角。
    // 用尾延迟防抖：抽屉有 0.22s 的过渡动画，每帧重建一次太浪费——
    // 等宽度稳定下来再量一次就够。
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = window.setTimeout(() => {
          this.resizeTimer = 0;
          this.onResize();
        }, 90);
      });
      ro.observe(container);
    }

    this.onResize();
  }

  /** 设置场景（纯数据）与当前参数值，并重绘画布 */
  setScene(scene: Scene, params: Record<string, number>) {
    this.currentScene = scene;
    this.params = { ...params };
    // 记住原始 view：兜底扩视野只以此为基准，不会无限放大
    this.baseView = { ...scene.view };
    this.rebuild();
  }

  /** 改单个参数并重绘（拖拽时每一帧调用） */
  setParam(name: string, value: number) {
    this.params[name] = value;
    this.rebuild();
  }

  getParams(): Record<string, number> {
    return { ...this.params };
  }

  /**
   * 当前实际生效的视野（含 autoFitView 兜底扩张后的结果）。
   *
   * 为什么要把这个暴露出来？——「画面被挤成中间一条竖带」那次事故的根因
   * 就藏在这里：autoFitView 少写了一层并集，把 view 覆盖成了内容包围盒。
   * 数据层测试看不到它，只有把最终视野读出来才能自动断言
   * 「该扩的时候扩了、不该缩的时候没缩」。
   */
  getView(): ViewRange {
    const v = this.currentScene?.view ?? this.baseView;
    return v ? { ...v } : { xMin: -5, xMax: 5, yMin: -5, yMax: 5 };
  }

  // ---------------------------------------------------------------
  // 重建流程
  // ---------------------------------------------------------------

  private rebuild() {
    if (!this.currentScene) return;
    // 内容重建（换场景/拖滑杆改参数）= 相机回到默认取景，运镜作废
    this.viewOverride = null;
    this.camTween = null;
    this.disposeGroup(this.objectGroup);
    this.disposeGroup(this.gridGroup);
    this.disposeGroup(this.annotationGroup);
    this.pickables = [];
    this.idGroups.clear();
    this.contentPts = [];

    this.updateCamera();
    this.buildGrid();

    for (const obj of this.currentScene.objects) {
      // 每个对象先装进自己的"桶"再挂到场景层——
      // 桶以对象 id 命名，setStep 的显示/隐藏/高亮都按桶操作
      const bucket = new THREE.Group();
      const outer = this.objectGroup;
      this.objectGroup = bucket; // 各 buildXxx 都往 this.objectGroup 里 add，临时指向桶
      try {
        this.buildObject(obj);
      } catch (err) {
        // 单个对象失败不影响其他对象
        console.warn(`对象 ${obj.id} 构建失败：`, err);
      }
      this.objectGroup = outer;
      outer.add(bucket);
      this.idGroups.set(obj.id, bucket);
    }

    // 兜底取景：内容超出 view 时自动扩视野（内部可能触发一次重建）
    this.autoFitView();

    this.applyStep();
    // 标注按世界坐标画，视野/尺寸变了要按新比例重画一遍（否则弧会变形、字号会不对）
    this.drawAnnotations();
    this.renderer.render(this.scene, this.camera);
  }

  /** 记录一个内容点坐标，供自动兜底取景用（非有限值直接丢弃） */
  private note(x: number, y: number) {
    if (isFinite(x) && isFinite(y)) this.contentPts.push({ x, y });
  }

  /**
   * 自动兜底取景：内容超出 view 时把视野扩大（只扩不缩）。
   *
   * 为什么需要它？LLM 偶尔给出「装不下自己坐标」的 view——
   * 比如将军饮马问题里把点放在 (8,0)，view 却只到 5，画面就被裁掉一半。
   * 与其每次靠改 prompt 祈祷模型写对，不如渲染器层面兜底：
   * 构建对象时收集所有实际坐标，超界就把 view 扩到能装下为止。
   *
   * 安全阀：扩幅上限为原始 view 跨度的 6 倍（相对 baseView 计算），
   * 防止曲线值爆炸（如 y=10x²）把视野无限放大成一片空白。
   * 曲线 y=f(x) 的采样点不参与收集——陡峭曲线的 y 值动辄上百，
   * 交给它扩视野会毁掉整个画面；曲线上的交点/根通常有独立 point 对象，会正常收集。
   */
  private autoFitView() {
    if (this.contentPts.length === 0 || !this.baseView) return;
    const view = this.currentScene!.view;

    // 内容包围盒
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of this.contentPts) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }

    // 完全在 view 内就收工：不折腾。只有真的画不下了才扩——
    // 否则任何贴边的线段都会让视野无条件放大 8%，视线被无谓地拉远。
    const overflow =
      x0 < view.xMin - 1e-9 || x1 > view.xMax + 1e-9 ||
      y0 < view.yMin - 1e-9 || y1 > view.yMax + 1e-9;
    if (!overflow) return;

    // 确实超界了，四周留 8% 边距，给点和标签留呼吸空间
    const mx = (x1 - x0) * 0.08 || 1;
    const my = (y1 - y0) * 0.08 || 1;
    x0 -= mx; x1 += mx; y0 -= my; y1 += my;

    // 与当前 view 取并集（只扩不缩），但每轴最多扩到 baseView 跨度的 6 倍。
    // 注意每个方向都是「先按上限夹住内容，再与现有 view 取并集」——
    // 少了外层的 min/max 就会把 view 直接覆盖成内容包围盒（画面被挤成一条）。
    const maxSpanX = (this.baseView.xMax - this.baseView.xMin) * 6;
    const maxSpanY = (this.baseView.yMax - this.baseView.yMin) * 6;
    const nx0 = Math.min(view.xMin, Math.max(x0, view.xMax - maxSpanX));
    const nx1 = Math.max(view.xMax, Math.min(x1, view.xMin + maxSpanX));
    const ny0 = Math.min(view.yMin, Math.max(y0, view.yMax - maxSpanY));
    const ny1 = Math.max(view.yMax, Math.min(y1, view.yMin + maxSpanY));

    const changed =
      nx0 < view.xMin - 1e-9 || nx1 > view.xMax + 1e-9 ||
      ny0 < view.yMin - 1e-9 || ny1 > view.yMax + 1e-9;
    if (!changed) return;

    view.xMin = nx0; view.xMax = nx1;
    view.yMin = ny0; view.yMax = ny1;
    // 视野变了：网格、相机、曲线采样都要按新 view 重来一遍。
    // 第二轮内容点已落在 view 内，不会再触发扩张，递归到此为止。
    this.rebuild();
  }

  // ---------------------------------------------------------------
  // 分步讲解（阶段 2）：步骤切换 = 改各"桶"的可见性与材质
  // ---------------------------------------------------------------
  private idGroups = new Map<string, THREE.Group>();
  private stepIndex = -1; // -1 = 未启用步骤模式（全部正常显示）

  // ---- 步骤运镜（视频化讲解 阶段①·2D 版）----
  // 2D 相机是正交投影，"看向哪、看多大"由 left/right/top/bottom 四个值决定，
  // updateCamera 平时从场景 view 现算它们。运镜期间用 viewOverride 覆盖，
  // 动画结束停在覆盖值上（用户拖拽/换场景时再清掉）。
  private viewOverride: {
    cx: number;
    cy: number;
    halfW: number;
    halfH: number;
  } | null = null;
  private camTween: {
    from: { cx: number; cy: number; halfW: number; halfH: number };
    to: { cx: number; cy: number; halfW: number; halfH: number };
    start: number;
    duration: number;
  } | null = null;

  /** 步骤切换是否自动运镜（飞到高亮对象跟前）。
   *  主画布默认关闭——坐标轴和画布必须保持不动，缩放只由参数滑杆控制；
   *  讲解视频板块的渲染器可以打开，视频里运镜是加分项。 */
  stepFlyEnabled = true;

  /**
   * 视频分镜模式：显隐/高亮不再从 steps 推，而是由播放器按"当前这一句"直接给。
   *
   * 为什么需要：一条 step 的 highlight 是整步的，而讲解视频要一句话一个重点
   * （说到交线才亮交线、说到辅助线才让它长出来）。steps 里没有这个粒度，
   * 所以由播放器逐句算好集合传进来，渲染器只负责照着画。
   * null = 普通步骤模式（主画布永远走这条路，互不干扰）。
   */
  private focusOverride: {
    progressive: Set<string>;
    revealed: Set<string>;
    highlight: Set<string>;
  } | null = null;

  /** 当前"在讲的重点"——运镜要飞向它；分镜模式每句都会更新 */
  private activeHighlight: string[] = [];

  /**
   * 高亮要不要"加色加粗"（暖橙 + 面片描边）。
   *
   * 默认 false：主画布保持原来的样子——只把别的对象压淡，重点本身不改色。
   * 讲解视频会打开它：那个画布镜头完全不动，没有颜色和粗细的差别就
   * 根本看不出在讲哪条边。
   */
  accentHighlight = false;

  /**
   * 非重点对象的压暗倍数（1 = 完全不压暗，0.25 = 只留四分之一）。
   * 主画布沿用 0.25 的老观感；视频里要"图一直在黑板上"，
   * 压到 0.25 会让整张图看起来每句都在消失，所以调高到 0.6。
   */
  dimFactor = 0.25;

  /**
   * 视频分镜用：按「本句高亮 / 已经出现的对象 / 会被渐进揭示的全集」渲染。
   * 与 setStep 并存，互不覆盖。
   */
  applyFocus(highlight: string[], revealed: string[], progressive: string[]) {
    this.focusOverride = {
      highlight: new Set(highlight),
      revealed: new Set(revealed),
      progressive: new Set(progressive),
    };
    this.applyStep();
    this.renderer.render(this.scene, this.camera);
  }

  /** 退出分镜模式，回到 steps 驱动（视频停止播放时调用） */
  clearFocus() {
    this.focusOverride = null;
    this.pendingAnnotations = [];
    this.disposeGroup(this.annotationGroup);
    this.applyStep();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 设置当前要显示的标注（视频讲解专用）。
   * 传空数组 = 清空。由播放器每句算好传进来，渲染器只管画。
   */
  setAnnotations(marks: AnnotationMark[]) {
    this.pendingAnnotations = marks;
    this.disposeGroup(this.annotationGroup);
    this.drawAnnotations();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 把标注画出来：折线用暖橙细线（角度弧 / 直角方块 / 等长刻度），
   * 文字用精灵贴在指定位置。
   *
   * depthTest 一律关掉：标注是"讲课时用红笔添上去的记号"，
   * 被别的线挡住就没意义了。
   */
  private drawAnnotations() {
    if (this.pendingAnnotations.length === 0) return;
    const z = 0.6; // 压在对象上方
    const textH = this.labelH() * 0.95;

    for (const mark of this.pendingAnnotations) {
      for (const line of mark.polylines) {
        if (line.length < 2) continue;
        const geo = new THREE.BufferGeometry().setFromPoints(
          line.map(([x, y]) => new THREE.Vector3(x, y, z)),
        );
        const mat = new THREE.LineBasicMaterial({
          color: ACCENT,
          depthTest: false,
          transparent: true,
        });
        const l = new THREE.Line(geo, mat);
        l.renderOrder = 10;
        this.annotationGroup.add(l);
      }
      if (mark.text && mark.at) {
        const s = makeTextSprite(mark.text, {
          worldHeight: textH,
          color: ACCENT_CSS,
        });
        s.position.set(mark.at[0], mark.at[1], z + 0.05);
        s.renderOrder = 11;
        this.annotationGroup.add(s);
      }
    }
  }


  // ---------------------------------------------------------------
  // 逐帧覆盖层：辅助线生长、角度弧扫出、动态记号
  // ---------------------------------------------------------------

  /**
   * 设置这一帧要显示的覆盖图形。播放器每帧调用一次（约 60 次/秒）。
   *
   * 性能上做的是"增量更新"而不是"清空重建"：
   * 同一个 key 的图形复用同一个 BufferGeometry，只改顶点和 drawRange。
   * 如果每帧新建几何体，60fps 下几秒钟就会堆出上千个 BufferGeometry，
   * 显存和 GC 都扛不住（第一版就是这么写的，播放十秒后明显掉帧）。
   */
  setOverlay(shapes: OverlayShape[]) {
    this.pendingOverlay = shapes;
    this.drawOverlay();
    this.renderer.render(this.scene, this.camera);
  }

  /** 清空覆盖层（暂停/退出视频时调用） */
  clearOverlay() {
    this.pendingOverlay = [];
    this.drawOverlay();
    this.renderer.render(this.scene, this.camera);
  }

  private drawOverlay() {
    const seen = new Set<string>();
    for (const shape of this.pendingOverlay) {
      if (shape.points.length < 2) continue;
      seen.add(shape.key);
      let item = this.overlayItems.get(shape.key);
      if (!item) {
        item = this.createOverlayItem(shape);
        this.overlayItems.set(shape.key, item);
        this.overlayGroup.add(item.obj);
      }
      this.updateOverlayItem(item, shape);
    }
    // 这一帧没出现的图形 = 动作已经演完并被移出（或整句切走了），回收掉
    for (const [key, item] of Array.from(this.overlayItems)) {
      if (seen.has(key)) continue;
      this.overlayGroup.remove(item.obj);
      this.disposeOverlayItem(item);
      this.overlayItems.delete(key);
    }
  }

  private createOverlayItem(shape: OverlayShape): OverlayItem {
    const ribbon = (shape.width ?? 0) > 0;
    const capacity = 512;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(capacity * 3), 3),
    );

    const color = new THREE.Color(shape.color ?? ACCENT);
    let mat: THREE.LineBasicMaterial | THREE.MeshBasicMaterial;
    let obj: THREE.Object3D;

    if (ribbon) {
      mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      obj = new THREE.Mesh(geo, mat);
    } else if (shape.dashed) {
      mat = new THREE.LineDashedMaterial({
        color,
        dashSize: 0.16,
        gapSize: 0.11,
        transparent: true,
        depthTest: false,
      });
      obj = new THREE.Line(geo, mat);
    } else {
      mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        depthTest: false,
      });
      obj = new THREE.Line(geo, mat);
    }
    obj.renderOrder = 12;
    return { obj, geo, mat, capacity, ribbon };
  }

  private updateOverlayItem(item: OverlayItem, shape: OverlayShape) {
    const pts = trimPolyline(shape.points, shape.progress);
    const count = item.ribbon
      ? this.writeRibbon(item, pts, shape.width ?? 0.05)
      : this.writeLine(item, pts);

    item.geo.setDrawRange(0, count);
    const attr = item.geo.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    // 顶点每帧都在变，包围盒算出来也没有意义；直接关掉视锥剔除省掉这份开销
    item.obj.frustumCulled = false;
    (item.mat as THREE.LineBasicMaterial).color.set(shape.color ?? ACCENT);
    const baseOpacity = shape.opacity ?? 1;
    item.mat.transparent = baseOpacity < 1;
    item.mat.opacity = baseOpacity;
    item.obj.visible = count > 0;

    if (shape.dashed && item.obj instanceof THREE.Line) {
      item.obj.computeLineDistances();
    }

    // ---- 文字：度数/长度，跟着图形一起淡入 ----
    if (shape.text && shape.textAt) {
      const op = shape.textProgress ?? Math.max(0, (shape.progress - 0.55) / 0.45);
      if (!item.sprite || item.spriteText !== shape.text) {
        if (item.sprite) {
          item.obj.remove(item.sprite);
          this.disposeMaterial(item.sprite.material as THREE.Material);
        }
        const s = makeTextSprite(shape.text, {
          // 视频里经常全屏看，字要比主画布再大一点才读得清
          worldHeight: this.labelH() * 0.95 * this.overlayTextScale,
          color: ACCENT_CSS,
        });
        s.renderOrder = 13;
        item.obj.add(s);
        item.sprite = s;
        item.spriteText = shape.text;
      }
      const sp = item.sprite;
      // 精灵是 obj 的子对象：obj 已经整体画在 OVERLAY_Z 上，这里只补一点相对高度，
      // 保证文字压在自己的线上方
      const at = this.clampToView(shape.textAt);
      sp.position.set(at[0], at[1], 0.02);
      const sm = sp.material as THREE.SpriteMaterial;
      sm.opacity = Math.min(1, Math.max(0, op)) * baseOpacity;
      sm.transparent = true;
      sp.visible = sm.opacity > 0.02;
    } else if (item.sprite) {
      item.obj.remove(item.sprite);
      this.disposeMaterial(item.sprite.material as THREE.Material);
      item.sprite = undefined;
      item.spriteText = undefined;
    }
  }

  /**
   * 把标注文字收进可视范围。
   * 长度标签默认挂在边的外侧，边正好贴着视野边缘时（比如底边就是 x 轴），
   * 标签会被推到画面外——肉眼看就是"数字被切掉了"。留一点内边距再夹一次。
   */
  private clampToView(p: [number, number]): [number, number] {
    const cam = this.camera;
    const insetX = (cam.right - cam.left) * 0.03;
    const insetY = (cam.top - cam.bottom) * 0.05;
    return [
      Math.min(cam.right - insetX, Math.max(cam.left + insetX, p[0])),
      Math.min(cam.top - insetY, Math.max(cam.bottom + insetY, p[1])),
    ];
  }

  /** 普通折线：直接写顶点 */
  private writeLine(item: OverlayItem, pts: Array<[number, number]>): number {
    const n = Math.min(pts.length, item.capacity);
    const arr = (item.geo.getAttribute('position') as THREE.BufferAttribute)
      .array as Float32Array;
    for (let i = 0; i < n; i++) {
      arr[i * 3] = pts[i][0];
      arr[i * 3 + 1] = pts[i][1];
      arr[i * 3 + 2] = OVERLAY_Z;
    }
    return n;
  }

  /** 面片折线：每段展开成一个四边形（两个三角形），用来冒充粗线 */
  private writeRibbon(
    item: OverlayItem,
    pts: Array<[number, number]>,
    width: number,
  ): number {
    const arr = (item.geo.getAttribute('position') as THREE.BufferAttribute)
      .array as Float32Array;
    const half = Math.max(width, 0.004) / 2;
    let v = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const l = Math.hypot(dx, dy);
      if (l < 1e-9) continue;
      const nx = (-dy / l) * half;
      const ny = (dx / l) * half;
      const quad: Array<[number, number]> = [
        [x0 + nx, y0 + ny],
        [x1 + nx, y1 + ny],
        [x1 - nx, y1 - ny],
        [x0 + nx, y0 + ny],
        [x1 - nx, y1 - ny],
        [x0 - nx, y0 - ny],
      ];
      for (const [px, py] of quad) {
        if (v + 3 > arr.length) return v / 3;
        arr[v++] = px;
        arr[v++] = py;
        arr[v++] = OVERLAY_Z;
      }
    }
    return v / 3;
  }

  private disposeOverlayItem(item: OverlayItem) {
    item.geo.dispose();
    this.disposeMaterial(item.mat);
    if (item.sprite) this.disposeMaterial(item.sprite.material as THREE.Material);
  }

  /** 切换到第 index 步（0 起）；传入场景里没有 steps 时不生效 */
  setStep(index: number) {
    this.stepIndex = index;
    this.applyStep();
    // 可选运镜：仅当 stepFlyEnabled 打开时才飞到高亮对象（主画布关闭 = 视野纹丝不动）
    if (this.stepFlyEnabled) this.flyToHighlight();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 2D 步骤运镜：把本步 highlight 且可见的对象收进包围盒，
   * 相机（正交视野）从当前值平滑过渡到"包住包围盒再留 1.8 倍余量"。
   * 2D 渲染是按需渲染（无常驻帧循环），所以补间自带一个临时 rAF 小循环。
   */
  private flyToHighlight(duration = 700) {
    // 飞向"当前在讲的重点"：普通步骤模式由 applyStep 从 steps 里取，
    // 分镜模式由 applyFocus 逐句更新——两种情况共用这一条运镜。
    const highlighted = this.activeHighlight;
    if (highlighted.length === 0) return;

    const box = new THREE.Box3();
    let found = false;
    for (const id of highlighted) {
      const g = this.idGroups.get(id);
      if (!g || !g.visible) continue;
      box.expandByObject(g);
      found = true;
    }
    if (!found) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // 包住内容再留余量，别把重点顶到画面边上
    const contentW = Math.max(size.x * 1.8, 0.5);
    const contentH = Math.max(size.y * 1.8, 0.5);
    // 按画布宽高比适配：跟 updateCamera 的 autoFit 同一套逻辑
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const aspect = w / h;
    let halfW = contentW / 2;
    let halfH = contentH / 2;
    if (aspect > contentW / contentH) halfW = halfH * aspect;
    else halfH = halfW / aspect;

    this.camTween = {
      from: this.viewOverride
        ? { ...this.viewOverride }
        : {
            cx: (this.camera.left + this.camera.right) / 2,
            cy: (this.camera.top + this.camera.bottom) / 2,
            halfW: (this.camera.right - this.camera.left) / 2,
            halfH: (this.camera.top - this.camera.bottom) / 2,
          },
      to: { cx: center.x, cy: center.y, halfW, halfH },
      start: performance.now(),
      duration,
    };
    // 连续点步骤时先停掉上一段，从当前视野接着飞（不瞬移回起点）
    this.tickCameraTween();
  }

  /**
   * 视频分镜：镜头飞到当前这一句的重点对象。
   * 用短补间（默认 420ms）——一句话只有几秒，运镜必须"跟手"而不是"飘过去"。
   */
  flyToActive(duration = 420) {
    this.flyToHighlight(duration);
  }

  /** 每帧推进 2D 运镜补间；easeInOutCubic 先加速后减速 */
  private tickCameraTween() {
    const tw = this.camTween;
    if (!tw) return;
    const k = Math.min(1, (performance.now() - tw.start) / tw.duration);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const lerp = (a: number, b: number) => a + (b - a) * e;
    this.viewOverride = {
      cx: lerp(tw.from.cx, tw.to.cx),
      cy: lerp(tw.from.cy, tw.to.cy),
      halfW: lerp(tw.from.halfW, tw.to.halfW),
      halfH: lerp(tw.from.halfH, tw.to.halfH),
    };
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
    if (k < 1) {
      requestAnimationFrame(() => this.tickCameraTween());
    } else {
      this.camTween = null;
    }
  }

  private applyStep() {
    // 分镜模式优先：显隐与高亮全部由播放器逐句给（讲解视频走这条）
    if (this.focusOverride) {
      this.applyFocusSets(
        this.focusOverride.progressive,
        this.focusOverride.revealed,
        this.focusOverride.highlight,
      );
      return;
    }

    const steps = this.currentScene?.steps;
    if (!steps || steps.length === 0 || this.stepIndex < 0) {
      // 无步骤模式：全部显示、恢复默认透明度
      this.activeHighlight = [];
      for (const g of this.idGroups.values()) {
        g.visible = true;
        this.setBucketState(g, 'normal');
      }
      return;
    }
    const idx = Math.min(this.stepIndex, steps.length - 1);

    // 「渐进出现」的对象 = 被任何一步的 reveal 提到过的 id。
    // 没被提到过的对象始终可见——否则一用 reveal，所有背景对象都会消失。
    const progressive = new Set<string>();
    for (const s of steps) for (const id of s.reveal ?? []) progressive.add(id);

    // 截至当前步，已经出现的对象 id
    const revealed = new Set<string>();
    for (let i = 0; i <= idx; i++) {
      for (const id of steps[i].reveal ?? []) revealed.add(id);
    }

    this.applyFocusSets(progressive, revealed, new Set(steps[idx].highlight ?? []));
  }

  /**
   * 按三个集合落显隐与压暗——渲染器唯一的"重点"入口。
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
    for (const [id, g] of this.idGroups) {
      g.visible = progressive.has(id) ? revealed.has(id) : true;
      const state = !dimOthers
        ? 'normal'
        : !highlighted.has(id)
          ? 'dim'
          : this.accentHighlight
            ? 'hl'
            : 'normal';
      this.setBucketState(g, state);
    }
  }

/**
   * 把一个对象桶画成三种状态之一：
   *   normal —— 正常（无步骤模式，或本步没写 highlight）
   *   dim    —— 淡出到 25%（背景，本步不讲它）
   *   hl     —— 重点：换成暖橙 + 显示加粗描边 + 圆点放大
   *
   * 为什么要有 hl 这一档？——讲解视频的镜头现在完全不动，
   * 如果重点只靠"别人变淡"来表达，图上其实没有任何一处真的被指出来。
   * 加色加粗就是那个"红笔圈一下"。
   */
  private setBucketState(g: THREE.Group, state: 'normal' | 'dim' | 'hl') {
    const dim = state === 'dim';
    g.traverse((node) => {
      const ud = node.userData as Record<string, unknown>;
      // 加粗描边：单独一份面片，只在 hl 状态显示（WebGL 的 linewidth 恒为 1px，
      // 想画出 "粗线" 只能靠面片，改参数是没用的）
      if (ud.__hlStroke) {
        node.visible = state === 'hl';
        return;
      }
      // 点：hl 时稍微放大，像被笔尖点了一下
      if (ud.__dot) {
        (node as THREE.Mesh).scale.setScalar(state === 'hl' ? 1.45 : 1);
      }
      const mats = (node as THREE.Mesh).material;
      if (!mats) return;
      const list = Array.isArray(mats) ? mats : [mats];
      for (const m of list) {
        const mat = m as THREE.MeshBasicMaterial & {
          opacity: number;
          userData: Record<string, unknown>;
        };
        if (!('opacity' in mat)) continue;
        // 记住材质原本的 transparent / opacity / color：
        // ① 精灵贴图本来透明，关掉会把透明区域渲染成黑块；
        // ② 可拖拽点的"拾取热区"是 opacity=0 的隐形大圆，
        //    若恢复时写成 1，会变成一个醒目的大白盘。
        if (mat.userData.__origTransparent === undefined) {
          mat.userData.__origTransparent = mat.transparent;
          mat.userData.__origOpacity = mat.opacity;
        }
        if (mat.color && mat.userData.__origColor === undefined) {
          mat.userData.__origColor = mat.color.getHex();
        }
        const origOpacity = mat.userData.__origOpacity as number;
        // 文字精灵只调透明度、不染成橙色：橙字配橙线会糊成一团，读不清
        const isSprite = (mat as unknown as { isSpriteMaterial?: boolean })
          .isSpriteMaterial === true;
        if (!isSprite && mat.color) {
          mat.color.setHex(
            state === 'hl' ? ACCENT : (mat.userData.__origColor as number),
          );
        }
        mat.transparent = dim
          ? true
          : (mat.userData.__origTransparent as boolean);
        mat.opacity = dim ? origOpacity * this.dimFactor : origOpacity;
        mat.needsUpdate = true;
      }
    });
  }

  /** 播放器专用：整幅画面缓慢推近（1 = 原样，>1 更近）。不影响主画布的滑杆/拖拽逻辑 */
  private zoomScale = 1;

  /**
   * 设置推近倍率并立即重绘。
   * 讲解视频在一步之内把倍率从 1.00 缓慢推到 1.06，画面就有"呼吸感"；
   * 主画布不会调用它，视野保持固定。
   */
  setZoomScale(scale: number) {
    const s = Math.max(0.6, Math.min(2, scale));
    if (Math.abs(s - this.zoomScale) < 0.0005) return;
    this.zoomScale = s;
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  private onResize() {
    this.updateCamera();
    // 标签/点的尺寸现在按屏幕像素定，窗口变了要重建才能跟上新尺寸
    this.rebuild();
  }

  /** 正交相机自适应：让 Scene.view 完整可见，且宽高比不变形 */
  private updateCamera() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);

    if (!this.currentScene) return;

    // 运镜期间：视野由补间给出的覆盖值决定（含宽高比适配），不用场景默认 view
    if (this.viewOverride) {
      const o = this.viewOverride;
      // 推近倍率作用在视野半宽高上：倍率越大，看到的范围越小 = 画面更近
      const hw = o.halfW / this.zoomScale;
      const hh = o.halfH / this.zoomScale;
      this.camera.left = o.cx - hw;
      this.camera.right = o.cx + hw;
      this.camera.top = o.cy + hh;
      this.camera.bottom = o.cy - hh;
      this.camera.updateProjectionMatrix();
      return;
    }

    const view = this.currentScene.view;
    const viewW = view.xMax - view.xMin;
    const viewH = view.yMax - view.yMin;
    const cx = (view.xMin + view.xMax) / 2;
    const cy = (view.yMin + view.yMax) / 2;

    // 画布比视图「宽」时，沿 x 方向扩展；否则沿 y 方向扩展
    const canvasAspect = w / h;
    let effW = viewW;
    let effH = viewH;
    if (canvasAspect > viewW / viewH) {
      effW = viewH * canvasAspect;
    } else {
      effH = viewW / canvasAspect;
    }

    // 推近倍率：视野范围除以倍率（倍率 1 = 原样，1.06 = 画面放大 6%）
    const hw = effW / 2 / this.zoomScale;
    const hh = effH / 2 / this.zoomScale;
    this.camera.left = cx - hw;
    this.camera.right = cx + hw;
    this.camera.top = cy + hh;
    this.camera.bottom = cy - hh;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 画布上 px 像素对应的世界尺寸。
   * 标签/点若按世界坐标定尺寸，view 一大字就缩成蚂蚁、view 一小又糊成一片；
   * 改成按屏幕像素定尺寸，任何 view 下可读性恒定。
   */
  private pxToWorld(px: number): number {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    if (!this.currentScene) return px * 0.05;
    const view = this.currentScene.view;
    const viewW = view.xMax - view.xMin;
    const viewH = view.yMax - view.yMin;
    const canvasAspect = w / h;
    // 与 updateCamera 一致：算出画布实际覆盖的世界高度
    const effH = canvasAspect > viewW / viewH ? viewH : viewW / canvasAspect;
    return (px * effH) / h;
  }

  /** 标签字高：约 15 屏幕像素 */
  private labelH(): number {
    return this.pxToWorld(15);
  }

  /** 点半径：约 5.5 屏幕像素 */
  private pointR(): number {
    return this.pxToWorld(5.5);
  }

  // ---------------------------------------------------------------
  // 网格与坐标轴
  // ---------------------------------------------------------------

  private buildGrid() {
    const view = this.currentScene!.view;
    const step = niceStep(
      Math.max(view.xMax - view.xMin, view.yMax - view.yMin),
    );
    const z = -0.5; // 网格在对象下方

    // 网格线
    const pts: number[] = [];
    for (
      let x = Math.ceil(view.xMin / step) * step;
      x <= view.xMax + 1e-9;
      x += step
    ) {
      pts.push(x, view.yMin, z, x, view.yMax, z);
    }
    for (
      let y = Math.ceil(view.yMin / step) * step;
      y <= view.yMax + 1e-9;
      y += step
    ) {
      pts.push(view.xMin, y, z, view.xMax, y, z);
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(pts, 3),
    );
    this.gridGroup.add(
      new THREE.LineSegments(
        gridGeo,
        new THREE.LineBasicMaterial({ color: COLORS.grid }),
      ),
    );

    // 坐标轴（x 轴 / y 轴，加深一点）
    const axisPts: number[] = [];
    if (view.yMin <= 0 && view.yMax >= 0) {
      axisPts.push(view.xMin, 0, z, view.xMax, 0, z);
    }
    if (view.xMin <= 0 && view.xMax >= 0) {
      axisPts.push(0, view.yMin, z, 0, view.yMax, z);
    }
    if (axisPts.length > 0) {
      const axisGeo = new THREE.BufferGeometry();
      axisGeo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(axisPts, 3),
      );
      this.gridGroup.add(
        new THREE.LineSegments(
          axisGeo,
          new THREE.LineBasicMaterial({ color: COLORS.axis }),
        ),
      );
    }

    // 刻度标签 + 原点 O
    const labelH = this.labelH() * 0.8;
    for (
      let x = Math.ceil(view.xMin / step) * step;
      x <= view.xMax + 1e-9;
      x += step
    ) {
      if (Math.abs(x) < 1e-9) continue;
      const s = makeTextSprite(formatTick(x), {
        worldHeight: labelH,
        color: COLORS.tick,
      });
      s.position.set(x, -labelH * 1.1, 0);
      this.gridGroup.add(s);
    }
    for (
      let y = Math.ceil(view.yMin / step) * step;
      y <= view.yMax + 1e-9;
      y += step
    ) {
      if (Math.abs(y) < 1e-9) continue;
      const s = makeTextSprite(formatTick(y), {
        worldHeight: labelH,
        color: COLORS.tick,
      });
      s.position.set(-labelH * 0.9, y, 0);
      this.gridGroup.add(s);
    }
    const origin = makeTextSprite('O', {
      worldHeight: labelH,
      color: COLORS.tick,
    });
    origin.position.set(-labelH * 0.9, -labelH * 1.1, 0);
    this.gridGroup.add(origin);
  }

  // ---------------------------------------------------------------
  // 各类场景对象
  // ---------------------------------------------------------------

  private buildObject(obj: SceneObject) {
    switch (obj.type) {
      case 'point':
        return this.buildPoint(obj);
      case 'segment':
        return this.buildSegment(obj);
      case 'vector':
        return this.buildVector(obj);
      case 'polygon':
        return this.buildPolygon(obj);
      case 'circle':
        return this.buildCircle(obj);
      case 'arc':
        return this.buildArc(obj);
      case 'curve':
        return this.buildCurve(obj);
      case 'parametric':
        return this.buildParametric(obj);
    }
  }

  /** 求值作用域：当前参数 + x/t 默认 0 */
  private scope(): Record<string, number> {
    return { x: 0, t: 0, ...this.params };
  }

  /** 解析坐标字段；无效返回 null */
  private vec(v: Vec2Like): [number, number] | null {
    return evalVec2(v, this.scope());
  }

  private buildPoint(obj: PointObject) {
    const at = this.vec(obj.at ?? '');
    if (!at) return;
    this.note(at[0], at[1]);
    const view = this.currentScene!.view;
    const r = this.pointR();

    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(r, 24),
      new THREE.MeshBasicMaterial({ color: obj.color ?? COLORS.point }),
    );
    mesh.position.set(at[0], at[1], 0.2);
    // 打标：高亮（视频讲解的重点）时把这个圆点放大一点
    mesh.userData = { __dot: true };
    this.objectGroup.add(mesh);

    // 可拖拽的点：加一个透明的大圆作为「拾取热区」，方便点中
    if (obj.draggable) {
      const pick = new THREE.Mesh(
        new THREE.CircleGeometry(r * 3, 24),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }),
      );
      pick.position.set(at[0], at[1], 0.2);
      pick.userData = {
        objId: obj.id,
        bind: obj.dragBind,
        constraint: obj.constraint,
      } satisfies DragUserData;
      this.objectGroup.add(pick);
      this.pickables.push(pick);
    }

    if (obj.label) {
      const s = makeTextSprite(obj.label, {
        worldHeight: this.labelH(),
        color: COLORS.label,
      });
      s.position.set(
        at[0] + (obj.labelOffset?.[0] ?? 0),
        at[1] + r * 3.2 + (obj.labelOffset?.[1] ?? 0),
        0.3,
      );
      this.objectGroup.add(s);
    }
  }

  private buildSegment(obj: SegmentObject) {
    const from = this.vec(obj.from);
    const to = this.vec(obj.to);
    if (!from || !to) return;
    this.note(from[0], from[1]);
    this.note(to[0], to[1]);

    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from[0], from[1], 0.1),
      new THREE.Vector3(to[0], to[1], 0.1),
    ]);
    const material = obj.dashed
      ? new THREE.LineDashedMaterial({
          color: obj.color ?? COLORS.segment,
          dashSize: 0.12,
          gapSize: 0.08,
        })
      : new THREE.LineBasicMaterial({ color: obj.color ?? COLORS.segment });
    const line = new THREE.Line(geo, material);
    if (obj.dashed) line.computeLineDistances();
    this.objectGroup.add(line);
    // 高亮用的加粗描边（默认隐藏，视频讲解讲到这条边时才显示）
    this.addThickStroke(from, to);

    if (obj.label) {
      const s = makeTextSprite(obj.label, {
        worldHeight: this.labelH(),
        color: COLORS.label,
      });
      // 标签默认压在线段中点上；竖直线（如对称轴）的标签会正好压住线身上的
      // 其他标注（如顶点标签）。两步避让：
      // ① 沿法线推离线身，标签不压线；
      // ② 竖直线段额外把标签挪到 72% 高度（贴近上端），远离中部的顶点等标注。
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const len = Math.hypot(dx, dy) || 1;
      const lh = this.labelH();
      const isVertical = Math.abs(dx) < 1e-6;
      const t = isVertical ? 0.72 : 0.5;
      const off = lh * 0.8;
      const nx = (-dy / len) * off;
      const ny = (dx / len) * off;
      s.position.set(
        from[0] + dx * t + nx + (obj.labelOffset?.[0] ?? 0),
        from[1] + dy * t + ny + (obj.labelOffset?.[1] ?? 0),
        0.3,
      );
      this.objectGroup.add(s);
    }
  }

  private buildVector(obj: VectorObject) {
    const from = this.vec(obj.from);
    const to = this.vec(obj.to);
    if (!from || !to) return;

    this.buildSegment({
      type: 'segment',
      id: obj.id,
      from: obj.from,
      to: obj.to,
      color: obj.color ?? '#185fa5',
    });

    // 箭头：一个圆锥，指向 from → to 的方向
    const dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], 0);
    const len = dir.length();
    if (len < 1e-9) return;
    dir.normalize();

    const headLen = Math.min(len * 0.25, 0.35);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(headLen * 0.35, headLen, 16),
      new THREE.MeshBasicMaterial({ color: obj.color ?? COLORS.vector }),
    );
    // 圆锥默认朝 +y，用四元数把它旋到目标方向
    cone.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir,
    );
    cone.position.set(
      to[0] - dir.x * headLen * 0.4,
      to[1] - dir.y * headLen * 0.4,
      0.2,
    );
    this.objectGroup.add(cone);
  }

  private buildPolygon(obj: PolygonObject) {
    const pts: THREE.Vector3[] = [];
    for (const p of obj.points) {
      const v = this.vec(p);
      if (!v) return;
      this.note(v[0], v[1]);
      pts.push(new THREE.Vector3(v[0], v[1], 0));
    }
    if (pts.length < 3) return;

    const color = obj.color ?? COLORS.polygon;

    // 半透明填充（用 Shape + ShapeGeometry，z 略低避免盖住边线）
    if (obj.fill) {
      const shape = new THREE.Shape(
        pts.map((v) => new THREE.Vector2(v.x, v.y)),
      );
      const fillMesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.12,
          side: THREE.DoubleSide,
        }),
      );
      fillMesh.position.z = -0.05;
      this.objectGroup.add(fillMesh);
    }

    // 边线（闭合折线）
    const loopGeo = new THREE.BufferGeometry().setFromPoints([
      ...pts,
      pts[0].clone(),
    ]);
    this.objectGroup.add(
      new THREE.Line(
        loopGeo,
        new THREE.LineBasicMaterial({ color }),
      ),
    );
    // 每条边都备一份加粗描边，高亮三角形时整圈都变粗
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      this.addThickStroke([a.x, a.y], [b.x, b.y]);
    }
  }

  /**
   * 在两点之间加一条"加粗线"（面片实现）。
   *
   * 为什么不直接调 linewidth？——WebGL 规范里 linewidth 只有 1 这一个保证值，
   * Chrome/Windows 上写多少都渲染成 1px。想真变粗只能用有宽度的面片：
   * 沿线段法线各撑开半个厚度，拼成一个矩形。
   *
   * 默认 visible=false，只有 setBucketState('hl') 时才打开。
   */
  private addThickStroke(from: [number, number], to: [number, number]) {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) return;
    const w = this.pxToWorld(4.6) / 2; // 视觉上约 4~5px 粗
    const nx = (-dy / l) * w;
    const ny = (dx / l) * w;
    const z = 0.15; // 略高于原线（原线在 0.1），避免同深度打架
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          from[0] + nx, from[1] + ny, z,
          to[0] + nx, to[1] + ny, z,
          to[0] - nx, to[1] - ny, z,
          from[0] - nx, from[1] - ny, z,
        ],
        3,
      ),
    );
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: ACCENT, side: THREE.DoubleSide }),
    );
    mesh.visible = false;
    mesh.userData = { __hlStroke: true };
    this.objectGroup.add(mesh);
  }

  private buildCircle(obj: CircleObject) {
    const center = this.vec(obj.center);
    if (!center) return;
    const r = evalNumber(obj.radius, this.scope());
    if (!isFinite(r) || r <= 0) return;
    // 圆的四个极值点足以代表它的范围
    this.note(center[0], center[1]);
    this.note(center[0] + r, center[1]);
    this.note(center[0] - r, center[1]);
    this.note(center[0], center[1] + r);
    this.note(center[0], center[1] - r);

    const pts: THREE.Vector3[] = [];
    const n = 128;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push(
        new THREE.Vector3(
          center[0] + r * Math.cos(a),
          center[1] + r * Math.sin(a),
          0.1,
        ),
      );
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: obj.color ?? COLORS.circle }),
    );
    this.objectGroup.add(line);

    if (obj.label) {
      const s = makeTextSprite(obj.label, {
        worldHeight: this.labelH(),
        color: COLORS.label,
      });
      s.position.set(
        center[0] + (obj.labelOffset?.[0] ?? 0),
        center[1] + r + (obj.labelOffset?.[1] ?? 0),
        0.3,
      );
      this.objectGroup.add(s);
    }
  }

  private buildArc(obj: ArcObject) {
    const center = this.vec(obj.center);
    if (!center) return;
    const scope = this.scope();
    const r = evalNumber(obj.radius, scope);
    const a0 = evalNumber(obj.from, scope);
    const a1 = evalNumber(obj.to, scope);
    if (![r, a0, a1].every(isFinite) || r <= 0) return;
    // 用整圆的四个极值近似弧的范围（略偏保守，但足够兜底取景用）
    this.note(center[0] + r, center[1]);
    this.note(center[0] - r, center[1]);
    this.note(center[0], center[1] + r);
    this.note(center[0], center[1] - r);

    // 走最短路径：把角差归一化到 [-π, π]
    let d = a1 - a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;

    const n = 48;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (d * i) / n;
      pts.push(
        new THREE.Vector3(
          center[0] + r * Math.cos(a),
          center[1] + r * Math.sin(a),
          0.1,
        ),
      );
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.objectGroup.add(
      new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: obj.color ?? COLORS.arc }),
      ),
    );
  }

  /**
   * 参数曲线：x(t), y(t) 各自求值后连线。
   * t 是表达式变量（和 curve 的 x 同一待遇），params 里的参数照常参与——
   * 所以"振幅可调的爱心"这类场景天然支持。
   */
  private buildParametric(obj: ParametricObject) {
    const tr = obj.tRange ?? [0, 2 * Math.PI];
    const t0 = evalNumber(String(tr[0]), this.scope());
    const t1 = evalNumber(String(tr[1]), this.scope());
    if (!isFinite(t0) || !isFinite(t1) || t1 === t0) return;

    const n = obj.samples ?? 256;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      const x = evalNumber(obj.xExpr, { ...this.params, t });
      const y = evalNumber(obj.yExpr, { ...this.params, t });
      if (isFinite(x) && isFinite(y)) {
        this.note(x, y);
        pts.push(new THREE.Vector3(x, y, 0.1));
      }
    }
    if (pts.length < 2) return;

    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.objectGroup.add(
      new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: obj.color ?? COLORS.curve }),
      ),
    );

    if (obj.label) {
      const mid = pts[Math.floor(pts.length / 2)];
      const s = makeTextSprite(obj.label, { worldHeight: this.labelH() });
      s.position.set(
        mid.x + (obj.labelOffset?.[0] ?? 0),
        mid.y + this.labelH() * 0.4 + (obj.labelOffset?.[1] ?? 0),
        0.2,
      );
      this.objectGroup.add(s);
    }
  }

  private buildCurve(obj: CurveObject) {
    const view = this.currentScene!.view;
    // domain 容错：协议约定是字符串表达式，但模型/手写常直接给数字——统一转成字符串
    const raw = obj.domain ?? [view.xMin, view.xMax];
    const domain: [string, string] = [String(raw[0]), String(raw[1])];
    const scope = this.scope();
    const x0 = evalNumber(domain[0], scope);
    const x1 = evalNumber(domain[1], scope);
    if (!isFinite(x0) || !isFinite(x1) || x1 === x0) return;

    const n = obj.samples ?? 256;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = evalNumber(obj.expr, { ...this.params, x });
      if (isFinite(y)) {
        pts.push(new THREE.Vector3(x, y, 0.1));
      }
    }
    if (pts.length < 2) return;

    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.objectGroup.add(
      new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: obj.color ?? COLORS.curve }),
      ),
    );

    if (obj.label) {
      const s = makeTextSprite(obj.label, {
        worldHeight: this.labelH(),
        color: COLORS.label,
      });
      s.position.set(
        pts[0].x + (obj.labelOffset?.[0] ?? 0),
        pts[0].y + this.labelH() * 0.9 + (obj.labelOffset?.[1] ?? 0),
        0.3,
      );
      this.objectGroup.add(s);
    }
  }

  // ---------------------------------------------------------------
  // 拖拽交互
  // ---------------------------------------------------------------

  private updatePointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.currentScene) return;
    // 用户上手交互：停掉运镜（视野保持在当前覆盖值，不跳回默认）
    this.camTween = null;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    // 被 steps 隐藏的对象不可拖拽（Raycaster 不看 visible，得自己过滤）
    const visible = hits.filter((h) => {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (!o.visible) return false;
        o = o.parent;
      }
      return true;
    });
    if (visible.length > 0) {
      this.dragging = visible[0].object.userData as DragUserData;
      this.renderer.domElement.style.cursor = 'grabbing';
      this.renderer.domElement.setPointerCapture(e.pointerId);
    }
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.dragging || !this.currentScene) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.hitPoint)) {
      return;
    }
    const { x, y } = this.hitPoint;
    const { bind, constraint } = this.dragging;

    if (constraint && constraint.type === 'circle') {
      // 锁在圆上：拖拽改变的是「角度」，写回 bind.angle 指定的参数
      const { center } = constraint;
      let t = Math.atan2(y - center[1], x - center[0]);
      if (t < 0) t += Math.PI * 2; // 归一化到 [0, 2π)
      if (bind?.angle) {
        this.setParam(bind.angle, t);
        this.onParamChange?.(bind.angle, t);
      }
    } else {
      // 自由拖拽：x/y 分别写回对应参数
      if (bind?.x) {
        this.setParam(bind.x, x);
        this.onParamChange?.(bind.x, x);
      }
      if (bind?.y) {
        this.setParam(bind.y, y);
        this.onParamChange?.(bind.y, y);
      }
    }
  }

  private endDrag() {
    this.dragging = null;
    this.renderer.domElement.style.cursor = 'crosshair';
  }

  // ---------------------------------------------------------------
  // 资源释放
  // ---------------------------------------------------------------

  private disposeGroup(group: THREE.Group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((node) => {
        const any = node as unknown as {
          geometry?: THREE.BufferGeometry;
          material?: THREE.Material | THREE.Material[];
        };
        if (any.geometry) any.geometry.dispose();
        if (any.material) {
          if (Array.isArray(any.material)) {
            any.material.forEach((m) => this.disposeMaterial(m));
          } else {
            this.disposeMaterial(any.material);
          }
        }
      });
    }
  }

  private disposeMaterial(m: THREE.Material) {
    const withMap = m as unknown as { map?: THREE.Texture | null };
    if (withMap.map) withMap.map.dispose();
    m.dispose();
  }
}

// ---------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------

/** 「好看」的网格步长：把范围分成大约 8~10 格，取 1/2/5 × 10^n */
function niceStep(range: number): number {
  const rough = range / 8;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let factor: number;
  if (norm < 1.5) factor = 1;
  else if (norm < 3) factor = 2;
  else if (norm < 7) factor = 5;
  else factor = 10;
  return factor * mag;
}

function formatTick(v: number): string {
  return String(Number(v.toFixed(2)));
}

/**
 * 按弧长把折线截断到 p（0~1）。
 *
 * 这是"线条生长"动画的全部秘密：不做任何几何重建，
 * 只是每帧算出"画到这里为止"的那一段，交给 drawRange 去画。
 * 角度弧也走同一条路——弧本来就是折线采样，截断到 40% 就是扫过 40%。
 */
function trimPolyline(
  pts: Array<[number, number]>,
  p: number,
): Array<[number, number]> {
  if (pts.length < 2) return [];
  if (p >= 1) return pts;
  if (p <= 0) return [];

  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  if (total < 1e-9) return [pts[0], pts[1]];

  const target = total * p;
  const out: Array<[number, number]> = [pts[0]];
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (acc + seg >= target) {
      const t = seg < 1e-9 ? 0 : (target - acc) / seg;
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      return out;
    }
    acc += seg;
    out.push([x1, y1]);
  }
  return out;
}

/** 导出类型，方便 UI 层使用 */
export type { ParamDef };
