/**
 * Code Generator Service
 *
 * Generates Playwright, Puppeteer, and Selenium test code from recorded actions.
 */

import type {
  RecordedAction,
  CodeGenerationOptions,
  GeneratedCode,
  CodeFramework
} from './automation-types.js';

/**
 * Generate test code from recorded actions
 */
export function generateCode(
  actions: RecordedAction[],
  options: CodeGenerationOptions
): GeneratedCode {
  const { framework, language = 'javascript', testFramework = 'none', includeComments = true } = options;

  switch (framework) {
    case 'playwright':
      return generatePlaywrightCode(actions, { language, testFramework, includeComments });
    case 'puppeteer':
      return generatePuppeteerCode(actions, { language, testFramework, includeComments });
    case 'selenium':
      return generateSeleniumCode(actions, { language, testFramework, includeComments });
    default:
      throw new Error(`Unsupported framework: ${framework}`);
  }
}

// ============ PLAYWRIGHT ============

function generatePlaywrightCode(
  actions: RecordedAction[],
  options: Omit<CodeGenerationOptions, 'framework'>
): GeneratedCode {
  const { language, testFramework, includeComments } = options;
  const isTypescript = language === 'typescript';
  const lines: string[] = [];

  // Imports
  if (testFramework === 'jest') {
    lines.push(`import { chromium${isTypescript ? ', Browser, Page' : ''} } from 'playwright';`);
    lines.push('');
  } else if (testFramework === 'mocha') {
    lines.push(`const { chromium } = require('playwright');`);
    lines.push('');
  } else {
    lines.push(`import { chromium } from 'playwright';`);
    lines.push('');
  }

  // Test wrapper
  if (testFramework === 'jest' || testFramework === 'mocha') {
    lines.push(`describe('Recorded Test', () => {`);
    if (isTypescript) {
      lines.push(`  let browser: Browser;`);
      lines.push(`  let page: Page;`);
    } else {
      lines.push(`  let browser;`);
      lines.push(`  let page;`);
    }
    lines.push('');
    lines.push(`  beforeAll(async () => {`);
    lines.push(`    browser = await chromium.launch();`);
    lines.push(`    page = await browser.newPage();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  afterAll(async () => {`);
    lines.push(`    await browser.close();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  test('recorded actions', async () => {`);
  } else {
    lines.push(`(async () => {`);
    lines.push(`  const browser = await chromium.launch();`);
    lines.push(`  const page = await browser.newPage();`);
    lines.push('');
  }

  // Generate action code
  const indent = testFramework !== 'none' ? '    ' : '  ';
  for (const action of actions) {
    const code = generatePlaywrightAction(action, includeComments);
    lines.push(indent + code.join(`\n${indent}`));
  }

  // Close wrapper
  if (testFramework === 'jest' || testFramework === 'mocha') {
    lines.push(`  });`);
    lines.push(`});`);
  } else {
    lines.push('');
    lines.push(`  await browser.close();`);
    lines.push(`})();`);
  }

  return {
    code: lines.join('\n'),
    framework: 'playwright',
    language: language || 'javascript'
  };
}

function generatePlaywrightAction(action: RecordedAction, includeComments: boolean): string[] {
  const lines: string[] = [];

  if (includeComments) {
    lines.push(`// ${action.type}`);
  }

  switch (action.type) {
    case 'navigation':
      if (action.url && !isValidUrl(action.url)) {
        throw new Error(`Invalid URL: ${action.url}`);
      }
      lines.push(`await page.goto('${escapeString(action.url)}');`);
      break;

    case 'click':
      lines.push(`await page.click('${escapeSelector(action.selector)}');`);
      break;

    case 'type':
      lines.push(`await page.type('${escapeSelector(action.selector)}', '${escapeString(action.text || '')}');`);
      break;

    case 'fill':
      lines.push(`await page.fill('${escapeSelector(action.selector)}', '${escapeString(action.value as string || '')}');`);
      break;

    case 'select':
      if (Array.isArray(action.value)) {
        lines.push(`await page.selectOption('${escapeSelector(action.selector)}', [${action.value.map(v => `'${escapeString(String(v))}'`).join(', ')}]);`);
      } else {
        lines.push(`await page.selectOption('${escapeSelector(action.selector)}', '${escapeString(String(action.value))}');`);
      }
      break;

    case 'scroll':
      if (action.selector) {
        lines.push(`await page.locator('${escapeSelector(action.selector)}').scrollIntoViewIfNeeded();`);
      } else {
        lines.push(`await page.evaluate(() => window.scrollBy(${action.x || 0}, ${action.y || 0}));`);
      }
      break;

    case 'hover':
      lines.push(`await page.hover('${escapeSelector(action.selector)}');`);
      break;

    case 'wait':
      if (action.waitType === 'selector') {
        lines.push(`await page.waitForSelector('${escapeSelector(action.selector)}', { state: '${action.waitState || 'visible'}' });`);
      } else if (action.waitType === 'navigation') {
        lines.push(`await page.waitForNavigation();`);
      } else if (action.waitType === 'timeout') {
        lines.push(`await page.waitForTimeout(${action.timeout || 1000});`);
      }
      break;

    case 'assertion':
      if (action.assertionType === 'visible') {
        lines.push(`await expect(page.locator('${escapeSelector(action.selector)}')).toBeVisible();`);
      } else if (action.assertionType === 'hidden') {
        lines.push(`await expect(page.locator('${escapeSelector(action.selector)}')).toBeHidden();`);
      } else if (action.assertionType === 'text') {
        lines.push(`await expect(page.locator('${escapeSelector(action.selector)}')).toHaveText('${escapeString(action.expected)}');`);
      } else if (action.assertionType === 'value') {
        lines.push(`await expect(page.locator('${escapeSelector(action.selector)}')).toHaveValue('${escapeString(action.expected)}');`);
      } else if (action.assertionType === 'count') {
        lines.push(`await expect(page.locator('${escapeSelector(action.selector)}')).toHaveCount(${action.expected});`);
      }
      break;
  }

  return lines;
}

// ============ PUPPETEER ============

function generatePuppeteerCode(
  actions: RecordedAction[],
  options: Omit<CodeGenerationOptions, 'framework'>
): GeneratedCode {
  const { language, testFramework, includeComments } = options;
  const lines: string[] = [];

  // Imports
  lines.push(`const puppeteer = require('puppeteer');`);
  lines.push('');

  // Test wrapper
  if (testFramework === 'jest' || testFramework === 'mocha') {
    lines.push(`describe('Recorded Test', () => {`);
    lines.push(`  let browser;`);
    lines.push(`  let page;`);
    lines.push('');
    lines.push(`  beforeAll(async () => {`);
    lines.push(`    browser = await puppeteer.launch();`);
    lines.push(`    page = await browser.newPage();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  afterAll(async () => {`);
    lines.push(`    await browser.close();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  test('recorded actions', async () => {`);
  } else {
    lines.push(`(async () => {`);
    lines.push(`  const browser = await puppeteer.launch();`);
    lines.push(`  const page = await browser.newPage();`);
    lines.push('');
  }

  // Generate action code
  const indent = testFramework !== 'none' ? '    ' : '  ';
  for (const action of actions) {
    const code = generatePuppeteerAction(action, includeComments);
    lines.push(indent + code.join(`\n${indent}`));
  }

  // Close wrapper
  if (testFramework === 'jest' || testFramework === 'mocha') {
    lines.push(`  });`);
    lines.push(`});`);
  } else {
    lines.push('');
    lines.push(`  await browser.close();`);
    lines.push(`})();`);
  }

  return {
    code: lines.join('\n'),
    framework: 'puppeteer',
    language: language || 'javascript'
  };
}

function generatePuppeteerAction(action: RecordedAction, includeComments: boolean): string[] {
  const lines: string[] = [];

  if (includeComments) {
    lines.push(`// ${action.type}`);
  }

  switch (action.type) {
    case 'navigation':
      if (action.url && !isValidUrl(action.url)) {
        throw new Error(`Invalid URL: ${action.url}`);
      }
      lines.push(`await page.goto('${escapeString(action.url)}');`);
      break;

    case 'click':
      lines.push(`await page.click('${escapeSelector(action.selector)}');`);
      break;

    case 'type':
      lines.push(`await page.type('${escapeSelector(action.selector)}', '${escapeString(action.text || '')}');`);
      break;

    case 'fill':
      lines.push(`await page.type('${escapeSelector(action.selector)}', '${escapeString(action.value as string || '')}');`);
      break;

    case 'select':
      if (Array.isArray(action.value)) {
        lines.push(`await page.select('${escapeSelector(action.selector)}', ${action.value.map(v => `'${escapeString(String(v))}'`).join(', ')});`);
      } else {
        lines.push(`await page.select('${escapeSelector(action.selector)}', '${escapeString(String(action.value))}');`);
      }
      break;

    case 'scroll':
      if (action.selector) {
        lines.push(`await page.evaluate((sel) => document.querySelector(sel).scrollIntoView(), '${escapeSelector(action.selector)}');`);
      } else {
        lines.push(`await page.evaluate(() => window.scrollBy(${action.x || 0}, ${action.y || 0}));`);
      }
      break;

    case 'hover':
      lines.push(`await page.hover('${escapeSelector(action.selector)}');`);
      break;

    case 'wait':
      if (action.waitType === 'selector') {
        const state = action.waitState === 'hidden' ? 'hidden' : 'visible';
        lines.push(`await page.waitForSelector('${escapeSelector(action.selector)}', { ${state}: true });`);
      } else if (action.waitType === 'navigation') {
        lines.push(`await page.waitForNavigation();`);
      } else if (action.waitType === 'timeout') {
        lines.push(`await new Promise(r => setTimeout(r, ${action.timeout || 1000}));`);
      }
      break;

    case 'assertion':
      if (action.assertionType === 'visible') {
        lines.push(`const element = await page.$('${escapeSelector(action.selector)}');`);
        lines.push(`expect(element).toBeTruthy();`);
      } else if (action.assertionType === 'text') {
        lines.push(`const text = await page.$eval('${escapeSelector(action.selector)}', el => el.textContent);`);
        lines.push(`expect(text).toBe('${escapeString(action.expected)}');`);
      }
      break;
  }

  return lines;
}

// ============ SELENIUM ============

function generateSeleniumCode(
  actions: RecordedAction[],
  options: Omit<CodeGenerationOptions, 'framework'>
): GeneratedCode {
  const { language, testFramework, includeComments } = options;

  if (language === 'python') {
    return generateSeleniumPython(actions, { testFramework, includeComments });
  }

  const lines: string[] = [];

  // Imports
  lines.push(`const { Builder, By, until } = require('selenium-webdriver');`);
  lines.push('');

  // Test wrapper
  if (testFramework === 'jest' || testFramework === 'mocha') {
    lines.push(`describe('Recorded Test', () => {`);
    lines.push(`  let driver;`);
    lines.push('');
    lines.push(`  beforeAll(async () => {`);
    lines.push(`    driver = await new Builder().forBrowser('chrome').build();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  afterAll(async () => {`);
    lines.push(`    await driver.quit();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  test('recorded actions', async () => {`);
  } else {
    lines.push(`(async () => {`);
    lines.push(`  const driver = await new Builder().forBrowser('chrome').build();`);
    lines.push('');
  }

  // Generate action code
  const indent = testFramework !== 'none' ? '    ' : '  ';
  for (const action of actions) {
    const code = generateSeleniumAction(action, includeComments);
    lines.push(indent + code.join(`\n${indent}`));
  }

  // Close wrapper
  if (testFramework === 'jest' || testFramework === 'mocha') {
    lines.push(`  });`);
    lines.push(`});`);
  } else {
    lines.push('');
    lines.push(`  await driver.quit();`);
    lines.push(`})();`);
  }

  return {
    code: lines.join('\n'),
    framework: 'selenium',
    language: language || 'javascript'
  };
}

function generateSeleniumAction(action: RecordedAction, includeComments: boolean): string[] {
  const lines: string[] = [];

  if (includeComments) {
    lines.push(`// ${action.type}`);
  }

  const selector = convertSelectorToSelenium(action.selector || '');

  switch (action.type) {
    case 'navigation':
      if (action.url && !isValidUrl(action.url)) {
        throw new Error(`Invalid URL: ${action.url}`);
      }
      lines.push(`await driver.get('${escapeString(action.url)}');`);
      break;

    case 'click':
      lines.push(`await driver.findElement(${selector}).click();`);
      break;

    case 'type':
    case 'fill':
      const text = action.text || action.value as string || '';
      lines.push(`await driver.findElement(${selector}).sendKeys('${escapeString(text)}');`);
      break;

    case 'select':
      lines.push(`const select = await driver.findElement(${selector});`);
      if (Array.isArray(action.value)) {
        action.value.forEach(v => {
          lines.push(`await select.findElement(By.css(\`option[value='${escapeString(String(v))}']\`)).click();`);
        });
      } else {
        lines.push(`await select.findElement(By.css(\`option[value='${escapeString(String(action.value))}']\`)).click();`);
      }
      break;

    case 'scroll':
      if (action.selector) {
        lines.push(`const element = await driver.findElement(${selector});`);
        lines.push(`await driver.executeScript('arguments[0].scrollIntoView()', element);`);
      } else {
        lines.push(`await driver.executeScript('window.scrollBy(${action.x || 0}, ${action.y || 0})');`);
      }
      break;

    case 'hover':
      lines.push(`const element = await driver.findElement(${selector});`);
      lines.push(`await driver.actions().move({ origin: element }).perform();`);
      break;

    case 'wait':
      if (action.waitType === 'selector') {
        lines.push(`await driver.wait(until.elementLocated(${selector}), ${action.timeout || 30000});`);
      } else if (action.waitType === 'timeout') {
        lines.push(`await driver.sleep(${action.timeout || 1000});`);
      }
      break;

    case 'assertion':
      if (action.assertionType === 'visible') {
        lines.push(`const element = await driver.findElement(${selector});`);
        lines.push(`expect(await element.isDisplayed()).toBe(true);`);
      } else if (action.assertionType === 'text') {
        lines.push(`const text = await driver.findElement(${selector}).getText();`);
        lines.push(`expect(text).toBe('${escapeString(action.expected)}');`);
      }
      break;
  }

  return lines;
}

function generateSeleniumPython(
  actions: RecordedAction[],
  options: { testFramework?: string; includeComments?: boolean }
): GeneratedCode {
  const { testFramework, includeComments } = options;
  const lines: string[] = [];

  // Imports
  lines.push(`from selenium import webdriver`);
  lines.push(`from selenium.webdriver.common.by import By`);
  lines.push(`from selenium.webdriver.support.ui import WebDriverWait`);
  lines.push(`from selenium.webdriver.support import expected_conditions as EC`);
  if (testFramework === 'pytest') {
    lines.push(`import pytest`);
  }
  lines.push('');

  // Test wrapper
  if (testFramework === 'pytest') {
    lines.push(`@pytest.fixture`);
    lines.push(`def driver():`);
    lines.push(`    driver = webdriver.Chrome()`);
    lines.push(`    yield driver`);
    lines.push(`    driver.quit()`);
    lines.push('');
    lines.push(`def test_recorded_actions(driver):`);
  } else {
    lines.push(`driver = webdriver.Chrome()`);
    lines.push('');
  }

  // Generate action code
  const indent = testFramework === 'pytest' ? '    ' : '';
  for (const action of actions) {
    const code = generateSeleniumPythonAction(action, includeComments);
    lines.push(indent + code.join(`\n${indent}`));
  }

  // Close
  if (testFramework !== 'pytest') {
    lines.push('');
    lines.push(`driver.quit()`);
  }

  return {
    code: lines.join('\n'),
    framework: 'selenium',
    language: 'python'
  };
}

function generateSeleniumPythonAction(action: RecordedAction, includeComments: boolean): string[] {
  const lines: string[] = [];

  if (includeComments) {
    lines.push(`# ${action.type}`);
  }

  const selector = convertSelectorToPython(action.selector || '');

  switch (action.type) {
    case 'navigation':
      if (action.url && !isValidUrl(action.url)) {
        throw new Error(`Invalid URL: ${action.url}`);
      }
      lines.push(`driver.get("${escapeString(action.url)}")`);
      break;

    case 'click':
      lines.push(`driver.find_element(${selector}).click()`);
      break;

    case 'type':
    case 'fill':
      const text = action.text || action.value as string || '';
      lines.push(`driver.find_element(${selector}).send_keys("${escapeString(text)}")`);
      break;

    case 'wait':
      if (action.waitType === 'selector') {
        lines.push(`WebDriverWait(driver, ${(action.timeout || 30000) / 1000}).until(EC.presence_of_element_located((${selector})))`);
      } else if (action.waitType === 'timeout') {
        lines.push(`import time; time.sleep(${(action.timeout || 1000) / 1000})`);
      }
      break;
  }

  return lines;
}

// ============ HELPERS ============

/**
 * Escape all dangerous characters in strings to prevent code injection
 */
function escapeString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')     // Backslashes first
    .replace(/'/g, "\\'")       // Single quotes
    .replace(/"/g, '\\"')       // Double quotes
    .replace(/`/g, '\\`')       // Backticks
    .replace(/\$/g, '\\$')      // Dollar signs (template literals)
    .replace(/\n/g, '\\n')      // Newlines
    .replace(/\r/g, '\\r')      // Carriage returns
    .replace(/\t/g, '\\t')      // Tabs
    .replace(/\0/g, '\\0');     // Null bytes
}

/**
 * Escape CSS selectors to prevent injection
 */
function escapeSelector(selector: string): string {
  // Escape backslashes first, then quotes, then remove dangerous chars
  return selector
    .replace(/\\/g, '\\\\')     // Escape backslashes first
    .replace(/'/g, "\\'")       // Escape single quotes
    .replace(/"/g, '\\"')       // Escape double quotes
    .replace(/`/g, '\\`')       // Escape backticks
    .replace(/\$/g, '\\$')      // Escape dollar signs (template literals)
    .replace(/;/g, '')          // Remove statement terminators
    .replace(/\{/g, '')         // Remove braces
    .replace(/\}/g, '');        // Remove braces
}

/**
 * Validate URL to prevent javascript: protocol and other dangerous schemes
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Prevent javascript: protocol and other dangerous schemes
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function convertSelectorToSelenium(selector: string): string {
  if (selector.startsWith('#')) {
    return `By.id('${escapeSelector(selector.slice(1))}')`;
  } else if (selector.startsWith('.')) {
    return `By.className('${escapeSelector(selector.slice(1))}')`;
  } else if (selector.includes(':has-text')) {
    const text = selector.match(/:has-text\("(.+)"\)/)?.[1] || '';
    return `By.xpath(\`//*[contains(text(), '${escapeString(text)}')]\`)`;
  } else {
    return `By.css('${escapeSelector(selector)}')`;
  }
}

function convertSelectorToPython(selector: string): string {
  if (selector.startsWith('#')) {
    return `By.ID, "${escapeSelector(selector.slice(1))}"`;
  } else if (selector.startsWith('.')) {
    return `By.CLASS_NAME, "${escapeSelector(selector.slice(1))}"`;
  } else {
    return `By.CSS_SELECTOR, "${escapeSelector(selector)}"`;
  }
}
