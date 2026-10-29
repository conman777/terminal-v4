import { describe, expect, it } from 'vitest';
import { normalizePreviewElement } from './previewElement';

describe('normalizePreviewElement', () => {
  it('preserves serialized selection and style identity while exposing control bytes as plain text', () => {
    expect(normalizePreviewElement({
      selector: '#fixture\nmarker\r\u001b\u2028', elementId: 'fixture-element', tagName: 'button',
      rect: { x: 2, y: 3, width: 20, height: 10 },
      attributes: { title: 'safe\ttext' }, computedStyle: { display: 'flex' },
      parentChain: [{ selector: 'body', tagName: 'body' }],
      react: { componentName: 'Fixture', props: { enabled: true, count: 2 } },
      parentElement: { selector: '#ignored' },
    })).toEqual({
      selector: '#fixture\\u000amarker\\u000d\\u001b\\u2028', elementId: 'fixture-element', tagName: 'button',
      id: '', className: '', fullSelector: '', outerHTML: '', textContent: '',
      rect: { x: 2, y: 3, width: 20, height: 10 },
      attributes: { title: 'safe\\u0009text' }, computedStyle: { display: 'flex' }, extendedStyles: {},
      parentChain: [{ selector: 'body', tagName: 'body', id: '', className: '' }],
      react: { componentName: 'Fixture', filePath: '', props: { enabled: 'true', count: '2' } },
    });
  });

  it.each([
    null, [], {}, { selector: { object: 'value' } }, { selector: 'x'.repeat(5001) },
    { selector: '#fixture', rect: { width: Infinity } },
    { selector: '#fixture', attributes: { nested: { unsafe: 'object' } } },
    { selector: '#fixture', computedStyle: ['flex'] },
    { selector: '#fixture', parentChain: new Array(11).fill({ selector: 'body' }) },
    { selector: '#fixture', react: { props: { nested: {} } } },
    { selector: '#fixture', attributes: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [index, 'value'])) },
    { selector: '#fixture', attributes: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [index, 'x'.repeat(1000)])) },
  ])('rejects malformed or excessive metadata: %j', value => {
    expect(normalizePreviewElement(value)).toBeNull();
  });
});
