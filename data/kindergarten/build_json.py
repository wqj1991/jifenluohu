# 把两份官方原件转成 JSON，供 scripts/seed_kindergarten_ranks.mjs 入库
# 原件：kfq2025_official.md（经开区社会事业局名录，截至2025-06）、dx2026_official.xlsx（大兴区教委 2026 名单）
import json
import re
from pathlib import Path

from openpyxl import load_workbook

HERE = Path(__file__).resolve().parent

# ---------- 经开区 28 所 ----------
raw = (HERE / "kfq2025_official.md").read_text(encoding="utf-8")
body = raw.split("Markdown Content:", 1)[1]
flat = re.sub(r"\s+", " ", body)

head = re.compile(
    r"(\d{1,2}) (北京[^ ]*?幼儿园(?:（开设托班）)?)\s*"
    r"(公办|普惠性民办幼儿园|非普惠性民办幼儿园) "
)
marks = list(head.finditer(flat))
kfq = []
for i, m in enumerate(marks):
    seg = flat[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(flat)]
    seg = seg.split("说明：")[0].strip()
    toks = seg.split(" ")
    while toks and toks[0] == "幼儿园":  # 性质列后残留的层级词
        toks.pop(0)
    ai = next((j for j, t in enumerate(toks) if t.startswith("北京")), None)
    if ai is None:
        addr, tel, fees = "", seg, []
    else:
        addr = toks[ai]
        tel = "".join(toks[:ai]).strip("/ ")
        fees = toks[ai + 1:]
    kfq.append(
        {
            "no": int(m.group(1)),
            "name": m.group(2).replace("（开设托班）", ""),
            "kind": m.group(3),
            "tuoban": "（开设托班）" in m.group(2),
            "tel": tel,
            "addr": addr,
            "fee_edu": fees[0] if fees else "",
            "fee_extra": " ".join(fees[1:]) if len(fees) > 1 else "",
        }
    )

# ---------- 大兴 187 所 ----------
ws = load_workbook(HERE / "dx2026_official.xlsx", data_only=True).worksheets[0]
dx = []
for row in ws.iter_rows(min_row=3, values_only=True):
    v = [str(c).strip() if c is not None else "" for c in row]
    if not v[0].isdigit():
        continue
    dx.append(
        {"no": int(v[0]), "name": v[1], "town": v[2], "kind": v[3], "addr": v[4], "tel": v[6].replace("\n", " ")}
    )

(HERE / "kfq2025.json").write_text(json.dumps(kfq, ensure_ascii=False, indent=1), encoding="utf-8")
(HERE / "dx2026.json").write_text(json.dumps(dx, ensure_ascii=False, indent=1), encoding="utf-8")

print("kfq", len(kfq), "dx", len(dx))
for r in kfq:
    print(r["no"], r["name"], "|", r["kind"], "|", r["tel"], "|", r["addr"], "|", r["fee_edu"], "|", r["fee_extra"])
