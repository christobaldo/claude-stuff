// The Session Monitor's charts as SVG text: a donut with a legend, and a
// quota gauge. Each draws in light and dark. Pointing at a slice, or at its
// legend row, thickens the slice, fades the others and highlights the row.

export const COLORS = {
  claude: '#d97757',
  answering: '#d9534f',
  idle: '#8a8a8a',
  modelWait: '#d4709f',
  thinking: '#a77bca',
  writing: '#e3a857',
  tools: '#4f9dde',
  subagents: '#3fb8af',
  misc: '#c8c8c8',
} as const

// Experiment: greys for the parts of misc.
export const MISC_SHADES = ['#b0b0b0', '#c8c8c8', '#9c9c9c', '#dadada', '#858585']

const STYLE =
  '<style>.t{fill:#333;font:11px -apple-system,system-ui,sans-serif}.b{font-weight:600;font-size:15px}' +
  '.c{font-weight:600;font-size:12px}.track{stroke:#e4e4e4}.arc{transition:opacity .1s,stroke-width .1s}' +
  '.hl{opacity:0}.row{cursor:default}' +
  '@media (prefers-color-scheme:dark){.t{fill:#e6e6e6}.track{stroke:#444}}</style>'

// The donut's hole is about 50px wide: a longer center text gets a smaller font.
const centerSizeOf = (text: string) => {
  const size = Math.min(15, Math.floor(50 / (text.length * 0.6)))
  return size < 15 ? ` style="font-size:${size}px"` : ''
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// `aside`: its legend row goes in a second column, so a long legend stays short.
export type Slice = { name: string; ms: number; label: string; color: string; aside?: boolean }

// A donut of the slices' shares with the center text inside, and beside it
// the caption over one legend row per slice, in one or two columns.
export const donutOf = (chart: { center: string; caption: string; slices: readonly Slice[] }) => {
  const r = 34
  const around = 2 * Math.PI * r
  const all = chart.slices.reduce((ms, slice) => ms + slice.ms, 0)
  const shareOf = (slice: Slice) => (all > 0 ? Math.round((slice.ms / all) * 100) : 0)
  const rowOf = (slice: Slice) => `${slice.name} ${shareOf(slice)}% · ${slice.label}`
  // Each column as wide as its longest row, at about 6.4px a character.
  const columnOf = (aside: boolean) => chart.slices.filter(slice => (slice.aside === true) === aside)
  const widthOf = (rows: readonly Slice[]) => Math.ceil(24 + Math.max(...rows.map(slice => rowOf(slice).length), 0) * 6.4)
  const main = columnOf(false)
  const side = columnOf(true)
  const sideX = 100 + widthOf(main) + 12
  const width = Math.max(290, side.length > 0 ? sideX + widthOf(side) : 100 + widthOf(main))
  const height = Math.max(96, 30 + Math.max(main.length, side.length) * 16)
  // The arcs, then the legend rows after them in the same group: `.aN:hover
  // ~ .lN` reaches a row from its slice, `:has(.lN:hover)` a slice from its row.
  let offset = 0
  const arcs = chart.slices
    .map((slice, i) => {
      const length = all > 0 ? (slice.ms / all) * around : 0
      const arc =
        `<circle class="arc a${i}" cx="48" cy="48" r="${r}" fill="none" stroke="${slice.color}" stroke-width="14" ` +
        `stroke-dasharray="${length.toFixed(2)} ${(around - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" ` +
        `transform="rotate(-90 48 48)"/>`
      offset += length
      return arc
    })
    .join('')
  const legend = chart.slices
    .map((slice, i) => {
      const aside = slice.aside === true
      const x = aside ? sideX : 100
      const y = 34 + (aside ? side : main).indexOf(slice) * 16
      return (
        `<g class="row l${i}"><rect class="hl" x="${x}" y="${y - 12}" width="${widthOf(aside ? side : main) - 2}" ` +
        `height="16" rx="4" fill="${slice.color}" fill-opacity="0.22"/>` +
        `<rect x="${x + 4}" y="${y - 9}" width="10" height="10" rx="2" fill="${slice.color}"/>` +
        `<text class="t" x="${x + 20}" y="${y}">${escape(rowOf(slice))}</text></g>`
      )
    })
    .join('')
  const focus = chart.slices
    .map(
      (_, i) =>
        `.d:has(.a${i}:hover) .arc:not(.a${i}),.d:has(.l${i}:hover) .arc:not(.a${i}){opacity:.3}` +
        `.d:has(.l${i}:hover) .a${i},.a${i}:hover{stroke-width:19}` +
        `.a${i}:hover~.l${i} .hl,.l${i}:hover .hl{opacity:1}.a${i}:hover~.l${i} text,.l${i}:hover text{font-weight:600}`,
    )
    .join('')
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${STYLE}` +
    `<style>${focus}</style><circle class="track" cx="48" cy="48" r="${r}" fill="none" stroke-width="14"/>` +
    `<text class="t b" x="48" y="53" text-anchor="middle"${centerSizeOf(chart.center)}>${escape(chart.center)}</text>` +
    `<text class="t c" x="104" y="14">${escape(chart.caption)}</text><g class="d">${arcs}${legend}</g></svg>`
  return { source, width, height }
}

export const SIGNALS = { green: '#59b37a', amber: '#e3a857', red: '#d9534f' } as const

// A half-circle gauge of a percentage, green to amber to red as it fills,
// unless the chart gives its colour; its center text the percentage, unless
// the chart gives its own, shrunk to fit.
export const gaugeOf = (chart: { percent: number; caption: string; note: string; color?: string; center?: string }) => {
  const width = 150
  const height = 110
  const percent = Math.max(0, Math.min(100, chart.percent))
  const color = chart.color ?? (percent < 50 ? SIGNALS.green : percent < 80 ? SIGNALS.amber : SIGNALS.red)
  const arc = 'M 25 70 A 50 50 0 0 1 125 70'
  const shown = chart.center ?? `${Math.round(chart.percent * 10) / 10}%`
  const size = Math.min(15, Math.floor(84 / (shown.length * 0.6)))
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${STYLE}` +
    `<path class="track" d="${arc}" fill="none" stroke-width="12" stroke-linecap="round"/>` +
    `<path d="${arc}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round" pathLength="100" ` +
    `stroke-dasharray="${percent} 100"/>` +
    `<text class="t b" x="75" y="66" text-anchor="middle"${size < 15 ? ` style="font-size:${size}px"` : ''}>${escape(shown)}</text>` +
    `<text class="t" x="75" y="93" text-anchor="middle">${escape(chart.caption)}</text>` +
    `<text class="t" x="75" y="105" text-anchor="middle" opacity="0.7">${escape(chart.note)}</text></svg>`
  return { source, width, height }
}
