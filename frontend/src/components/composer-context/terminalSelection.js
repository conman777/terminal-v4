import { getComposerDraftStore } from '../../utils/composerDraftStore';
import { addContext, buildTerminalContext } from './composerContext';

export function addTerminalSelectionToDraft(sessionId, text, label) {
  const chip = buildTerminalContext({ text, label });
  if (!chip || !sessionId) return false;
  getComposerDraftStore(sessionId).setText(current => addContext(current, chip));
  return true;
}
