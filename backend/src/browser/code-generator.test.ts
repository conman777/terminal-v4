/**
 * Code Generator Tests
 *
 * Tests for generating Playwright, Puppeteer, and Selenium test code.
 */

import { describe, test, expect } from 'vitest';
import { generateCode } from './code-generator.js';
import type { RecordedAction } from './automation-types.js';

describe('generateCode', () => {
  describe('Playwright code generation', () => {
    test('generates code for navigation', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'navigation',
          timestamp: Date.now(),
          url: 'https://example.com'
        }
      ];

      const result = generateCode(actions, {
        framework: 'playwright',
        language: 'javascript',
        testFramework: 'none'
      });

      expect(result.code).toContain("import { chromium } from 'playwright'");
      expect(result.code).toContain("await page.goto('https://example.com')");
      expect(result.framework).toBe('playwright');
      expect(result.language).toBe('javascript');
    });

    test('generates code for click action', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'click',
          timestamp: Date.now(),
          selector: '#submit-button'
        }
      ];

      const result = generateCode(actions, {
        framework: 'playwright',
        language: 'javascript',
        testFramework: 'none'
      });

      expect(result.code).toContain("await page.click('#submit-button')");
    });

    test('generates code for fill action', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'fill',
          timestamp: Date.now(),
          selector: '#email',
          value: 'test@example.com'
        }
      ];

      const result = generateCode(actions, {
        framework: 'playwright',
        language: 'javascript',
        testFramework: 'none'
      });

      expect(result.code).toContain("await page.fill('#email', 'test@example.com')");
    });

    test('generates code with Jest test framework', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'navigation',
          timestamp: Date.now(),
          url: 'https://example.com'
        }
      ];

      const result = generateCode(actions, {
        framework: 'playwright',
        language: 'javascript',
        testFramework: 'jest'
      });

      expect(result.code).toContain("describe('Recorded Test'");
      expect(result.code).toContain("test('recorded actions'");
      expect(result.code).toContain('beforeAll');
      expect(result.code).toContain('afterAll');
    });

    test('generates TypeScript code', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'navigation',
          timestamp: Date.now(),
          url: 'https://example.com'
        }
      ];

      const result = generateCode(actions, {
        framework: 'playwright',
        language: 'typescript',
        testFramework: 'jest'
      });

      expect(result.code).toContain('Browser, Page');
      expect(result.code).toContain('let browser: Browser');
      expect(result.code).toContain('let page: Page');
      expect(result.language).toBe('typescript');
    });

    test('generates code for assertions', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'assertion',
          timestamp: Date.now(),
          assertionType: 'visible',
          selector: '#success-message'
        },
        {
          id: '2',
          type: 'assertion',
          timestamp: Date.now(),
          assertionType: 'text',
          selector: '#title',
          expected: 'Welcome'
        }
      ];

      const result = generateCode(actions, {
        framework: 'playwright',
        language: 'javascript',
        testFramework: 'none'
      });

      expect(result.code).toContain("toBeVisible()");
      expect(result.code).toContain("toHaveText('Welcome')");
    });

    test('generates code for wait actions', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'wait',
          timestamp: Date.now(),
          waitType: 'selector',
          selector: '#loading',
          waitState: 'hidden'
        }
      ];

      const result = generateCode(actions, {
        framework: 'playwright',
        language: 'javascript',
        testFramework: 'none'
      });

      expect(result.code).toContain("await page.waitForSelector('#loading'");
      expect(result.code).toContain("state: 'hidden'");
    });
  });

  describe('Puppeteer code generation', () => {
    test('generates Puppeteer code for navigation', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'navigation',
          timestamp: Date.now(),
          url: 'https://example.com'
        }
      ];

      const result = generateCode(actions, {
        framework: 'puppeteer',
        language: 'javascript',
        testFramework: 'none'
      });

      expect(result.code).toContain("const puppeteer = require('puppeteer')");
      expect(result.code).toContain("await page.goto('https://example.com')");
      expect(result.framework).toBe('puppeteer');
    });

    test('generates Puppeteer code for interactions', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'click',
          timestamp: Date.now(),
          selector: 'button'
        },
        {
          id: '2',
          type: 'type',
          timestamp: Date.now(),
          selector: 'input',
          text: 'hello'
        }
      ];

      const result = generateCode(actions, {
        framework: 'puppeteer',
        language: 'javascript',
        testFramework: 'none'
      });

      expect(result.code).toContain("await page.click('button')");
      expect(result.code).toContain("await page.type('input', 'hello')");
    });
  });

  describe('Selenium code generation', () => {
    test('generates Selenium JavaScript code', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'navigation',
          timestamp: Date.now(),
          url: 'https://example.com'
        }
      ];

      const result = generateCode(actions, {
        framework: 'selenium',
        language: 'javascript',
        testFramework: 'none'
      });

      expect(result.code).toContain("const { Builder, By, until } = require('selenium-webdriver')");
      expect(result.code).toContain("await driver.get('https://example.com')");
      expect(result.framework).toBe('selenium');
    });

    test('generates Selenium Python code', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'navigation',
          timestamp: Date.now(),
          url: 'https://example.com'
        },
        {
          id: '2',
          type: 'click',
          timestamp: Date.now(),
          selector: '#button'
        }
      ];

      const result = generateCode(actions, {
        framework: 'selenium',
        language: 'python',
        testFramework: 'none'
      });

      expect(result.code).toContain('from selenium import webdriver');
      expect(result.code).toContain('driver.get("https://example.com")');
      expect(result.code).toContain('driver.find_element');
      expect(result.language).toBe('python');
    });

    test('generates Selenium Python code with pytest', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'navigation',
          timestamp: Date.now(),
          url: 'https://example.com'
        }
      ];

      const result = generateCode(actions, {
        framework: 'selenium',
        language: 'python',
        testFramework: 'pytest'
      });

      expect(result.code).toContain('import pytest');
      expect(result.code).toContain('@pytest.fixture');
      expect(result.code).toContain('def test_recorded_actions');
    });
  });

  describe('Complex workflows', () => {
    test('generates code for complete user flow', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'navigation',
          timestamp: Date.now(),
          url: 'https://example.com/login'
        },
        {
          id: '2',
          type: 'fill',
          timestamp: Date.now(),
          selector: '#username',
          value: 'testuser'
        },
        {
          id: '3',
          type: 'fill',
          timestamp: Date.now(),
          selector: '#password',
          value: 'testpass'
        },
        {
          id: '4',
          type: 'click',
          timestamp: Date.now(),
          selector: '#login-button'
        },
        {
          id: '5',
          type: 'wait',
          timestamp: Date.now(),
          waitType: 'navigation'
        },
        {
          id: '6',
          type: 'assertion',
          timestamp: Date.now(),
          assertionType: 'visible',
          selector: '#dashboard'
        }
      ];

      const result = generateCode(actions, {
        framework: 'playwright',
        language: 'javascript',
        testFramework: 'jest',
        includeComments: true
      });

      expect(result.code).toContain('navigation');
      expect(result.code).toContain('fill');
      expect(result.code).toContain('click');
      expect(result.code).toContain('wait');
      expect(result.code).toContain('assertion');
    });

    test('escapes special characters in strings', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'fill',
          timestamp: Date.now(),
          selector: '#input',
          value: "test'value\"with'quotes"
        }
      ];

      const result = generateCode(actions, {
        framework: 'playwright',
        language: 'javascript',
        testFramework: 'none'
      });

      // Should escape quotes
      expect(result.code).toContain("\\'");
    });
  });

  describe('Error handling', () => {
    test('throws error for unsupported framework', () => {
      const actions: RecordedAction[] = [
        {
          id: '1',
          type: 'navigation',
          timestamp: Date.now(),
          url: 'https://example.com'
        }
      ];

      expect(() => {
        generateCode(actions, {
          framework: 'unsupported' as any,
          language: 'javascript'
        });
      }).toThrow('Unsupported framework');
    });
  });

  describe('Security - Code Injection Prevention', () => {
    describe('Playwright', () => {
      test('prevents code injection via malicious selectors', () => {
        const maliciousActions: RecordedAction[] = [{
          id: '1',
          type: 'click',
          selector: "'; require('fs').rmSync('/'); //",
          timestamp: Date.now()
        }];

        const result = generateCode(maliciousActions, {
          framework: 'playwright',
          language: 'javascript'
        });

        // Verify injection attempt is neutralized - quotes should be escaped
        expect(result.code).toContain("\\'");
        // The selector should be properly escaped within the string
        expect(result.code).toContain("page.click(");
      });

      test('prevents template literal injection in values', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'fill',
          selector: '#input',
          value: 'test${process.exit(1)}',
          timestamp: Date.now()
        }];

        const result = generateCode(actions, {
          framework: 'playwright',
          language: 'javascript'
        });

        // Dollar signs should be escaped
        expect(result.code).toContain('\\$');
      });

      test('prevents backtick injection', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'fill',
          selector: '#input',
          value: 'test`+ alert(1) +`more',
          timestamp: Date.now()
        }];

        const result = generateCode(actions, {
          framework: 'playwright',
          language: 'javascript'
        });

        // Backticks should be escaped
        expect(result.code).toContain('\\`');
      });

      test('prevents statement terminator injection in selectors', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'click',
          selector: '#button; console.log("pwned"); //',
          timestamp: Date.now()
        }];

        const result = generateCode(actions, {
          framework: 'playwright',
          language: 'javascript'
        });

        // Semicolons should be stripped from selectors
        expect(result.code).not.toContain('; console');
      });

      test('escapes newlines and special chars in text values', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'fill',
          selector: '#input',
          value: 'line1\nline2\r\nline3\ttab\0null',
          timestamp: Date.now()
        }];

        const result = generateCode(actions, {
          framework: 'playwright',
          language: 'javascript'
        });

        expect(result.code).toContain('\\n');
        expect(result.code).toContain('\\r');
        expect(result.code).toContain('\\t');
        expect(result.code).toContain('\\0');
      });

      test('validates URLs and rejects javascript: protocol', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'navigation',
          url: 'javascript:alert(1)',
          timestamp: Date.now()
        }];

        expect(() => {
          generateCode(actions, {
            framework: 'playwright',
            language: 'javascript'
          });
        }).toThrow('Invalid URL');
      });

      test('validates URLs and rejects data: protocol', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'navigation',
          url: 'data:text/html,<script>alert(1)</script>',
          timestamp: Date.now()
        }];

        expect(() => {
          generateCode(actions, {
            framework: 'playwright',
            language: 'javascript'
          });
        }).toThrow('Invalid URL');
      });

      test('allows valid https URLs', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'navigation',
          url: 'https://example.com/path?query=value',
          timestamp: Date.now()
        }];

        const result = generateCode(actions, {
          framework: 'playwright',
          language: 'javascript'
        });

        expect(result.code).toContain('https://example.com/path?query=value');
      });
    });

    describe('Puppeteer', () => {
      test('prevents code injection via malicious selectors', () => {
        const maliciousActions: RecordedAction[] = [{
          id: '1',
          type: 'click',
          selector: "'; eval('malicious code'); //",
          timestamp: Date.now()
        }];

        const result = generateCode(maliciousActions, {
          framework: 'puppeteer',
          language: 'javascript'
        });

        // Quotes should be escaped
        expect(result.code).toContain("\\'");
        // Verify code is syntactically valid
        expect(() => new Function(result.code)).not.toThrow();
      });

      test('prevents template literal injection in values', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'fill',
          selector: '#input',
          value: '${1+1}',
          timestamp: Date.now()
        }];

        const result = generateCode(actions, {
          framework: 'puppeteer',
          language: 'javascript'
        });

        expect(result.code).toContain('\\$');
      });

      test('validates URLs', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'navigation',
          url: 'javascript:void(0)',
          timestamp: Date.now()
        }];

        expect(() => {
          generateCode(actions, {
            framework: 'puppeteer',
            language: 'javascript'
          });
        }).toThrow('Invalid URL');
      });
    });

    describe('Selenium JavaScript', () => {
      test('prevents code injection via malicious selectors', () => {
        const maliciousActions: RecordedAction[] = [{
          id: '1',
          type: 'click',
          selector: '#test; DROP TABLE users; --',
          timestamp: Date.now()
        }];

        const result = generateCode(maliciousActions, {
          framework: 'selenium',
          language: 'javascript'
        });

        // Semicolons should be stripped from selectors
        expect(result.code).not.toContain('; DROP');
        // Verify code is syntactically valid
        expect(() => new Function(result.code)).not.toThrow();
      });

      test('escapes values in select options', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'select',
          selector: '#dropdown',
          value: "test'; alert(1); '",
          timestamp: Date.now()
        }];

        const result = generateCode(actions, {
          framework: 'selenium',
          language: 'javascript'
        });

        // Quotes should be escaped
        expect(result.code).toContain("\\'");
      });

      test('validates URLs', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'navigation',
          url: 'file:///etc/passwd',
          timestamp: Date.now()
        }];

        expect(() => {
          generateCode(actions, {
            framework: 'selenium',
            language: 'javascript'
          });
        }).toThrow('Invalid URL');
      });
    });

    describe('Selenium Python', () => {
      test('prevents code injection via malicious values', () => {
        const maliciousActions: RecordedAction[] = [{
          id: '1',
          type: 'fill',
          selector: '#input',
          value: '"; import os; os.system("rm -rf /"); "',
          timestamp: Date.now()
        }];

        const result = generateCode(maliciousActions, {
          framework: 'selenium',
          language: 'python'
        });

        // Quotes should be escaped
        expect(result.code).toContain('\\"');
        // The generated code should be syntactically valid Python
        expect(result.code).toContain('send_keys');
      });

      test('validates URLs', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'navigation',
          url: 'javascript:alert(1)',
          timestamp: Date.now()
        }];

        expect(() => {
          generateCode(actions, {
            framework: 'selenium',
            language: 'python'
          });
        }).toThrow('Invalid URL');
      });
    });

    describe('Complex injection scenarios', () => {
      test('prevents multi-stage injection attempts', () => {
        const actions: RecordedAction[] = [
          {
            id: '1',
            type: 'navigation',
            url: 'https://example.com',
            timestamp: Date.now()
          },
          {
            id: '2',
            type: 'fill',
            selector: '#username',
            value: 'admin\'); DROP TABLE users; --',
            timestamp: Date.now()
          },
          {
            id: '3',
            type: 'click',
            selector: "'; require('child_process').exec('malicious'); //",
            timestamp: Date.now()
          }
        ];

        const result = generateCode(actions, {
          framework: 'playwright',
          language: 'javascript'
        });

        // All quotes should be escaped
        expect(result.code).toContain("\\'");
        // Should contain all three actions
        expect(result.code).toContain('page.goto');
        expect(result.code).toContain('page.fill');
        expect(result.code).toContain('page.click');
      });

      test('prevents injection in assertion expected values', () => {
        const actions: RecordedAction[] = [{
          id: '1',
          type: 'assertion',
          assertionType: 'text',
          selector: '#result',
          expected: "test'); console.log('pwned'); ('",
          timestamp: Date.now()
        }];

        const result = generateCode(actions, {
          framework: 'playwright',
          language: 'javascript'
        });

        expect(result.code).not.toContain("console.log('pwned')");
        expect(result.code).toContain("\\'");
      });
    });
  });
});
