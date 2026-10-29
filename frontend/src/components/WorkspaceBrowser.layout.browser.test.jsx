import { managedChromiumPath } from '../test/managedChromium';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function compileFixture() {
  const { build } = require('esbuild');
  build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import WorkspaceBrowser from './WorkspaceBrowser'; import {PreviewUrlBar} from './preview/PreviewUrlBar'; import {PreviewPanel} from './PreviewPanel'; import {AutocorrectProvider} from '../contexts/AutocorrectContext';
        const root=createRoot(document.getElementById('root'));
        window.mount=control=>{window.fixtureControl=control;root.render(<WorkspaceBrowser onClose={()=>{}} onToggleExpanded={()=>{}} />)};
        function PreviewFixture(){
          const [ports,setPorts]=React.useState(false),[tools,setTools]=React.useState(false);
          return <div className="preview-panel compact-chrome"><PreviewUrlBar inputUrl="localhost:4173" activePorts={[{port:4173,process:'vite',cwd:'/synthetic/project'}]}
            activePreviewScope={{appLabel:'A long synthetic application name'}} previewPort={4173}
            showPortDropdown={ports} onTogglePortDropdown={()=>setPorts(!ports)} showToolsMenu={tools} onToggleToolsMenu={()=>setTools(!tools)}
            onInputUrlChange={()=>{}} onUrlSubmit={e=>e.preventDefault()} onSelectPort={()=>{}} historyIndex={0} historyStackLength={1}
            desktopLayoutMode="split" iframeSrc={null} onClose={()=>{}} /></div>;
        }
        window.mountPreview=()=>root.render(<PreviewFixture/>);
        window.mountFullPreview=(active=false)=>root.render(<AutocorrectProvider><PreviewPanel url={null} activeSessions={active?[{id:'synthetic-terminal',title:'Synthetic terminal'}]:[]} onClose={()=>{}}/></AutocorrectProvider>);`,
      resolveDir: process.argv[1], loader: 'jsx'
    },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'import.meta.env': '{"DEV":false}' },
    plugins: [{ name: 'synthetic-browser-api', setup(builder) {
      builder.onResolve({ filter: /\/(LazyTerminalChat)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'empty-component' }));
      builder.onLoad({ filter: /.*/, namespace: 'empty-component' }, args => ({ contents: `export function ${args.path}(){return null;}` }));
      builder.onResolve({ filter: /^\.\.\/utils\/api$/ }, () => ({ path: 'fixture-api', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export async function apiFetch(path){
        const state={activeTabId:'tab',tabs:[{id:'tab',title:'Fixture',url:'about:blank'}],dialog:null,control:window.fixtureControl};
        return {ok:true,status:200,json:async()=>path.endsWith('/sessions')?{id:'session',state}:path.endsWith('/approvals')?{requests:[]}:state};
      }
      export const apiGet=async()=>({}); export const apiPost=async()=>({}); export const apiDelete=async()=>({}); export const apiPut=async()=>({}); export const apiPatch=async()=>({}); export const uploadScreenshot=async()=>'/synthetic/image.png'; export const uploadAttachment=async()=>'/synthetic/file.pdf';` }));
    } }]
  }).then(result => process.stdout.write(result.outputFiles[0].text));
}

let browser, script, styles, previewStyles;
const evidence = resolve(process.cwd(), '../output/overnight-polish-20261025');
beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  // esbuild needs Node's typed-array realm rather than jsdom's.
  script = execFileSync(process.execPath, ['-e', `(${compileFixture.toString()})()`, resolve(process.cwd(), 'src/components')], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  styles = (await Promise.all(['WorkspaceBrowser.css', 'WorkspacePanel.css'].map(file => readFile(resolve(process.cwd(), 'src/components', file), 'utf8')))).join('\n');
  previewStyles = (await Promise.all(['styles.css', 'ProUI.css', 'WorkspaceUI.css', 'components/DesktopComposer.css', 'components/preview/PreviewPanel.css'].map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
});
afterAll(async () => { await browser?.close(); });

describe('browser ownership chrome at minimum width', () => {
  it.each([false, true])('keeps the header aligned and control actions visible with touch=%s', async hasTouch => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, hasTouch });
    try {
      for (const control of [
        { owner: 'human' },
        { owner: 'agent', label: 'A long coding agent session label that must remain accessible' }
      ]) {
        const page = await context.newPage();
        await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;font:12px system-ui;--workspace-topbar-height:52px}#root{display:flex;width:360px;height:700px}${styles}</style><div id="root" class="workspace-panel-tools"></div>`);
        await page.addScriptTag({ content: script });
        await page.evaluate(value => window.mount(value), control);
        const action = page.getByRole('button', { name: control.owner === 'human' ? 'Let agents control' : 'Take control', exact: true });
        await action.waitFor();
        const geometry = await page.evaluate(() => {
          const heading = document.querySelector('.workspace-browser-heading').getBoundingClientRect();
          const panel = document.querySelector('.workspace-browser').getBoundingClientRect();
          const action = [...document.querySelectorAll('.workspace-browser-control button')][0].getBoundingClientRect();
          const buttons = [...document.querySelectorAll('.workspace-browser-heading > button, .workspace-browser-heading > details > summary')].filter(node => node.getBoundingClientRect().width);
          return { headerHeight: heading.height, actionFits: action.x >= panel.x && action.right <= panel.right && action.bottom <= panel.bottom, headerButtonsFit: buttons.every(node => { const box = node.getBoundingClientRect(); return box.top >= heading.top && box.bottom <= heading.bottom && box.right <= heading.right; }), headerTargets: buttons.every(node => { const box = node.getBoundingClientRect(), minimum = matchMedia('(pointer: coarse)').matches ? 44 : 32; return box.width >= minimum && box.height >= minimum; }), overflow: document.querySelector('#root').scrollWidth > 360 };
        });
        expect(geometry).toEqual({ headerHeight: 52, actionFits: true, headerButtonsFit: true, headerTargets: true, overflow: false });
        await page.close();
      }
    } finally { await context.close(); }
  });
});

describe('preview toolbar within resizable panels', () => {
  it.each([false, true])('retains theme colors, visible actions and picker bounds with touch=%s', async hasTouch => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch });
    await context.route('**/*', route => route.abort());
    try {
      for (const width of [360, 700, 1200]) {
        const page = await context.newPage();
        await page.setContent(`<style>${previewStyles}body{margin:0}#root{display:flex;width:${width}px;height:700px;--bg-base:rgb(240,241,242);--bg-surface:rgb(230,231,232);--text-primary:rgb(30,31,32);--text-secondary:rgb(60,61,62);--font-ui:system-ui}</style><div id="root" data-theme="light"></div>`);
        await page.addScriptTag({ content: script });
        await page.evaluate(() => window.mountPreview());
        await page.getByRole('button', { name: 'Close browser', exact: true }).waitFor();
        const geometry = await page.evaluate(() => {
          const root = document.querySelector('#root');
          const panel = document.querySelector('.preview-panel');
          const header = document.querySelector('.preview-header').getBoundingClientRect();
          const buttons = [...panel.querySelectorAll('.preview-header button')].filter(node => node.getBoundingClientRect().width);
          return {
            overflow: root.scrollWidth > root.clientWidth,
            actionsFit: buttons.every(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= root.clientWidth && box.top >= header.top && box.bottom <= header.bottom; }),
            touchTargets: buttons.every(node => { const box = node.getBoundingClientRect(); return box.width >= (matchMedia('(pointer:coarse)').matches ? 44 : 28) && box.height >= (matchMedia('(pointer:coarse)').matches ? 44 : 28); }),
            background: getComputedStyle(panel).backgroundColor,
            inputColor: getComputedStyle(panel.querySelector('input')).color,
          };
        });
        expect(geometry).toEqual({ overflow: false, actionsFit: true, touchTargets: true, background: 'rgb(240, 241, 242)', inputColor: 'rgb(30, 31, 32)' });
        await page.getByRole('button', { name: 'Select active port', exact: true }).click();
        const picker = await page.locator('.preview-port-dropdown').boundingBox();
        expect(picker.x >= 0 && picker.x + picker.width <= width).toBe(true);
        await page.getByRole('textbox', { name: 'Filter active ports' }).press('Escape');
        await expect.poll(() => page.locator('.preview-port-dropdown').count()).toBe(0);
        await page.close();
      }
    } finally { await context.close(); }
  });
});

describe('full preview body within resizable panels', () => {
  it.each([false, true])('retains the real composer and transcript at the stacked End limit with touch=%s', async hasTouch => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(2000);
      await page.route('**/*', route => route.request().url().startsWith('http://preview-fixture.test/') ? route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }) : route.abort());
      await page.goto('http://preview-fixture.test/');
      await page.setContent(`<style>${previewStyles}body{margin:0}#root{display:flex;width:360px;height:700px;min-height:0;max-height:700px}</style><div id="root"></div>`);
      await page.addScriptTag({ content: script });
      await page.evaluate(() => window.mountFullPreview(true));
      await page.getByRole('textbox', { name: 'Command composer' }).waitFor();
      await page.getByRole('separator', { name: 'Resize preview and terminal' }).press('End');
      const geometry = await page.evaluate(() => {
        const pane = document.querySelector('.preview-terminal-section').getBoundingClientRect();
        const transcript = document.querySelector('.preview-terminal-content').getBoundingClientRect();
        const composer = document.querySelector('.desktop-status-bar.workspace-composer').getBoundingClientRect();
        const send = document.querySelector('[aria-label="Send to terminal"]').getBoundingClientRect();
        return { composerFits: composer.top >= pane.top && composer.bottom <= pane.bottom, sendFits: send.top >= pane.top && send.bottom <= pane.bottom, transcriptHeight: transcript.height };
      });
      expect(geometry.composerFits && geometry.sendFits && geometry.transcriptHeight >= 80).toBe(true);
      await page.locator('#root').screenshot({ path: resolve(evidence, `preview-active-composer-stacked-${hasTouch}.png`) });
      await writeFile(resolve(evidence, `preview-active-composer-stacked-${hasTouch}.json`), JSON.stringify(geometry));
    } finally { await context.close(); }
  });

  it.each([360, 700, 800, 1200].flatMap(width => [false, true].map(hasTouch => ({ width, hasTouch }))))('keeps both split panes usable in a $width px panel with touch=$hasTouch', async ({ width, hasTouch }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(2500);
      await page.route('**/*', route => route.request().url().startsWith('http://preview-fixture.test/') ? route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }) : route.abort());
      await page.goto('http://preview-fixture.test/');
      await page.setContent(`<style>${previewStyles}body{margin:0}#root{display:flex;width:${width}px;height:${hasTouch ? 700 : 700.75}px;min-height:0;max-height:${hasTouch ? 700 : 700.75}px}</style><div id="root"></div>`);
      await page.addScriptTag({ content: script });
      await page.evaluate(() => window.mountFullPreview(true));
      await page.getByRole('separator', { name: 'Resize preview and terminal' }).waitFor();
      const readPanes = () => page.evaluate(() => {
        const wrapper = document.querySelector('.preview-content-wrapper').getBoundingClientRect();
        const geometry = [...document.querySelectorAll('.preview-iframe-section,.preview-terminal-section')].map(node => ({
          rect: node.getBoundingClientRect().toJSON(), flex: node.style.flex, minHeight: getComputedStyle(node).minHeight,
        }));
        const panes = geometry.map(({ rect }) => ({
          fits: rect.left >= wrapper.left && rect.right <= wrapper.right && rect.top >= wrapper.top && rect.bottom <= wrapper.bottom,
          usable: rect.width >= 260 && rect.height >= 100,
        }));
        return { panes, geometry: { wrapper: wrapper.toJSON(), panes: geometry, separator: document.querySelector('[aria-label="Resize preview and terminal"]').outerHTML } };
      });
      const assertPanes = async stage => {
        const { panes, geometry } = await readPanes();
        await writeFile(resolve(evidence, `preview-bounds-followup-${width}-${hasTouch}-${stage}.json`), JSON.stringify(geometry, null, 2));
        expect(panes).toEqual([{ fits: true, usable: true }, { fits: true, usable: true }]);
      };
      await assertPanes('initial');
      const close = page.getByRole('button', { name: 'Close browser', exact: true });
      const closeBox = await close.boundingBox();
      expect(closeBox && closeBox.x >= 0 && closeBox.x + closeBox.width <= width).toBe(true);
      await page.locator('#root').screenshot({ path: resolve(evidence, `preview-source-split-${width}-${hasTouch}.png`) });
      const separator = page.getByRole('separator', { name: 'Resize preview and terminal' });
      for (const key of ['End', 'Home']) {
        await separator.press(key);
        await assertPanes(key);
      }
    } finally { await context.close(); }
  });

  it.each([320, 390, 768])('fits a %s px mobile host below the workspace header', async width => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.route('**/*', route => route.request().url().startsWith('http://preview-fixture.test/') ? route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }) : route.abort());
      await page.goto('http://preview-fixture.test/');
      await page.setContent(`<style>${previewStyles}body{margin:0}#root{position:absolute;top:52px;display:flex;width:${width}px;height:792px;min-height:0;max-height:792px}</style><div id="root"></div>`);
      await page.addScriptTag({ content: script });
      await page.evaluate(() => window.mountFullPreview());
      await page.locator('.preview-panel-mobile').waitFor();
      const geometry = await page.locator('.preview-panel-mobile').evaluate(node => {
        const { top, bottom, height, width } = node.getBoundingClientRect();
        return { top, bottom, height, width };
      });
      expect(geometry).toEqual({ top: 52, bottom: 844, height: 792, width });
      await page.screenshot({ path: resolve(evidence, `preview-source-mobile-${width}.png`) });
      await writeFile(resolve(evidence, `preview-source-mobile-${width}.json`), JSON.stringify(geometry));
    } finally { await context.close(); }
  });
});
