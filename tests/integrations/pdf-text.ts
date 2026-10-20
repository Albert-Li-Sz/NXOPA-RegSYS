import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
export async function pdfText(bytes: Uint8Array) {
  const { getDocument } = await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const loading = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
  const document = await loading.promise;
  try {
    const pages: string[] = [];
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      pages.push(content.items.map((item: { str?: string }) => item.str ?? '').join(' '));
    }
    return pages.join('\n');
  } finally {
    await loading.destroy();
  }
}
