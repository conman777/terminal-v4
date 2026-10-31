import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/components/DesktopConversationView.css', 'utf8');
const rule = css.split('}').find(block => /\.desktop-pending-requests\s+\.agent-question-actions\s*\{?/.test(block)) || '';

describe('pending question actions in a short viewport', () => {
  it('keeps Send answers pinned inside the scrolling pending-requests region like approval actions', () => {
    expect([/position:\s*sticky/.test(rule), /bottom:\s*0/.test(rule), /background:/.test(rule)]).toEqual([true, true, true]);
  });
});
