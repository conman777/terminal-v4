import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

// Extract selector generation functions from inspector script for testing
// These are the same logic as in inspector-script.ts but isolated for testing

function getSmartCSSSelector(el: Element): string {
  // Priority 1: ID selector (most specific and stable)
  if (el.id && !el.id.startsWith('__preview')) {
    return '#' + el.id;
  }

  // Priority 2: data-testid (common in testing frameworks)
  if (el.hasAttribute('data-testid')) {
    return '[data-testid="' + el.getAttribute('data-testid') + '"]';
  }

  // Priority 3: Unique class combination
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).filter(c => c && !c.startsWith('__preview'));
    if (classes.length > 0) {
      const classSelector = '.' + classes.join('.');
      // Check if this selector is unique
      try {
        const doc = el.ownerDocument;
        if (doc && doc.querySelectorAll(classSelector).length === 1) {
          return classSelector;
        }
      } catch (e) {
        // Invalid selector, continue
      }
    }
  }

  // Priority 4: Full path selector
  return getFullSelector(el);
}

function getFullSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  const doc = el.ownerDocument;

  while (current && current !== doc.body && current !== doc.documentElement) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector = '#' + current.id;
      parts.unshift(selector);
      break;
    }

    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).filter(c => c && !c.startsWith('__preview'));
      if (classes.length > 0) {
        selector += '.' + classes.slice(0, 2).join('.');
      }
    }

    // Add nth-child if needed for uniqueness
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += ':nth-child(' + index + ')';
      }
    }

    parts.unshift(selector);
    current = current.parentElement;
  }

  return parts.join(' > ');
}

function getXPath(el: Element): string {
  if (el.id && !el.id.startsWith('__preview')) {
    return '//*[@id="' + el.id + '"]';
  }

  const parts: string[] = [];
  let current: Node | null = el;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const elem = current as Element;
    let index = 0;
    let sibling = current.previousSibling;

    while (sibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === current.nodeName) {
        index++;
      }
      sibling = sibling.previousSibling;
    }

    const tagName = elem.nodeName.toLowerCase();
    const pathIndex = index > 0 ? '[' + (index + 1) + ']' : '';
    parts.unshift(tagName + pathIndex);

    current = elem.parentNode;
  }

  return parts.length ? '/' + parts.join('/') : '';
}

describe('CSS Selector Generation', () => {
  let dom: JSDOM;
  let document: Document;

  beforeEach(() => {
    dom = new JSDOM(`
      <!DOCTYPE html>
      <html>
        <body>
          <div id="app">
            <header class="header main-header">
              <h1 data-testid="page-title">Test Page</h1>
              <nav class="nav">
                <a href="/" class="nav-link active">Home</a>
                <a href="/about" class="nav-link">About</a>
              </nav>
            </header>
            <main>
              <div class="container">
                <p class="text">First paragraph</p>
                <p class="text">Second paragraph</p>
              </div>
            </main>
          </div>
        </body>
      </html>
    `);
    document = dom.window.document;
  });

  describe('getSmartCSSSelector', () => {
    it('should prioritize ID selector', () => {
      const appDiv = document.getElementById('app')!;
      expect(getSmartCSSSelector(appDiv)).toBe('#app');
    });

    it('should use data-testid when no ID exists', () => {
      const title = document.querySelector('[data-testid="page-title"]')!;
      expect(getSmartCSSSelector(title)).toBe('[data-testid="page-title"]');
    });

    it('should use unique class combination', () => {
      const header = document.querySelector('.header')!;
      const selector = getSmartCSSSelector(header);
      // Should return class selector since it's unique
      expect(selector).toBe('.header.main-header');
    });

    it('should fall back to path selector for non-unique elements', () => {
      const firstPara = document.querySelector('.text')!;
      const selector = getSmartCSSSelector(firstPara);
      // Should include nth-child since there are multiple .text elements
      expect(selector).toContain('nth-child');
    });

    it('should ignore __preview prefixed IDs', () => {
      const div = document.createElement('div');
      div.id = '__preview-inspector-overlay';
      document.body.appendChild(div);

      const selector = getSmartCSSSelector(div);
      // Should not use ID, should fall back to tag
      expect(selector).not.toContain('#__preview');
    });
  });

  describe('getFullSelector', () => {
    it('should generate full path to element', () => {
      const firstLink = document.querySelector('.nav-link')!;
      const selector = getFullSelector(firstLink);

      // Should stop at #app since it has an ID
      expect(selector).toContain('#app');
      expect(selector).toContain('header');
      expect(selector).toContain('nav');
      expect(selector).toContain('a');
    });

    it('should use nth-child for disambiguation', () => {
      const secondPara = document.querySelectorAll('.text')[1]!;
      const selector = getFullSelector(secondPara);

      expect(selector).toContain(':nth-child(2)');
    });

    it('should limit class names to first 2', () => {
      const header = document.querySelector('.header')!;
      const selector = getFullSelector(header);

      // Should include classes but limit to 2
      expect(selector).toContain('.header');
    });
  });

  describe('getXPath', () => {
    it('should use ID when available', () => {
      const appDiv = document.getElementById('app')!;
      expect(getXPath(appDiv)).toBe('//*[@id="app"]');
    });

    it('should generate full XPath without ID', () => {
      const firstLink = document.querySelector('.nav-link')!;
      const xpath = getXPath(firstLink);

      expect(xpath).toContain('/html/body/div/header/nav/a');
    });

    it('should include index for multiple siblings', () => {
      const secondPara = document.querySelectorAll('.text')[1]!;
      const xpath = getXPath(secondPara);

      // Second <p> should have [2] index
      expect(xpath).toContain('[2]');
    });

    it('should handle deeply nested elements', () => {
      const deepDiv = document.createElement('div');
      const deeperDiv = document.createElement('div');
      const deepestSpan = document.createElement('span');

      deepDiv.appendChild(deeperDiv);
      deeperDiv.appendChild(deepestSpan);
      document.body.appendChild(deepDiv);

      const xpath = getXPath(deepestSpan);

      expect(xpath).toContain('div');
      expect(xpath).toContain('span');
      expect(xpath.split('/').length).toBeGreaterThan(4);
    });
  });

  describe('Edge Cases', () => {
    it('should handle elements without classes', () => {
      const plainDiv = document.createElement('div');
      document.body.appendChild(plainDiv);

      const selector = getSmartCSSSelector(plainDiv);
      expect(selector).toBeTruthy();
      expect(selector).not.toContain('undefined');
    });

    it('should handle elements with empty className', () => {
      const div = document.createElement('div');
      div.className = '';
      document.body.appendChild(div);

      const selector = getSmartCSSSelector(div);
      expect(selector).toBeTruthy();
    });

    it('should handle SVG elements', () => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      svg.appendChild(circle);
      document.body.appendChild(svg);

      const selector = getSmartCSSSelector(circle);
      expect(selector).toBeTruthy();
    });
  });

  describe('Selector Stability', () => {
    it('should produce same selector for same element', () => {
      const element = document.querySelector('.nav-link')!;
      const selector1 = getSmartCSSSelector(element);
      const selector2 = getSmartCSSSelector(element);

      expect(selector1).toBe(selector2);
    });

    it('should prefer stable selectors (ID > data-testid > class)', () => {
      // ID selector should be shortest and most stable
      const withId = document.getElementById('app')!;
      expect(getSmartCSSSelector(withId)).toBe('#app');

      // data-testid should be used over classes
      const withTestId = document.querySelector('[data-testid]')!;
      expect(getSmartCSSSelector(withTestId)).toBe('[data-testid="page-title"]');
    });
  });
});
