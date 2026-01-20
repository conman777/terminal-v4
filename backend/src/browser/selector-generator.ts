/**
 * Selector Generator Service
 *
 * Generates stable, reliable selectors for web elements.
 * Priority: data-testid > id > aria-label > text > css > xpath
 */

import type { Page, Locator } from 'playwright';
import type { SelectorStrategy, ElementContext } from './automation-types.js';

/**
 * Generate the best selector for an element
 */
export async function generateSelector(
  page: Page,
  elementHandle: any
): Promise<string> {
  const strategies = await generateSelectorStrategies(page, elementHandle);

  // Return the highest priority strategy
  if (strategies.length === 0) {
    throw new Error('Could not generate selector for element');
  }

  return strategies[0].selector;
}

/**
 * Generate all possible selector strategies for an element
 */
export async function generateSelectorStrategies(
  page: Page,
  elementHandle: any
): Promise<SelectorStrategy[]> {
  const strategies: SelectorStrategy[] = [];

  // Get element context
  const context = await getElementContext(page, elementHandle);

  // Strategy 1: data-testid (highest priority)
  if (context.attributes?.['data-testid']) {
    strategies.push({
      type: 'data-testid',
      selector: `[data-testid="${context.attributes['data-testid']}"]`,
      priority: 100
    });
  }

  // Strategy 2: id
  if (context.id) {
    strategies.push({
      type: 'id',
      selector: `#${context.id}`,
      priority: 90
    });
  }

  // Strategy 3: aria-label
  if (context.attributes?.['aria-label']) {
    strategies.push({
      type: 'aria-label',
      selector: `[aria-label="${context.attributes['aria-label']}"]`,
      priority: 80
    });
  }

  // Strategy 4: text content (for buttons, links, etc.)
  if (context.text && context.text.length < 50 && isInteractiveElement(context.tag)) {
    const escapedText = context.text.replace(/"/g, '\\"');
    strategies.push({
      type: 'text',
      selector: `${context.tag}:has-text("${escapedText}")`,
      priority: 70
    });
  }

  // Strategy 5: CSS selector with stable classes
  const cssSelector = generateCssSelector(context);
  if (cssSelector) {
    strategies.push({
      type: 'css',
      selector: cssSelector,
      priority: 60
    });
  }

  // Strategy 6: XPath (last resort)
  const xpath = await generateXPath(page, elementHandle);
  if (xpath) {
    strategies.push({
      type: 'xpath',
      selector: xpath,
      priority: 10
    });
  }

  // Sort by priority (descending)
  strategies.sort((a, b) => b.priority - a.priority);

  // Validate selectors - ensure they uniquely identify the element
  const validStrategies: SelectorStrategy[] = [];
  for (const strategy of strategies) {
    try {
      const locator = page.locator(strategy.selector);
      const count = await locator.count();
      if (count === 1) {
        validStrategies.push(strategy);
      } else if (count > 1 && strategy.type === 'css') {
        // Try adding :first or :nth-child
        const indexedSelector = `${strategy.selector}:first`;
        const indexedCount = await page.locator(indexedSelector).count();
        if (indexedCount === 1) {
          validStrategies.push({
            ...strategy,
            selector: indexedSelector
          });
        }
      }
    } catch (err) {
      // Invalid selector, skip
      continue;
    }
  }

  return validStrategies;
}

/**
 * Get element context information
 */
async function getElementContext(
  page: Page,
  elementHandle: any
): Promise<ElementContext> {
  const context = await page.evaluate((el: any) => {
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: Array.from(el.classList),
      text: el.innerText?.slice(0, 200) || '',
      attributes: Array.from(el.attributes).reduce((acc: any, attr: any) => {
        acc[attr.name] = attr.value;
        return acc;
      }, {} as Record<string, string>)
    };
  }, elementHandle);

  return context;
}

/**
 * Check if element is interactive
 */
function isInteractiveElement(tag: string): boolean {
  return ['button', 'a', 'input', 'select', 'textarea', 'label'].includes(tag);
}

/**
 * Generate CSS selector from element context
 */
function generateCssSelector(context: ElementContext): string | null {
  // Filter out dynamic/unstable classes
  const stableClasses = context.classes?.filter(cls =>
    !isDynamicClass(cls)
  ) || [];

  if (stableClasses.length === 0 && !context.id) {
    return null;
  }

  let selector = context.tag;

  if (context.id) {
    selector += `#${context.id}`;
  } else if (stableClasses.length > 0) {
    // Use up to 2 most specific classes
    selector += stableClasses.slice(0, 2).map(cls => `.${cls}`).join('');
  }

  return selector;
}

/**
 * Check if a class name is likely dynamic
 */
function isDynamicClass(className: string): boolean {
  // Classes that look like: css-1x2y3z, _1a2b3c, emotion-hash, etc.
  return /^(css-|_)[a-z0-9]+$/i.test(className) ||
    /^[a-z]+-[0-9a-f]{5,}$/i.test(className) ||
    className.startsWith('emotion-') ||
    className.startsWith('makeStyles-');
}

/**
 * Generate XPath for element (fallback)
 */
async function generateXPath(page: Page, elementHandle: any): Promise<string | null> {
  try {
    const xpath = await page.evaluate((el: any) => {
      const getPathTo = (element: any): string => {
        if (element.id !== '') {
          return `//*[@id="${element.id}"]`;
        }
        if (element === document.body) {
          return '/html/body';
        }

        let ix = 0;
        const siblings = element.parentNode?.childNodes || [];
        for (let i = 0; i < siblings.length; i++) {
          const sibling = siblings[i];
          if (sibling === element) {
            return `${getPathTo(element.parentNode)}/${element.tagName.toLowerCase()}[${ix + 1}]`;
          }
          if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
            ix++;
          }
        }
        return '';
      };
      return getPathTo(el);
    }, elementHandle);

    return xpath;
  } catch (err) {
    return null;
  }
}

/**
 * Validate selector uniquely identifies an element
 */
export async function validateSelector(
  page: Page,
  selector: string
): Promise<{ valid: boolean; count: number; error?: string }> {
  try {
    const locator = page.locator(selector);
    const count = await locator.count();

    return {
      valid: count === 1,
      count
    };
  } catch (err: any) {
    return {
      valid: false,
      count: 0,
      error: err.message
    };
  }
}
