#!/usr/bin/env bash
set -euo pipefail
guide_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
guide_temp="$guide_root/tmp/pdfs/configuration-guide"
mkdir -p "$guide_temp" "$guide_root/output/pdf"
cd "$guide_root/docs"
for guide_pass in 1 2; do
  xelatex -no-shell-escape -interaction=nonstopmode -halt-on-error -output-directory="$guide_temp" CONFIGURATION_GUIDE.tex > "$guide_temp/pass-$guide_pass.log"
done
cp "$guide_temp/CONFIGURATION_GUIDE.pdf" "$guide_root/output/pdf/configuration-guide.pdf"
rm -f "$guide_root/output/pdf/configuration-guide-source.zip"
zip -q -r "$guide_root/output/pdf/configuration-guide-source.zip" CONFIGURATION_GUIDE.tex configuration-screenshots
node --input-type=module <<'NODE'
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const screenshots = {};
for (const name of (await readdir('configuration-screenshots')).filter(x => x.endsWith('.png')).sort()) screenshots[name] = await hash(`configuration-screenshots/${name}`);
await writeFile('../output/pdf/configuration-guide-manifest.json', JSON.stringify({ sourceSha256: await hash('CONFIGURATION_GUIDE.tex'), pdfSha256: await hash('../output/pdf/configuration-guide.pdf'), sourceZipSha256: await hash('../output/pdf/configuration-guide-source.zip'), screenshots }, null, 2) + '\n');
NODE
printf 'Created output/pdf/configuration-guide.pdf and source bundle.\n'
