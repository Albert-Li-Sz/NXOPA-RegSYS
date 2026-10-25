"""Convert the MOE ordinary-colleges XLS to the bundled undergraduate directory.

Usage: python3 -m pip install xlrd==2.0.2
       python3 scripts/import-moe-institutions.py /path/to/official.xls
The production application reads the committed JSON and never downloads this file.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

import xlrd

source = Path(sys.argv[1])
sheet = xlrd.open_workbook(source).sheet_by_index(0)
institutions = []
province = ""
for row in map(sheet.row_values, range(sheet.nrows)):
    section = re.fullmatch(r"(.+?)[（(]\d+所[）)]", str(row[0]).strip())
    if section:
        province = section[1]
    if row[5] != "本科":
        continue
    institutions.append({
        "code": str(int(row[2])), "name": str(row[1]).strip(),
        "province": province, "city": str(row[4]).strip(),
    })
assert len(institutions) == 1412
assert len({r["code"] for r in institutions}) == len(institutions)
assert len({r["name"] for r in institutions}) == len(institutions)
assert any(r["name"] == "南京晓庄学院" for r in institutions)
assert all(re.fullmatch(r"\d{10}", r["code"]) and r["province"] for r in institutions)
output = Path(__file__).resolve().parents[1] / "apps/server/src/data/institutions-moe-2026.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({
    "version": "moe-undergraduate-2026-06-17",
    "asOf": "2026-06-17",
    "source": "https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/202606/t20260618_1441074.html",
    "download": "https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/202606/W020260618416094865984.xls",
    "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "scope": "教育部全国普通高等学校名单中的本科院校，不含港澳台地区院校",
    "institutions": institutions,
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {len(institutions)} undergraduate institutions to {output}")
