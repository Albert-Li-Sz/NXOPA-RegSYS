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
zip -q -r "$guide_root/output/pdf/configuration-guide-source.zip" CONFIGURATION_GUIDE.tex configuration-screenshots
printf 'Created output/pdf/configuration-guide.pdf and source bundle.\n'
