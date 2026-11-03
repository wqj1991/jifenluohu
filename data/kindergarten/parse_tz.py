# -*- coding: utf-8 -*-
"""通州区幼儿园园所公示信息（区教委 2026-06-08，4 份 PDF）-> tz2026.json
   原件：https://www.bjtzh.gov.cn/bjtz/tspd/tzjy/jygs/ 教育公示
   pdftotext/pymupdf 提取后的文本存于同目录 tz/*.txt
"""
import re, json, sys
from pathlib import Path
from collections import Counter

SRC = Path(__file__).parent / "tz"
FILES = [
    ("教育部门办", "tz_jiaoban.txt"),
    ("集体部队",   "tz_2026062320393482553.txt"),
    ("民办普惠",   "tz_2026062320393631896.txt"),
    ("民办非普惠", "tz_fei.txt"),
]
FILES_ORDER = {"教育部门办": 0, "集体部队": 1, "民办普惠": 2, "民办非普惠": 3}
STREETS = ["中仓","玉桥","北苑","梨园","永顺","潞源","通运","杨庄","临河里","文景","九棵树",
           "宋庄","张家湾","漷县","马驹桥","西集","台湖","永乐店","潞城","于家务"]

def norm(s):
    s = s.replace("\u3000", " ").replace("\xa0", " ")
    return re.sub(r"\s+", "", s)

def parse(txt, kind):
    """按「幼儿园名称：」逐条切；目录行（后面紧跟点线+页码、且 200 字内无「地址：」）跳过。"""
    out = []
    marks = [m.start() for m in re.finditer(r"幼儿园名称[:：]", txt)]
    for idx, pos in enumerate(marks):
        end = marks[idx + 1] if idx + 1 < len(marks) else len(txt)
        chunk = txt[pos + 6:end]          # 去掉「幼儿园名称：」
        flat = norm(chunk)
        if not re.search(r"地址[:：]", flat[:200]):
            continue                      # 目录条目
        name = re.split(r"地址[:：]", flat)[0][:60]
        addr = re.search(r"地址[:：](.{4,90}?)邮编[:：]", flat)
        addr = addr.group(1) if addr else ""
        tel = re.search(r"电话[:：]([0-9\-()转至分机]{6,30})", flat)
        tel = tel.group(1) if tel else ""
        bj = re.search(r"(?:保育教育费|保教费)(?:为)?([0-9.]+)元", flat)
        ty = re.search(r"托育服务费(?:为)?([0-9.]+)元", flat)
        meal = re.search(r"餐费(?:为)?([0-9.]+)元", flat)
        cls = re.search(r"办园规模(?:为)?([0-9]+)个教学班", flat)
        gd = re.search(r"督导评估认定为([A-C]?等级|合格|不合格|[壹贰叁]级[壹贰叁]类)", flat)
        if "部队办园" in flat or "部队举办" in flat:
            nature = "部队办"
        elif re.search(r"集体办园|镇政府举办|镇举办|村集体|村民委员会举办|村委会举办", flat):
            nature = "集体办"
        elif kind == "教育部门办" and ("教育部门办" in flat or "公办、普惠" in flat or "教委登记备案" in flat):
            nature = "教育部门办"
        elif "民办非普惠" in flat or "非普惠性民办" in flat:
            nature = "民办非普惠"
        elif "民办普惠" in flat or "普惠性民办" in flat or "民办普惠性" in flat:
            nature = "民办普惠"
        elif "教育部门办" in flat or "教委举办" in flat or "区教委所属" in flat:
            nature = "教育部门办"
        else:
            nature = {"教育部门办": "教育部门办", "集体部队": "集体办"}.get(kind, "民办非普惠")
        street = next((s for s in STREETS if s in addr), "")
        out.append(dict(name=name, addr=addr, tel=tel, street=street,
                        nature=nature, kind=kind,
                        fee_bj=float(bj.group(1)) if bj else None,
                        fee_tuoyu=float(ty.group(1)) if ty else None,
                        fee_meal=float(meal.group(1)) if meal else None,
                        classes=int(cls.group(1)) if cls else None,
                        grade=gd.group(1) if gd else ""))
    return out

rows = []
for kind, fn in FILES:
    p = SRC / fn
    if not p.exists():
        print("MISS", fn, file=sys.stderr); continue
    r = parse(p.read_text(encoding="utf-8", errors="replace"), kind)
    print(f"{kind:6s} {fn:30s} -> {len(r)}")
    rows.extend(r)

# 去重：同 (kind, seq) 保留信息更全的一条（目录段 vs 正文段）
best = {}
for r in rows:
    k = (r["name"], r["addr"][:14])
    if k not in best or (len(r["addr"]) + len(r["tel"])) > (len(best[k]["addr"]) + len(best[k]["tel"])):
        best[k] = r
ded = sorted(best.values(), key=lambda x: (FILES_ORDER.get(x["kind"], 9), x["name"]))

(Path(__file__).parent / "tz2026.json").write_text(json.dumps(ded, ensure_ascii=False, indent=1), encoding="utf-8")
print("total", len(ded))
print("nature", dict(Counter(r["nature"] for r in ded)))
print("grade ", dict(Counter(r["grade"] or "-" for r in ded)))
print("street", dict(Counter(r["street"] or "-" for r in ded).most_common()))
print("missing addr/tel", sum(1 for r in ded if not r["addr"]), sum(1 for r in ded if not r["tel"]))
print("fee_bj range", min((r["fee_bj"] or 9e9) for r in ded), max((r["fee_bj"] or 0) for r in ded))
