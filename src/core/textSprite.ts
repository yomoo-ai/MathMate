/**
 * textSprite.ts —— 把文字画成「贴图精灵」
 *
 * Three.js 没有原生文字渲染，最常见的做法是：
 *   1. 用一个离屏 canvas 把文字画出来；
 *   2. 把 canvas 当贴图，贴到一个始终朝向相机的 Sprite（精灵）上。
 * 这样文字会随场景一起缩放，也不会被 3D 变换扭曲。
 */
import * as THREE from 'three';

export interface TextSpriteOptions {
  /** 画布上的字号（像素），只影响清晰度 */
  fontSize?: number;
  /** 文字颜色 */
  color?: string;
  /** 文字在「世界坐标」里的高度（会随视野缩放） */
  worldHeight?: number;
}

export function makeTextSprite(
  text: string,
  opts: TextSpriteOptions = {},
): THREE.Sprite {
  const fontSize = opts.fontSize ?? 44;
  const color = opts.color ?? '#2c2c2a';
  const worldHeight = opts.worldHeight ?? 0.36;
  // 留白只为防边缘被裁；不能太大，否则「字」只占贴图的一小部分，
  // 在屏幕上会显得又小又虚（worldHeight 是给字高，不是给整张图）
  const pad = Math.round(fontSize * 0.16);

  const font = `500 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;

  // 先量文字宽度（此时 canvas 尺寸还没定）
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d')!;
  measureCtx.font = font;
  const textWidth = Math.ceil(measureCtx.measureText(text).width);
  const canvasWidth = textWidth + pad * 2;
  const canvasHeight = fontSize + pad * 2;

  // 定好尺寸后重新画（注意：设置 canvas.width 会重置绘图状态，字体要重新设）
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvasWidth / 2, canvasHeight / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    // 标签永远可见，不被几何体挡住
    depthTest: false,
  });

  const sprite = new THREE.Sprite(material);
  // worldHeight 指的是「文字本身」的高度：贴图里字只占 fontSize/canvasHeight，
  // 所以整体要放大同样的倍数，字高才真的等于 worldHeight。
  const spriteH = (worldHeight * canvasHeight) / fontSize;
  sprite.scale.set((spriteH * canvasWidth) / canvasHeight, spriteH, 1);
  return sprite;
}
