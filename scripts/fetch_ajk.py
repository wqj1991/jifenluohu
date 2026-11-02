# -*- coding: utf-8 -*-
"""抓安居客移动站小区列表（通州/大兴），输出 JSON。"""
import io, json, os, re, sys, time, urllib.request

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
OUT = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(OUT, exist_ok=True)

ITEM = re.compile(r'<a href="https://m\.anjuke\.com/bj/community/(\d+)/" class="c-li-item".*?</a>', re.S)
TITLE = re.compile(r'row-title ellipsis"[^>]*>([^<]{1,40})')
INTRO = re.compile(r'<div class="row-intro ellipsis"[^>]*>(.*?)</div>', re.S)
SPAN = re.compile(r'<span[^>]*>([^<]{1,30})</span>')
YEAR = re.compile(r'class="year"[^>]*>(\d{4})')
PRICE = re.compile(r'class="price"[^>]*>(\d+)')
ONLINE = re.compile(r'class="onlineNum"[^>]*>(\d+)')


def fetch(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://m.anjuke.com/bj/"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:
            print("retry", i, url, e, file=sys.stderr)
            time.sleep(2 + i * 2)
    return ""


def parse(html, district):
    out = []
    for m in ITEM.finditer(html):
        cid, block = m.group(1), m.group(0)
        t = TITLE.search(block)
        if not t:
            continue
        intro = INTRO.search(block)
        spans = SPAN.findall(intro.group(1)) if intro else []
        spans = [s.strip() for s in spans if s.strip()]
        # spans 形如 [区, 商圈, 2016建]
        biz = spans[1] if len(spans) > 1 else ""
        y = YEAR.search(block)
        p = PRICE.search(block)
        o = ONLINE.search(block)
        out.append({
            "id": cid,
            "name": t.group(1).strip(),
            "district": district,
            "bizcircle": biz,
            "build_year": int(y.group(1)) if y else None,
            "price": int(p.group(1)) if p else None,
            "online": int(o.group(1)) if o else None,
            "url": "https://m.anjuke.com/bj/community/%s/" % cid,
        })
    return out


def crawl(slug, district, maxpage=50):
    seen, rows = set(), []
    for p in range(1, maxpage + 1):
        url = "https://m.anjuke.com/bj/community/%s/p%d/" % (slug, p) if p > 1 else "https://m.anjuke.com/bj/community/%s/" % slug
        html = fetch(url)
        if not html:
            break
        items = parse(html, district)
        new = [x for x in items if x["id"] not in seen]
        if not new:
            print("stop: no new items at page", p, file=sys.stderr)
            break
        for x in new:
            seen.add(x["id"])
        rows.extend(new)
        print("%s page %d -> %d new (total %d)" % (district, p, len(new), len(rows)), file=sys.stderr)
        time.sleep(1.2)
    return rows


if __name__ == "__main__":
    allrows = []
    for slug, d in [("tongzhou", "通州"), ("daxing", "大兴")]:
        rs = crawl(slug, d)
        allrows.extend(rs)
        path = os.path.join(OUT, "communities_ajk_%s.json" % slug)
        io.open(path, "w", encoding="utf-8").write(json.dumps(rs, ensure_ascii=False, indent=1))
        print("saved", path, len(rs), file=sys.stderr)
    print(json.dumps({"total": len(allrows)}, ensure_ascii=False))
