'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface CompetitorChartRow {
  name: string;
  /** null = not scored. A missing bar is never drawn as zero. */
  visibility: number | null;
  sentiment: number | null;
}

/**
 * Grouped bars, one axis (both measures are 0 to 100). Colours identify the measure, not the
 * brand: blue and orange are the first two steps of a colour-blind-checked categorical palette.
 */
export function CompetitorChart({ rows }: { rows: CompetitorChartRow[] }) {
  return (
    <div className="ui h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} barGap={2} barCategoryGap="26%" margin={{ top: 4, right: 8, bottom: 4, left: -18 }}>
          <CartesianGrid vertical={false} stroke="#e4e8ee" />
          <XAxis dataKey="name" tickLine={false} axisLine={{ stroke: '#c4cbd7' }} tick={{ fill: '#435066', fontSize: 12 }} interval={0} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickLine={false} axisLine={false} tick={{ fill: '#64708a', fontSize: 12 }} />
          <Tooltip cursor={{ fill: 'rgba(16, 27, 45, 0.05)' }} />
          <Legend
            verticalAlign="top"
            align="left"
            iconType="square"
            wrapperStyle={{ fontSize: 13, paddingBottom: 12 }}
            formatter={(value) => <span style={{ color: '#101b2d' }}>{String(value)}</span>}
          />
          <Bar dataKey="visibility" name="Gemini API recommendation visibility" fill="#2a78d6" radius={[4, 4, 0, 0]} maxBarSize={28} />
          <Bar dataKey="sentiment" name="Audience sentiment" fill="#eb6834" radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
