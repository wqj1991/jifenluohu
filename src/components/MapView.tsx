import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  fetchMapCommute,
  fetchMapData,
  type MapBiz,
  type MapComm,
  type MapCommute,
  type MapData,
} from "../lib/api";

/* 色阶：tier 0 是站点的兜底桶（「大兴周边」这类），不着色只描边；
   1..5 按真实分位数切，朱红给最贵，与列表里「通勤越久越朱红」的语义一致。 */
const TIER_COLOR = ["#b3ab99", "#6f8f6a", "#9aa87f", "#c2ae7f", "#c98b5e", "#9d3a32"];

// 非行政区的片区名（高德 POI：北京经济技术开发区 116.506622,39.795275）
const PLACE_LABELS = [{ name: "亦庄", lng: 116.5066, lat: 39.7953 }];
const wan = (n: number | null) => (n == null ? "—" : (n / 10000).toFixed(2));

function tierColor(t: number) {
  return TIER_COLOR[Math.max(0, Math.min(5, t))];
}

function labelHtml(b: MapBiz) {
  const tone = b.tier === 0 ? "#8a7f6b" : b.tier >= 5 ? "#8a1c14" : "#1b1b1a";
  const price = b.median ? `<b class="biz-price" style="color:${tone}">${wan(b.median)}</b>` : "";
  const dim = b.tier === 0 ? " biz-label-dim" : "";
  return `<div class="biz-label${dim}"><span class="biz-name">${b.bizcircle}</span>${price}</div>`;
}

/* 小区悬浮卡：价格立刻有，通勤要打高德，所以先渲染价格 + 「通勤计算中」，算完再补 */
function commTip(c: MapComm, k: MapCommute | "loading" | "fail" | undefined) {
  const rows = [
    `<div class="biz-tip-h">${c.name}</div>`,
    c.p != null
      ? `<div class="biz-tip-p">${wan(c.p)} 万/㎡<span>挂牌</span></div>`
      : `<div class="biz-tip-dim">暂无挂牌价</div>`,
    `<div class="biz-tip-r">${c.d} · ${c.b}${c.y ? ` · ${c.y} 年建` : ""}</div>`,
  ];
  if (k === "loading") {
    rows.push(`<div class="biz-tip-c biz-tip-wait">通勤计算中…</div>`);
  } else if (k === "fail") {
    rows.push(`<div class="biz-tip-c biz-tip-wait">通勤数据读取失败</div>`);
  } else if (k) {
    if (k.price_tx != null) rows.push(`<div class="biz-tip-r">成交 ${wan(k.price_tx)} 万/㎡</div>`);
    const legs = k.commutes.filter((t) => t.min != null);
    for (const t of legs) {
      const span = t.min === t.max ? `${t.min}` : `${t.min}–${t.max}`;
      const km = t.distance_m ? `<i>${(t.distance_m / 1000).toFixed(1)} km</i>` : "";
      rows.push(`<div class="biz-tip-c"><b>${span}</b> 分钟${km}<span>${t.label}</span></div>`);
    }
    if (k.note) rows.push(`<div class="biz-tip-c biz-tip-wait">${k.note}</div>`);
    else if (!legs.length) rows.push(`<div class="biz-tip-c biz-tip-wait">没有可用公交方案</div>`);
  }
  return rows.join("");
}

export default function MapView({
  onPickBiz,
  bizOnly = false,
  height = "calc(100vh - 260px)",
}: {
  onPickBiz: (b: MapBiz) => void;
  bizOnly?: boolean;
  height?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const ptsRef = useRef<L.LayerGroup | null>(null);
  /* 只看商圈：只把小区点层摘掉，面与标签都留着，切换时不动视野也不重取数据 */
  const [onlyBiz, setOnlyBiz] = useState(bizOnly);
  const labelLayer = useRef<L.LayerGroup | null>(null);
  const faceByKey = useRef<Map<string, L.Polygon>>(new Map());
  const dataRef = useRef<MapData | null>(null);
  /* 小区通勤：算过一次就留在内存里，同一小区再悬浮不再打请求 */
  const commuteCache = useRef(new Map<number, MapCommute | "loading" | "fail">());
  const hoverComm = useRef<number | null>(null);

  const [data, setData] = useState<MapData | null>(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<MapBiz | null>(null);
  const [hover, setHover] = useState<{ b: MapBiz; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(11);

  /* ---------- 初始化地图（只做一次） ---------- */
  useEffect(() => {
    if (!box.current || mapRef.current) return;
    const m = L.map(box.current, {
      preferCanvas: true,
      zoomControl: true,
      attributionControl: false,
      minZoom: 9,
      maxZoom: 17,
      zoomSnap: 0.5,
    });
    m.setView([39.87, 116.6], 11);
    // 瓦片由后端代理（公司网里浏览器直连高德会被 Zscaler 拦），见 server/map.mjs
    L.tileLayer("/api/tiles/{z}/{x}/{y}", { maxZoom: 17, className: "map-tile", keepBuffer: 3 }).addTo(m);
    labelLayer.current = L.layerGroup().addTo(m);
    m.on("zoomend", () => setZoom(m.getZoom()));
    mapRef.current = m;
    return () => {
      m.remove();
      mapRef.current = null;
      labelLayer.current = null;
      faceByKey.current.clear();
    };
  }, []);

  useEffect(() => {
    fetchMapData()
      .then(setData)
      .catch(() => setErr("地图数据读取失败"));
  }, []);

  /* ---------- 图层 ---------- */
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !data) return;
    dataRef.current = data;

    const [w, s, e, n] = data.bbox;
    const g = L.layerGroup().addTo(m);

    /* 区外遮罩：一个大矩形 + 两个区界内环，evenodd 把区界内部挖空，区外压成纸色。
       先画，垫在瓦片上、商圈面与区界之下，只负责让视线留在通州 + 大兴。 */
    const holes = Object.values(data.districts).filter((r) => r.length > 3);
    if (holes.length) {
      const outer: [number, number][] = [
        [s - 2, w - 2],
        [n + 2, w - 2],
        [n + 2, e + 2],
        [s - 2, e + 2],
      ];
      L.polygon([outer, ...holes.map((r) => r.map(([lng, lat]) => [lat, lng] as [number, number]))], {
        stroke: false,
        fillColor: "#fbfaf6",
        fillOpacity: 0.9,
        interactive: false,
      }).addTo(g);
    }

    /* 商圈面 */
    for (const b of data.biz) {
      if (!b.poly.length) continue;
      const latlngs = b.poly.map(([lng, lat]) => [lat, lng] as [number, number]);
      const poly = L.polygon(latlngs, {
        color: tierColor(b.tier),
        weight: b.tier === 0 ? 0.8 : 1,
        opacity: b.tier === 0 ? 0.5 : 0.85,
        dashArray: b.tier === 0 ? "5 4" : undefined,
        fillColor: tierColor(b.tier),
        fillOpacity: b.tier === 0 ? 0.08 : 0.16,
      }).addTo(g);

      poly.bindTooltip(() => {
        const rows = [
          `<div class="biz-tip-h">${b.bizcircle}</div>`,
          b.bucket
            ? `<div class="biz-tip-dim">站点未归类的兜底商圈，不做均价着色</div>`
            : `<div class="biz-tip-p">${wan(b.median)} 万/㎡<span>中位</span></div>`,
          `<div class="biz-tip-r">${b.priced ? `${wan(b.p25)}–${wan(b.p75)} 万 · ` : ""}${b.n} 个小区${b.priced < b.n ? ` · ${b.priced} 个有价` : ""}</div>`,
        ];
        return rows.join("");
      }, { sticky: true, direction: "top", className: "biz-tip", opacity: 1 });

      poly.on("click", () => setSel(b));
      poly.on("mouseover", () => {
        poly.setStyle({ fillOpacity: b.tier === 0 ? 0.14 : 0.3, weight: 2 });
        setHover({ b, x: 0, y: 0 });
      });
      poly.on("mouseout", () => {
        poly.setStyle({ fillOpacity: b.tier === 0 ? 0.08 : 0.16, weight: b.tier === 0 ? 0.8 : 1 });
        setHover(null);
      });

      faceByKey.current.set(b.key, poly);
    }

    /* 小区点：canvas 渲染，2400 个不吃 DOM。
       悬浮先出价格；通勤要打高德，鼠标在点上停 250ms 才算，
       否则拖着鼠标扫过一片点会一次刷出几十个请求。 */
    const pts = L.layerGroup();
    for (const c of data.comms) {
      if (!c.p) continue;
      const marker = L.circleMarker([c.lat, c.lng], {
        radius: 2.6,
        color: "rgba(27,27,26,.35)",
        weight: 0.6,
        fillColor: tierColor(
          c.p >= (data.cuts[3] ?? Infinity) ? 5 :
          c.p >= (data.cuts[2] ?? Infinity) ? 4 :
          c.p >= (data.cuts[1] ?? Infinity) ? 3 :
          c.p >= (data.cuts[0] ?? Infinity) ? 2 : 1
        ),
        fillOpacity: 0.85,
      }).bindTooltip(() => commTip(c, commuteCache.current.get(c.id)), {
        direction: "top",
        className: "biz-tip",
        opacity: 1,
        offset: [0, -2],
      });

      let timer = 0;
      const redraw = () => {
        marker.setTooltipContent(commTip(c, commuteCache.current.get(c.id)));
        if (marker.getTooltip()?.isOpen()) marker.openTooltip();
      };
      marker.on("mouseover", () => {
        hoverComm.current = c.id;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          const hit = commuteCache.current.get(c.id);
          if (hit && hit !== "loading") return; // 已经算过/算好了，函数式 tooltip 直接用
          commuteCache.current.set(c.id, "loading");
          redraw();
          fetchMapCommute(c.id)
            .then((r) => commuteCache.current.set(c.id, r))
            .catch(() => commuteCache.current.set(c.id, "fail"))
            .finally(() => {
              if (hoverComm.current === c.id) redraw();
            });
        }, 250);
      });
      marker.on("mouseout", () => {
        window.clearTimeout(timer);
        if (hoverComm.current === c.id) hoverComm.current = null;
      });
      marker.addTo(pts);
    }
    ptsRef.current = pts;

    /* 行政边界：最后画，压在商圈面与小区点之上（同一 canvas 里按添加顺序绘制）。
       纸色底衬 + 墨色实线，任何底色上都清楚。
       不用「外框挖洞」的遮罩——它会在视野四周留下一圈方形纸色，看着像给地图套了个方框；
       环京与错标点已在服务端按 bbox 过滤掉，不需要遮。 */
    const rings = Object.entries(data.districts).filter(([, r]) => r.length > 3);
    for (const [, r] of rings) {
      const latlngs = r.map(([lng, lat]) => [lat, lng] as [number, number]);
      L.polygon(latlngs, { color: "#fbfaf6", weight: 5, opacity: 0.8, fill: false, interactive: false }).addTo(g);
      L.polygon(latlngs, { color: "#4a4740", weight: 1.6, opacity: 0.92, fill: false, interactive: false }).addTo(g);
    }
    for (const [name, r] of rings) {
      const cx = r.reduce((a, p) => a + p[0], 0) / r.length;
      const cy = r.reduce((a, p) => a + p[1], 0) / r.length;
      L.marker([cy, cx], {
        icon: L.divIcon({ html: `<div class="dist-label">${name}</div>`, className: "", iconSize: [0, 0] }),
        interactive: false,
        keyboard: false,
      }).addTo(g);
    }

    /* 片区名：亦庄不是行政区（高德只到「亦庄镇」街道级且无边界数据），
       只能给它一个地名点，不画线，避免让人以为是官方区界。 */
    for (const p of PLACE_LABELS) {
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({ html: `<div class="place-label">${p.name}</div>`, className: "", iconSize: [0, 0] }),
        interactive: false,
        keyboard: false,
      }).addTo(g);
    }

    /* 初始视野 */
    m.fitBounds([[s, w], [n, e]], { padding: [10, 10] });

    return () => {
      if (ptsRef.current && m.hasLayer(ptsRef.current)) m.removeLayer(ptsRef.current);
      ptsRef.current = null;
      g.remove();
      faceByKey.current.clear();
    };
  }, [data, onPickBiz]);

  /* 小区点层的挂/摘：与图层构建分开，切换「只看商圈」时不重建面、不重置视野 */
  useEffect(() => {
    const m = mapRef.current;
    const pts = ptsRef.current;
    if (!m || !pts) return;
    if (onlyBiz) {
      if (m.hasLayer(pts)) m.removeLayer(pts);
    } else if (!m.hasLayer(pts)) {
      pts.addTo(m);
    }
  }, [onlyBiz, data]);

  /* ---------- 标签：按 zoom 控密度 + 屏幕网格去重，避免低缩放时糊成一片 ---------- */
  useEffect(() => {
    const m = mapRef.current;
    const lg = labelLayer.current;
    const d = dataRef.current;
    if (!m || !lg || !d) return;
    lg.clearLayers();
    const z = m.getZoom();
    // 只看商圈时图上没有小区点，密度门槛放宽一档，不然低缩放会空成一张白纸
    const minN = onlyBiz
      ? (z >= 13 ? 0 : z >= 12 ? 2 : z >= 11 ? 8 : 20)
      : (z >= 13 ? 0 : z >= 12 ? 8 : z >= 11 ? 20 : 40);
    const cand = d.biz
      .filter((b) => (b.median != null || b.bucket) && (b.n >= minN || b.key === sel?.key))
      .sort((a, b) => b.n - a.n);
    const used = new Set<string>();
    for (const b of cand) {
      const p = m.latLngToContainerPoint([b.lat, b.lng]);
      if (b.key !== sel?.key) {
        const cell = `${Math.round(p.x / 78)}:${Math.round(p.y / 30)}`;
        if (used.has(cell)) continue;
        used.add(cell);
      }
      L.marker([b.lat, b.lng], {
        icon: L.divIcon({ html: labelHtml(b), className: "", iconSize: [0, 0] }),
        interactive: false,
        keyboard: false,
      }).addTo(lg);
    }
  }, [data, zoom, sel, onlyBiz]);

  /* ---------- 选中态 ---------- */
  useEffect(() => {
    for (const [key, poly] of faceByKey.current) {
      const b = data?.biz.find((x) => x.key === key);
      if (!b) continue;
      const on = sel?.key === key;
      poly.setStyle({
        weight: on ? 2.4 : b.tier === 0 ? 0.8 : 1,
        fillOpacity: on ? 0.32 : b.tier === 0 ? 0.08 : 0.16,
        color: on ? "#8a1c14" : tierColor(b.tier),
      });
      if (on) poly.bringToFront();
    }
  }, [sel, data]);

  return (
    <div className="relative">
      <div ref={box} className="map-box" style={{ height }} />

      {/* 图面模式：只看商圈（面 + 单价标签）/ 叠上小区点 */}
      <div className="map-switch">
        <button data-on={!onlyBiz} onClick={() => setOnlyBiz(false)}>商圈 + 小区</button>
        <button data-on={onlyBiz} onClick={() => setOnlyBiz(true)}>只看商圈</button>
      </div>

      {/* 图例 */}
      {data && (
        <div className="map-legend">
          <div className="map-legend-t">商圈中位单价 · 万/㎡</div>
          {[1, 2, 3, 4, 5].map((t) => {
            const c = data.cuts;
            const lo = t <= 1 ? null : c[t - 2] / 10000;
            const hi = t >= 5 ? null : c[t - 1] / 10000;
            const text =
              lo == null && hi != null ? `< ${hi.toFixed(2)}`
              : hi == null && lo != null ? `≥ ${lo.toFixed(2)}`
              : lo != null && hi != null ? `${lo.toFixed(2)}–${hi.toFixed(2)}`
              : "—";
            return (
              <div key={t} className="map-legend-row">
                <i style={{ background: tierColor(t) }} />
                <span>{text}</span>
              </div>
            );
          })}
          <div className="map-legend-row">
            <i className="map-legend-dash" />
            <span>未归类商圈</span>
          </div>
        </div>
      )}

      {/* 选中/悬停读数 */}
      {(sel || hover) && (
        <div className="map-readout">
          {(() => {
            const b = (sel || hover!.b) as MapBiz;
            return (
              <>
                <div className="sans text-[10.5px] tracking-[.24em]" style={{ color: "var(--color-mute)" }}>
                  {b.district} · {b.bizcircle}
                </div>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="num text-[24px] leading-none" style={{ color: tierColor(b.tier) }}>
                    {b.bucket ? "—" : wan(b.median)}
                  </span>
                  <span className="sans text-[10.5px]" style={{ color: "var(--color-mute)" }}>
                    {b.bucket ? "兜底商圈，不做着色" : "万/㎡ 中位"}
                  </span>
                </div>
                <div className="sans text-[10.5px] mt-1" style={{ color: "var(--color-ink-2)" }}>
                  {b.priced ? `P25–P75 ${wan(b.p25)}–${wan(b.p75)} 万 · ` : ""}
                  {b.n} 个小区{b.priced < b.n ? ` / ${b.priced} 有价` : ""}
                </div>
                {sel && (
                  <button
                    onClick={() => onPickBiz(sel)}
                    className="sans text-[11px] mt-2"
                    style={{ color: "var(--color-seal)" }}
                  >
                    在列表里看这个商圈 →
                  </button>
                )}
              </>
            );
          })()}
        </div>
      )}

      {!data && !err && (
        <div className="absolute inset-0 grid place-items-center sans text-[12px]" style={{ color: "var(--color-mute)" }}>
          地图加载中…
        </div>
      )}
      {err && (
        <div className="absolute inset-0 grid place-items-center sans text-[12px]" style={{ color: "var(--color-seal)" }}>
          {err}
        </div>
      )}
    </div>
  );
}
