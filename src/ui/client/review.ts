// The focus-mode island (UI spec §5): the compare viewer for the check on the page.
import { mountViewer } from './viewer.ts';

export function init(): void {
  const root = document.getElementById('review');
  if (root) mountViewer(root);
}
