// Why a check was rejected, as the server's stable codes (GET /projects/{slug}/rejections), with
// what each means and what to do about it in the test: for agents (MCP) and the end-of-run tips.

export const REJECT_REASONS = [
  'not_loaded',
  'late_asset',
  'animation',
  'dynamic_data',
  'environment',
  'real_bug',
  'other',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const REJECT_REASON_INFO: Record<RejectReason, { meaning: string; act: string }> = {
  not_loaded: {
    meaning: 'captured before the page or its content finished loading',
    act: 'wait for network idle or for the element before the screenshot',
  },
  late_asset: {
    meaning: 'an image, banner, font or ad loaded late',
    act: 'wait for it (images complete, document.fonts.ready) or ignore its area',
  },
  animation: {
    meaning: 'caught mid-animation or transition',
    act: 'disable animations and transitions for the screenshot, or use retakes',
  },
  dynamic_data: {
    meaning: 'dates, prices or random content',
    act: 'fix the data in the test (clock, seed, mocks) or add an ignore area',
  },
  environment: {
    meaning: 'a browser, OS, rendering or viewport difference',
    act: 'take the screenshots in one pinned browser, OS and viewport',
  },
  real_bug: { meaning: 'a real regression', act: 'fix the code; do not approve a change like it' },
  other: { meaning: 'something else', act: 'read the comments' },
};

/** Rejections that say the screenshot was taken too early. */
export const TOO_EARLY: readonly RejectReason[] = ['not_loaded', 'late_asset'];

export function isRejectReason(value: unknown): value is RejectReason {
  return typeof value === 'string' && (REJECT_REASONS as readonly string[]).includes(value);
}
