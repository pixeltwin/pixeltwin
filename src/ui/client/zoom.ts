// Pure: no DOM access. Zoom and pan of an image inside a box (focus mode, UI spec §5.1).
// A view places the image at (x, y) in the box, scaled by `scale`: CSS translate(x, y) scale(s).

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point, Size {}

export interface View extends Point {
  scale: number;
}

export const MAX_SCALE = 8;

/** The scale that fits the whole image in the box; never above 1 (no blurry enlargement). */
export function fitScale(image: Size, box: Size): number {
  if (image.width <= 0 || image.height <= 0) return 1;
  return Math.min(1, box.width / image.width, box.height / image.height);
}

/**
 * Keeps the image in the box: on an axis where it is smaller than the box it is centred;
 * where it is larger, no gap opens at its edges.
 */
export function clampPan(view: View, image: Size, box: Size): View {
  const w = image.width * view.scale;
  const h = image.height * view.scale;
  const x = w <= box.width ? (box.width - w) / 2 : Math.min(0, Math.max(box.width - w, view.x));
  const y = h <= box.height ? (box.height - h) / 2 : Math.min(0, Math.max(box.height - h, view.y));
  return { scale: view.scale, x, y };
}

function clampScale(scale: number, image: Size, box: Size): number {
  return Math.min(MAX_SCALE, Math.max(fitScale(image, box), scale));
}

export function fitView(image: Size, box: Size): View {
  return clampPan({ scale: fitScale(image, box), x: 0, y: 0 }, image, box);
}

/** Real pixels (100 %), from the top-left corner. */
export function actualView(image: Size, box: Size): View {
  return clampPan({ scale: 1, x: 0, y: 0 }, image, box);
}

/** Scales by `factor` around `point` (box coordinates), so the pixel under it stays put. */
export function zoomAt(view: View, factor: number, point: Point, image: Size, box: Size): View {
  const scale = clampScale(view.scale * factor, image, box);
  const k = scale / view.scale;
  return clampPan({ scale, x: point.x - (point.x - view.x) * k, y: point.y - (point.y - view.y) * k }, image, box);
}

export function panBy(view: View, dx: number, dy: number, image: Size, box: Size): View {
  return clampPan({ scale: view.scale, x: view.x + dx, y: view.y + dy }, image, box);
}
