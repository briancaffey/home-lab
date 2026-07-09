// Generates /llms.txt (inventory) and /llms-full.txt (full markdown concat)
// into build/ after `npm run build` — the agent-friendly entry points.
import {readFileSync, writeFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join, relative} from 'node:path';

const DOCS = 'docs';
const OUT = 'build';
const SITE = 'https://briancaffey.github.io/home-lab';

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') || p.endsWith('.mdx') ? [p] : [];
  });
}

function frontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (m) for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return {fm, body: m ? src.slice(m[0].length) : src};
}

const pages = walk(DOCS).sort().map((p) => {
  const src = readFileSync(p, 'utf8');
  const {fm, body} = frontmatter(src);
  const route = relative(DOCS, p).replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '');
  return {path: p, route, title: fm.title ?? route, description: fm.description ?? '', body};
});

const inventory = [
  `# Brian's Home Lab — documentation`,
  ``,
  `> Human-first docs for a k3s home lab: 5 nodes, ~40 GitOps-managed services,`,
  `> operated by AI agents with a human. Source: https://github.com/briancaffey/home-lab (docs-site/)`,
  ``,
  `## Pages`,
  ...pages.map((p) => `- [${p.title}](${SITE}/${p.route}): ${p.description}`.trimEnd()),
  ``,
  `## Full content`,
  `- [llms-full.txt](${SITE}/llms-full.txt)`,
].join('\n');

const full = pages.map((p) => `\n\n---\n# ${p.title}\n(route: /${p.route})\n${p.body}`).join('');

if (!existsSync(OUT)) { console.error('build/ missing — run after npm run build'); process.exit(1); }
writeFileSync(join(OUT, 'llms.txt'), inventory);
writeFileSync(join(OUT, 'llms-full.txt'), inventory + full);
console.log(`llms.txt (${pages.length} pages) + llms-full.txt written`);
