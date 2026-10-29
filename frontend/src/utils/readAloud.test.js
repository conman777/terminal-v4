import { afterEach, describe, expect, it, vi } from 'vitest';
import { canReadAloud, readAloud, speakableText } from './readAloud';

afterEach(() => { delete window.speechSynthesis; delete window.SpeechSynthesisUtterance; });

describe('read aloud', () => {
  it('speaks the reply without markdown symbols or code blocks', () => {
    const spoken = [];
    window.speechSynthesis = { cancel: vi.fn(), speak: utterance => spoken.push(utterance.text) };
    window.SpeechSynthesisUtterance = function Utterance(text) { this.text = text; };
    readAloud('## Done\n\nI fixed **login** in `auth.js`.\n\n```js\nconst x = 1;\n```\n- [docs](https://x.test)');
    expect([canReadAloud(), spoken, speakableText('plain')]).toEqual([true, ['Done I fixed login in auth.js. (code omitted) docs'], 'plain']);
  });
});
