import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.DOCS_OUT_DIR ?? 'dist/docs-site');
assert(output.startsWith(join(root, 'dist') + sep), 'Documentation output must be inside dist/');
const source = await readFile(join(root, 'docs/CONFIGURATION_GUIDE.tex'), 'utf8');
const body = source.slice(
  source.indexOf('\\begin{document}') + '\\begin{document}'.length,
  source.lastIndexOf('\\end{document}'),
);
const headings = [...body.matchAll(/\\section\{([^}]+)\}/g)];
const ids = [
  'deployment',
  'site',
  'github',
  'mail',
  'invitations',
  'permissions',
  'hydro',
  'domjudge',
  'binding',
  'contest',
  'fields',
  'invoices',
  'display',
  'admissions',
  'operations',
];
assert.equal(headings.length, ids.length, 'Update chapter IDs when adding tutorial sections');
const images = new Set(['01-home']);
const escape = (value) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plain = (value) => value.replace(/\\([#%&_])/g, '$1').replace(/\\allowbreak\s*/g, '');

function group(input, start) {
  assert.equal(input[start], '{');
  let depth = 1;
  for (let i = start + 1; i < input.length; i++) {
    if (input[i] === '\\') {
      i++;
      continue;
    }
    if (input[i] === '{') depth++;
    if (input[i] === '}') {
      depth--;
      if (depth === 0) return { value: input.slice(start + 1, i), end: i + 1 };
    }
  }
  throw new Error('Unclosed LaTeX inline group');
}

function inline(input) {
  let result = '',
    cursor = 0;
  const commands = /\\(textbf|code|texttt|href)\{/g;
  let match;
  while ((match = commands.exec(input))) {
    result += escape(plain(input.slice(cursor, match.index)));
    const arg = group(input, commands.lastIndex - 1);
    if (match[1] === 'href') {
      const label = group(input, arg.end);
      assert.match(arg.value, /^https:\/\//, 'Only HTTPS source links are supported');
      result +=
        '<a href="' +
        escape(arg.value) +
        '" target="_blank" rel="noopener noreferrer">' +
        inline(label.value) +
        '</a>';
      cursor = label.end;
    } else {
      const tag = match[1] === 'textbf' ? 'strong' : 'code';
      result +=
        '<' +
        tag +
        '>' +
        (tag === 'strong' ? inline(arg.value) : escape(plain(arg.value))) +
        '</' +
        tag +
        '>';
      cursor = arg.end;
    }
    commands.lastIndex = cursor;
  }
  result += escape(plain(input.slice(cursor)));
  assert(!/\\[a-zA-Z]/.test(result), 'Unsupported inline LaTeX command: ' + input);
  return result;
}

function paragraphs(input) {
  return input
    .replace(/\\newpage/g, '')
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((p) => '<p>' + inline(p.trim()) + '</p>')
    .join('\n');
}

function figure(name, caption) {
  assert.match(name, /^[a-z0-9-]+$/);
  images.add(name);
  const path = 'assets/images/' + name + '.png';
  return (
    '<figure><a class="screenshot-open" href="' +
    path +
    '" aria-label="查看高清截图：' +
    escape(caption) +
    '"><img src="' +
    path +
    '" alt="' +
    escape(caption) +
    '" loading="lazy" decoding="async"></a><figcaption>' +
    inline(caption) +
    '<span>点击查看原图 ↗</span></figcaption></figure>'
  );
}

function render(input) {
  const blocks =
    /\\begin\{Code\}([\s\S]*?)\\end\{Code\}|\\shot(?:\[[^\]]+\])?\{([^}]+)\}\{([^}]+)\}|\\begin\{(itemize|enumerate)\}([\s\S]*?)\\end\{\4\}|\\begin\{tabularx\}[\s\S]*?\\toprule([\s\S]*?)\\end\{tabularx\}/g;
  let result = '',
    cursor = 0,
    match;
  while ((match = blocks.exec(input))) {
    result += paragraphs(input.slice(cursor, match.index));
    if (match[1] !== undefined) {
      result +=
        '<div class="code-block"><div class="code-toolbar"><span>配置示例</span><button type="button" class="copy-code" aria-label="复制配置示例">复制</button></div><pre><code>' +
        escape(match[1].trim()) +
        '</code></pre></div>';
    } else if (match[2]) {
      result += figure(match[2], match[3]);
    } else if (match[4]) {
      const tag = match[4] === 'itemize' ? 'ul' : 'ol';
      const items = match[5].split(/\\item\s*/).filter((i) => i.trim());
      result +=
        '<' +
        tag +
        '>' +
        items.map((i) => '<li>' + inline(i.trim()) + '</li>').join('') +
        '</' +
        tag +
        '>';
    } else {
      const rows = match[6]
        .replace(/\\(?:midrule|bottomrule)/g, '')
        .split('\\\\')
        .filter((r) => r.trim());
      result +=
        '<div class="table-wrap"><table>' +
        rows
          .map((row, i) => {
            const tag = i === 0 ? 'th' : 'td';
            return (
              '<tr>' +
              row
                .split('&')
                .map((cell) => '<' + tag + '>' + inline(cell.trim()) + '</' + tag + '>')
                .join('') +
              '</tr>'
            );
          })
          .join('') +
        '</table></div>';
    }
    cursor = blocks.lastIndex;
  }
  return result + paragraphs(input.slice(cursor));
}

const chapters = headings.map((h, i) => ({
  id: ids[i],
  title: h[1],
  html: render(body.slice(h.index + h[0].length, headings[i + 1]?.index ?? body.length)),
}));
assert(images.size > 0, 'The tutorial must include screenshots');
const nav = chapters
  .map((c, i) => {
    const groups = { 0: '开始使用', 4: '授权与评测平台', 9: '竞赛管理', 12: '日常维护' };
    return (
      (groups[i] ? '<p class="nav-group">' + groups[i] + '</p>' : '') +
      '<a href="#' +
      c.id +
      '"><span>' +
      String(i + 1).padStart(2, '0') +
      '</span>' +
      escape(c.title) +
      '</a>'
    );
  })
  .join('\n');
const article = chapters
  .map(
    (c, i) =>
      '<section class="chapter" id="' +
      c.id +
      '" aria-labelledby="title-' +
      c.id +
      '"><div class="chapter-heading"><span>配置步骤 ' +
      String(i + 1).padStart(2, '0') +
      '</span><h2 id="title-' +
      c.id +
      '">' +
      escape(c.title) +
      '</h2></div>' +
      c.html +
      '</section>',
  )
  .join('\n');
const template = await readFile(join(root, 'docs/site/index.html'), 'utf8');
const plugin = JSON.parse(
  await readFile(join(root, 'plugins/hydro-contest-center/package.json'), 'utf8'),
);
const html = template
  .replace('@@NAV@@', nav)
  .replace('@@CHAPTERS@@', article)
  .replaceAll('@@CHAPTER_COUNT@@', String(chapters.length))
  .replaceAll('@@SCREENSHOT_COUNT@@', String(images.size))
  .replaceAll('@@PLUGIN_VERSION@@', plugin.version);
assert(!html.replace('@@PLUGIN_SHA@@', '').includes('@@'), 'Unfilled documentation placeholder');
for (const name of images) await stat(join(root, 'docs/configuration-screenshots', name + '.png'));
for (const path of ['configuration-guide.pdf', 'configuration-guide-source.zip'])
  await stat(join(root, 'output/pdf', path));
const artifactManifest = JSON.parse(
  await readFile(join(root, 'output/pdf/configuration-guide-manifest.json'), 'utf8'),
);
const hashFile = async (path) =>
  createHash('sha256')
    .update(await readFile(join(root, path)))
    .digest('hex');
assert.equal(
  artifactManifest.sourceSha256,
  createHash('sha256').update(source).digest('hex'),
  'Recompile the PDF after changing the LaTeX source',
);
assert.equal(
  artifactManifest.pdfSha256,
  await hashFile('output/pdf/configuration-guide.pdf'),
  'PDF artifact checksum mismatch',
);
assert.equal(
  artifactManifest.sourceZipSha256,
  await hashFile('output/pdf/configuration-guide-source.zip'),
  'Source archive checksum mismatch',
);
for (const name of images)
  assert.equal(
    artifactManifest.screenshots[name + '.png'],
    await hashFile('docs/configuration-screenshots/' + name + '.png'),
    'Recompile the PDF after changing screenshots',
  );

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'assets/images'), { recursive: true });
await mkdir(join(output, 'downloads'), { recursive: true });

await writeFile(join(output, '.nojekyll'), '');
for (const name of ['guide.css', 'guide.js'])
  await copyFile(join(root, 'docs/site', name), join(output, 'assets', name));
await copyFile(
  join(root, 'apps/web/public/brand/openatom-club.jpg'),
  join(output, 'assets/club-logo.jpg'),
);
for (const name of images)
  await copyFile(
    join(root, 'docs/configuration-screenshots', name + '.png'),
    join(output, 'assets/images', name + '.png'),
  );
for (const name of ['configuration-guide.pdf', 'configuration-guide-source.zip'])
  await copyFile(join(root, 'output/pdf', name), join(output, 'downloads', name));
await copyFile(
  join(root, 'docs/CONFIGURATION_GUIDE.tex'),
  join(output, 'downloads/CONFIGURATION_GUIDE.tex'),
);
await copyFile(
  join(root, 'output/pdf/configuration-guide-manifest.json'),
  join(output, 'downloads/configuration-guide-manifest.json'),
);
const packed = JSON.parse(
  execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', join(output, 'downloads')],
    { cwd: join(root, 'plugins/hydro-contest-center'), encoding: 'utf8' },
  ),
)[0];
const allowed = new Set(['index.ts', 'README.md', 'LICENSE', 'package.json']);
assert(
  packed.files.every((f) => allowed.has(f.path)),
  'Plugin package contains an unexpected file',
);
const pluginHash = createHash('sha256')
  .update(await readFile(join(output, 'downloads', packed.filename)))
  .digest('hex');
await copyFile(
  join(output, 'downloads', packed.filename),
  join(output, 'downloads/hydro-contest-center-latest.tgz'),
);
await writeFile(
  join(output, 'downloads', packed.filename + '.sha256'),
  `${pluginHash}  ${packed.filename}\n`,
);
await writeFile(
  join(output, 'downloads/hydro-contest-center-latest.tgz.sha256'),
  `${pluginHash}  hydro-contest-center-latest.tgz\n`,
);
await writeFile(join(output, 'index.html'), html.replace('@@PLUGIN_SHA@@', pluginHash));
await writeFile(
  join(output, 'build-info.json'),
  JSON.stringify(
    {
      source: 'docs/CONFIGURATION_GUIDE.tex',
      chapters: chapters.map(({ id, title }) => ({ id, title })),
      screenshots: images.size,
      commit:
        process.env.GITHUB_SHA ??
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      plugin: {
        version: plugin.version,
        filename: packed.filename,
        sha256: pluginHash,
        hydroVersion: plugin.peerDependencies.hydrooj,
        files: packed.files.map((f) => f.path),
      },
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      pdfSha256: createHash('sha256')
        .update(await readFile(join(output, 'downloads/configuration-guide.pdf')))
        .digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Documentation built: ' +
    chapters.length +
    ' chapters, ' +
    images.size +
    ' screenshots → ' +
    output,
);
