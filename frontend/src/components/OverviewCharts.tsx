"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// กราฟแท่งแบบกลุ่ม (SVG ล้วน ไม่ใช้ไลบรารี) สำหรับหน้าภาพรวมผู้บริหาร - แกน Y เดียว, แท่งบาง ปลายมน 4px,
// เส้นกริดจางๆ, ชี้แท่งแล้วเห็นรายละเอียด (tooltip) สีของแต่ละชุดข้อมูลกำหนดตายตัวจากผู้เรียก ไม่เปลี่ยนตามลำดับ

export interface ChartSeries {
  name: string;
  color: string;
}

export interface ChartGroup {
  label: string; // ป้ายแกน X
  values: number[]; // เรียงตาม series
  tip: ReactNode; // เนื้อหา tooltip ของกลุ่มนี้
}

const PAD = { top: 12, right: 8, bottom: 28, left: 52 };

function niceStep(x: number): number {
  if (x <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(x));
  const f = x / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

export function compactBaht(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${+(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${+(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(v));
}

// แท่งปลายมนเฉพาะด้านบน ฐานเรียบติดแกน
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function GroupedBarChart({
  groups,
  series,
  height = 240,
  ariaLabel,
  emptyText = "ยังไม่มีข้อมูลในช่วงนี้",
}: {
  groups: ChartGroup[];
  series: ChartSeries[];
  height?: number;
  ariaLabel: string;
  emptyText?: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const max = Math.max(0, ...groups.flatMap((g) => g.values));
  const step = niceStep(max / 4 || 250);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const colW = groups.length ? plotW / groups.length : 0;
  const gap = 2;
  const barW = Math.max(2, Math.min(16, (colW * 0.72 - gap * (series.length - 1)) / series.length));
  const clusterW = barW * series.length + gap * (series.length - 1);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  // ป้ายแกน X ไม่ให้ชนกัน: เว้นช่วงตามความกว้างที่มี (ประมาณ 44px ต่อป้าย)
  const labelEvery = Math.max(1, Math.ceil(44 / Math.max(colW, 1)));

  // tooltip อยู่ข้างคอลัมน์ที่ชี้ ไม่บังแท่งที่กำลังดู: ครึ่งขวาของกราฟแสดงทางซ้าย ครึ่งซ้ายแสดงทางขวา
  const tipStyle =
    hover === null
      ? undefined
      : PAD.left + colW * (hover + 0.5) > width / 2
        ? { right: Math.max(0, width - (PAD.left + colW * hover) + 6) }
        : { left: PAD.left + colW * (hover + 1) + 6 };

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="chart-svg">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? "chart-axis" : "chart-grid"} />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart-tick">
                {compactBaht(t)}
              </text>
            </g>
          ))}
          {hover !== null && (
            <rect x={PAD.left + colW * hover} y={PAD.top} width={colW} height={plotH} className="chart-band" />
          )}
          {groups.map((g, i) => {
            const x0 = PAD.left + colW * i + (colW - clusterW) / 2;
            return (
              <g key={i}>
                {g.values.map((v, s) => {
                  const h = (v / top) * plotH;
                  if (h <= 0) return null;
                  return <path key={s} d={barPath(x0 + s * (barW + gap), y(v), barW, h)} fill={series[s].color} />;
                })}
                {i % labelEvery === 0 && (
                  <text x={PAD.left + colW * (i + 0.5)} y={height - 8} textAnchor="middle" className="chart-tick">
                    {g.label}
                  </text>
                )}
                <rect
                  x={PAD.left + colW * i}
                  y={PAD.top}
                  width={colW}
                  height={plotH + PAD.bottom}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onClick={() => setHover(i)}
                />
              </g>
            );
          })}
          {max === 0 && (
            <text x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} textAnchor="middle" className="chart-empty">
              {emptyText}
            </text>
          )}
        </svg>
      )}
      {hover !== null && groups[hover] && (
        <div className="chart-tip" style={tipStyle}>
          {groups[hover].tip}
        </div>
      )}
    </div>
  );
}

export function ChartLegend({ series }: { series: ChartSeries[] }) {
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span key={s.name}>
          <i style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}
