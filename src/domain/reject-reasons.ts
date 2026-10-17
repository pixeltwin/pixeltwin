import { REJECT_REASONS, type RejectReason } from '../db/schema';

// What each rejection category means and what to do about it: the chips of the reject popover, the
// review history's tag, and the hints agents and the SDKs get from a screen's rejections.

export interface RejectReasonInfo {
  code: RejectReason;
  /** A chip's label. */
  label: string;
  /** What the category means, as a tooltip or a line for agents. */
  meaning: string;
  /** What to do about it in the test code (agents, SDK tips). */
  advice: string;
}

export const REJECT_REASON_INFO: Record<RejectReason, RejectReasonInfo> = {
  not_loaded: {
    code: 'not_loaded',
    label: 'Not loaded',
    meaning: 'The page or its content had not finished loading',
    advice:
      'likely captured before the page finished loading — wait for network idle or for the element before the screenshot',
  },
  late_asset: {
    code: 'late_asset',
    label: 'Late asset',
    meaning: 'An image, banner, font or ad loaded late',
    advice:
      'an image, banner, font or ad arrived after the screenshot — wait for it (images complete, document.fonts.ready) or ignore its area',
  },
  animation: {
    code: 'animation',
    label: 'Animation',
    meaning: 'Caught mid-animation or transition',
    advice: 'caught mid-animation — disable animations and transitions for the screenshot, or use retakes',
  },
  dynamic_data: {
    code: 'dynamic_data',
    label: 'Dynamic data',
    meaning: 'Dates, prices or random content',
    advice: 'content changes from run to run — fix the data in the test (clock, seed, mocks) or ignore that area',
  },
  environment: {
    code: 'environment',
    label: 'Environment',
    meaning: 'A browser, OS, rendering or viewport difference',
    advice: 'renders differently between environments — take the screenshots in one pinned browser, OS and viewport',
  },
  real_bug: {
    code: 'real_bug',
    label: 'Real bug',
    meaning: 'A real regression',
    advice: 'a real regression was caught here — fix the code; do not approve a change like it',
  },
  other: {
    code: 'other',
    label: 'Other',
    meaning: 'Something else: see the comment',
    advice: 'read the comments for why',
  },
};

/** In chip order (number keys 1–7). */
export const REJECT_REASON_LIST: RejectReasonInfo[] = REJECT_REASONS.map((code) => REJECT_REASON_INFO[code]);

/** Rejections that say the screenshot was taken too early: the change is a loading artefact. */
export const TOO_EARLY: readonly RejectReason[] = ['not_loaded', 'late_asset'];

/** Rejections that say the change is noise, not a regression (flaky screens). */
export const NOISE: readonly RejectReason[] = ['not_loaded', 'late_asset', 'animation', 'dynamic_data'];

export function reasonLabel(code: RejectReason | null | undefined): string | null {
  return code ? REJECT_REASON_INFO[code].label : null;
}
