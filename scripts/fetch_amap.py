# -*- coding: utf-8 -*-
"""高德 POI 抓住宅小区 + 政务地图学校清单。"""
import io, json, os, sys, time, urllib.parse, urllib.request

KEY = os.environ.get("AMAP_KEY", "")
OUT = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(OUT, exist_ok=True)


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8", "ignore"))
        except Exception as e:
            print("retry", i, e, file=sys.stderr)
            time.sleep(2 + i * 2)
    return None


def amap_page(city, keywords, page):
    q = urllib.parse.urlencode({
        "key": KEY, "keywords": keywords, "types": "120300",
        "city": city, "citylimit": "true", "offset": 25, "page": page,
        "extensions": "base",
    })
    return get("https://restapi.amap.com/v3/place/text?" + q)


def crawl_amap(city, tag):
    seen, rows = {}, []
    for kw in ["住宅小区", "小区", "公寓", "家园", "花园"]:
        for page in range(1, 41):
            d = amap_page(city, kw, page)
            if not d or d.get("status") != "1":
                print("bad resp", kw, page, (d or {}).get("info"), file=sys.stderr)
                break
            pois = d.get("pois") or []
            if not pois:
                break
            new = 0
            for p in pois:
                pid = p.get("id")
                if not pid or pid in seen:
                    continue
                loc = (p.get("location") or "").split(",")
                if len(loc) != 2:
                    continue
                seen[pid] = {
                    "poi_id": pid,
                    "name": p.get("name"),
                    "address": p.get("address") if isinstance(p.get("address"), str) else "",
                    "adname": p.get("adname"),
                    "typecode": p.get("typecode"),
                    "lng": float(loc[0]), "lat": float(loc[1]),
                    "biz": (p.get("business_area") or "") if isinstance(p.get("business_area"), str) else "",
                }
                new += 1
            print("%s kw=%s page=%d +%d (total %d)" % (tag, kw, page, new, len(seen)), file=sys.stderr)
            if new == 0:
                break
            time.sleep(0.25)
        print("%s kw=%s done, total %d" % (tag, kw, len(seen)), file=sys.stderr)
    return list(seen.values())


def crawl_schools():
    rows = []
    for cid, label in [("xx", "小学"), ("zx", "中学")]:
        url = "https://map.beijing.gov.cn/api/place_list_for_category.json?categoryId=" + cid
        d = get(url)
        if not isinstance(d, list):
            print("school fail", cid, file=sys.stderr)
            continue
        for x in d:
            rows.append({
                "place_id": x.get("placeId"), "name": x.get("placeName"),
                "stage": label, "region_id": x.get("regionId"),
                "addr": x.get("addr"), "coord": x.get("coordinate"),
                "category": cid,
            })
        print("schools", label, len(d), file=sys.stderr)
    return rows


if __name__ == "__main__":
    if not KEY:
        print("AMAP_KEY missing", file=sys.stderr)
    else:
        for city, tag in [("通州区", "tongzhou"), ("大兴区", "daxing")]:
            rs = crawl_amap(city, tag)
            p = os.path.join(OUT, "communities_amap_%s.json" % tag)
            io.open(p, "w", encoding="utf-8").write(json.dumps(rs, ensure_ascii=False, indent=1))
            print("saved", p, len(rs), file=sys.stderr)
    ss = crawl_schools()
    p = os.path.join(OUT, "schools_bj.json")
    io.open(p, "w", encoding="utf-8").write(json.dumps(ss, ensure_ascii=False, indent=1))
    print("saved", p, len(ss), file=sys.stderr)
