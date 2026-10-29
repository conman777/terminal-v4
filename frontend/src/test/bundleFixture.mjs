import { build } from 'esbuild';

const { entry, virtual = {}, root } = JSON.parse(await new Promise(done => { let data = ''; process.stdin.on('data', chunk => { data += chunk; }).on('end', () => done(data)); }));
const plugin = {
  name: 'virtual',
  setup(b) {
    for (const [pattern, source] of Object.entries(virtual)) {
      b.onResolve({ filter: new RegExp(pattern) }, () => ({ path: pattern, namespace: 'virtual' }));
      b.onLoad({ filter: /.*/, namespace: 'virtual' }, args => (args.path === pattern ? { contents: source, loader: 'jsx', resolveDir: root } : undefined));
    }
  },
};
const result = await build({ stdin: { contents: entry, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, outdir: 'out', format: 'iife', jsx: 'automatic', plugins: [plugin],
  loader: { '.css': 'css', '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  define: { 'import.meta.env.VITE_API_URL': '""', 'import.meta.env.DEV': 'false', 'import.meta.env.MODE': '"test"', 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.PROD': 'true' }, logLevel: 'error' });
process.stdout.write(JSON.stringify(result.outputFiles.map(file => ({ path: file.path, text: file.text }))));
