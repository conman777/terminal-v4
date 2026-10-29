import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const width of [320, 1280]) {
  test(`math and safe diagrams render without executing diagram content at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const session = { id: 'ss-markdown-fixture', provider: 'codex', runtime: 'codex', title: 'Markdown review', cwd: '/tmp', status: 'completed', model: 'fixture-model', createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z' };
    const requests: string[] = [];
    page.on('request', request => { if (request.url().includes('diagram-attack.invalid')) requests.push(request.url()); });
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready', models: [{ id: 'fixture-model', label: 'Fixture model', default: true }] }] } }));
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
    await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
      const content = 'Formula $E=mc^2$\n\n$$\n\\frac{1}{2}\n$$\n\n```mermaid\ngraph TD\nA[Start] --> B[Finish]\n```\n\n```mermaid\nflowchart LR\nA[Start] --> B{Ready}\nB -->|Yes| C[Finish]\nB -->|No| D[Stop]\n```\n\n```mermaid\ngraph TD\nA["<img src=https://diagram-attack.invalid/pixel>"] --> B\n```\n\n```mermaid\ngraph TD\nA -->|<img src=https://diagram-attack.invalid/edge>| B\n```\n\n```mermaid\nsequenceDiagram\nparticipant A as Client\nparticipant B as Server\nA->>B: Request\nB-->>A: Response\n```\n\n```mermaid\nsequenceDiagram\nA->>B: <img src=https://diagram-attack.invalid/sequence>\n```\n\n```mermaid\nsequenceDiagram\nA->>B: Hello\nloop Again\nB->>A: Reply\nend\n```';
      for (const event of [
        { type: 'message_completed', role: 'user', content: 'Review the result.', messageId: 'user', turnId: 'turn', seq: 1 },
        { type: 'message_completed', role: 'assistant', content, messageId: 'assistant', turnId: 'turn', seq: 2 },
        { type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 3 },
      ]) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`markdown-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.locator('.katex-mathml math')).toHaveCount(2);
    const flowchart = page.getByRole('img', { name: 'Flowchart: Start to Finish', exact: true });
    await expect(flowchart).toBeVisible();
    const decision = page.getByRole('img', { name: 'Flowchart: Start to Ready; Ready to Finish (Yes); Ready to Stop (No)', exact: true });
    await expect(decision).toBeVisible();
    await expect(page.getByRole('img', { name: /Flowchart: <img src=https:\/\/diagram-attack.invalid\/pixel> to B/ })).toBeVisible();
    await expect(page.getByRole('img', { name: /Flowchart: A to B \(<img src=https:\/\/diagram-attack.invalid\/edge>\)/ })).toBeVisible();
    const sequence = page.getByRole('img', { name: 'Sequence diagram: Client to Server: Request; Server to Client: Response', exact: true });
    await expect(sequence).toBeVisible();
    await expect(page.getByRole('img', { name: /Sequence diagram: A to B: <img src=https:\/\/diagram-attack.invalid\/sequence>/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'mermaid code' })).toHaveCount(1);
    await expect(page.locator('.lightweight-markdown iframe, .lightweight-markdown script, .lightweight-markdown img')).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await flowchart.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('math-flowchart.png') });
    await decision.scrollIntoViewIfNeeded();
    if (width === 320) {
      const scroller = decision.locator('..');
      expect(await scroller.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      await scroller.evaluate(node => { node.scrollLeft = node.scrollWidth; });
      await expect.poll(() => scroller.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    }
    await page.screenshot({ path: testInfo.outputPath('decision-flowchart.png') });
    await sequence.scrollIntoViewIfNeeded();
    if (width === 320) {
      const scroller = sequence.locator('..');
      expect(await scroller.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      await scroller.evaluate(node => { node.scrollLeft = node.scrollWidth; });
      await expect.poll(() => scroller.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    }
    await page.screenshot({ path: testInfo.outputPath('sequence.png') });
  });
}
