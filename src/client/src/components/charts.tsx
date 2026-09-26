import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts'
import { rs } from '../lib/api'

/**
 * Charts, styled to match the rest of the application.
 *
 * Recharts out of the box looks like a different product bolted on. Three
 * things fix that: gradient fills under areas, rounded corners on bars, and a
 * tooltip built from the same tokens as the cards. The axis lines and tick
 * marks come off, because the grid already says where the values are.
 *
 * Draw times follow the screen. A monthly report is looked at once and can
 * take its time; a figure on a screen somebody watches through a shift gets
 * the short one.
 */
export const DRAW = { live: 700, report: 1300 } as const

/** A two-stop fade under an area. Most of what makes a chart look designed. */
export function Gradient({ id, color, from = 0.45, to = 0 }: {
  id: string; color: string; from?: number; to?: number
}) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={from} />
      <stop offset="100%" stopColor={color} stopOpacity={to} />
    </linearGradient>
  )
}

/** Built from the card tokens, so it belongs to the same screen. */
export function ChartTooltip({ active, payload, label, money }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="min-w-[150px] rounded-xl border-2 border-line bg-card/95 px-3.5 py-2.5
                    text-sm shadow-card backdrop-blur">
      <p className="mb-1 text-2xs font-medium text-heading">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex items-center justify-between gap-4 text-2xs">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="num font-medium text-heading">
            {money ? rs(p.value) : Number(p.value).toLocaleString('en-PK')}
          </span>
        </p>
      ))}
    </div>
  )
}

const AXIS = {
  axisLine: false as const,
  tickLine: false as const,
  tickMargin: 8
}

/**
 * The bar chart the reports screen draws.
 *
 * One series, because that is what a report catalogue entry describes. The
 * money formatter is chosen by the column name rather than passed in, so a
 * report that adds a money column gets the right axis without a change here.
 */
/**
 * Money on an axis, short.
 *
 * `rs()` writes 2,451,000.00 in full, which is right on an invoice and wrong
 * on an axis: the labels ran out of room and came out as "000.00" with the
 * front of every figure cut off. An axis needs the size of a number, not its
 * paisa.
 */
function axisMoney(v: number) {
  const n = Math.abs(v)
  if (n >= 10_000_000_00) return `${(v / 10_000_000_00).toFixed(1)}Cr`
  if (n >= 100_000_00) return `${(v / 100_000_00).toFixed(1)}L`
  if (n >= 1_000_00) return `${Math.round(v / 1_000_00)}k`
  return String(Math.round(v / 100))
}

const axisCount = (v: number) =>
  Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v)

/**
 * A date label, shortened.
 *
 * A report keyed by day returns 2026-08-27, and fourteen of those side by side
 * either overlap or force recharts to drop every other one, which is why the
 * first chart had gaps under half its bars. "27 Aug" fits.
 */
function axisLabel(v: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (m) {
    const d = new Date(`${v}T00:00:00`)
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  }
  const ym = /^(\d{4})-(\d{2})$/.exec(v)
  if (ym) {
    return new Date(`${v}-01T00:00:00`)
      .toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
  }
  return v.length > 12 ? v.slice(0, 12) + '…' : v
}

export function ReportBars({ rows, labelKey, valueKey, money, speed = 'report' }: {
  rows: any[]; labelKey: string; valueKey: string; money?: boolean
  speed?: keyof typeof DRAW
}) {
  const data = rows.slice(0, 14).map((r) => ({
    label: String(r[labelKey] ?? ''),
    value: Number(r[valueKey] ?? 0)
  }))
  const fmt = money ? axisMoney : axisCount

  return (
    <ResponsiveContainer width="100%" height={250}>
      {/*
        `barCategoryGap` is what fixes the spacing. Recharts defaults to 10% of
        the slot, which with fourteen wide slots left each bar marooned in the
        middle of its own space. 28% with a maximum width keeps them close
        enough to read as a series.
      */}
      <BarChart data={data} margin={{ top: 12, right: 10, left: 4, bottom: 4 }}
        barCategoryGap="28%">
        <defs><Gradient id="bar-fill" color="rgb(var(--c-primary))" from={1} to={0.55} /></defs>
        <CartesianGrid vertical={false} stroke="rgb(var(--c-divide))" strokeDasharray="3 3" />
        <XAxis dataKey="label" {...AXIS} interval={0} minTickGap={0}
          height={data.length > 8 ? 46 : 28}
          angle={data.length > 8 ? -35 : 0}
          textAnchor={data.length > 8 ? 'end' : 'middle'}
          tick={{ fontSize: 11 }}
          tickFormatter={axisLabel} />
        {/* Wide enough for the longest label this formatter can produce. */}
        <YAxis {...AXIS} width={money ? 52 : 40} tick={{ fontSize: 11 }}
          tickFormatter={fmt} />
        <Tooltip content={<ChartTooltip money={money} />}
          cursor={{ fill: 'rgb(var(--c-raised))', fillOpacity: 0.6 }} />
        <Bar dataKey="value" name="Value" fill="url(#bar-fill)" radius={[6, 6, 0, 0]}
          maxBarSize={46} animationDuration={DRAW[speed]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** A trend over time. Used on dashboards rather than in the report table. */
export function TrendArea({ data, xKey, series, money, speed = 'live' }: {
  data: any[]
  xKey: string
  series: { key: string; name: string; color: string }[]
  money?: boolean
  speed?: keyof typeof DRAW
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s) => <Gradient key={s.key} id={`g-${s.key}`} color={s.color} />)}
        </defs>
        <CartesianGrid vertical={false} stroke="rgb(var(--c-divide))" strokeDasharray="3 3" />
        <XAxis dataKey={xKey} {...AXIS} />
        <YAxis {...AXIS} width={money ? 62 : 44}
          tickFormatter={(v: number) => (money ? rs(v) : v.toLocaleString('en-PK'))} />
        <Tooltip content={<ChartTooltip money={money} />}
          cursor={{ fill: 'rgb(var(--c-raised))', fillOpacity: 0.6 }} />
        {/* Each series draws a little after the one before, so they arrive in order. */}
        {series.map((s, i) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.name}
            stroke={s.color} strokeWidth={i === 0 ? 3 : 2} fill={`url(#g-${s.key})`}
            animationDuration={DRAW[speed] + i * 200}
            activeDot={{ r: 5, strokeWidth: 3, stroke: 'rgb(var(--c-card))' }} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** A share of a whole. The hole is for a figure. */
export function Donut({ data, speed = 'live' }: {
  data: { name: string; value: number; color: string }[]
  speed?: keyof typeof DRAW
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <PieChart>
        <Tooltip content={<ChartTooltip />} />
        <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="92%"
          paddingAngle={3} cornerRadius={6} stroke="none" animationDuration={DRAW[speed]}>
          {data.map((s) => <Cell key={s.name} fill={s.color} />)}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  )
}

/** A miniature chart inside a card: no axes, no grid, no tooltip. */
export function Sparkline({ data, color = 'rgb(var(--c-primary))' }: {
  data: number[]; color?: string
}) {
  return (
    <ResponsiveContainer width="100%" height={40}>
      <BarChart data={data.map((v, i) => ({ i, v }))}>
        <Bar dataKey="v" fill={color} radius={[2, 2, 0, 0]} animationDuration={DRAW.live} />
      </BarChart>
    </ResponsiveContainer>
  )
}
