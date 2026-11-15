import json, re, sys, html
S = sys.argv[1]; out = sys.argv[2]
d = json.load(open(f'{S}/illus.json')); gauges = json.load(open(f'{S}/gauges.json'))
T = [t for t in d['texts']]
def strip(src):
    src = re.sub(r'@media \(prefers-color-scheme:dark\)\{[^}]*\{[^}]*\}[^}]*\{[^}]*\}\}', '', src)
    return src
def nested(src, x, y):
    return re.sub(r'^<svg ', f'<svg x="{x}" y="{y}" ', strip(src), count=1)
esc = html.escape
W = 1100
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
parts = []
y = 0
# window frame
parts.append('<rect x="0.5" y="0.5" width="WIDTH1" height="HEIGHT" rx="10" fill="#ffffff" stroke="#d8d8d8"/>')
parts.append('<rect x="0.5" y="0.5" width="WIDTH1" height="34" rx="10" fill="#f4f3ef"/><rect x="0.5" y="24" width="WIDTH1" height="11" fill="#f4f3ef"/>')
parts.append(f'<text x="18" y="22" font-family="{FONT}" font-size="13" font-weight="600" fill="#333">Session Monitor</text>')
parts.append(f'<text x="WIDTH18" y="22" text-anchor="end" font-family="{FONT}" font-size="12" fill="#888">/session-monitor</text>')
y = 62
svgs = d['svgs']; gauges = svgs[:6]; donuts = svgs[6:8]
# the two quota rows side by side
qx = 22
for row in range(2):
    name, about = T[row*2]['text'], T[row*2+1]['text']
    parts.append(f'<text x="{qx}" y="{y}" font-family="{FONT}" font-size="12" font-weight="600" fill="#333">{esc(name)}</text>')
    parts.append(f'<text x="{qx + 8 + len(name)*7.2:.0f}" y="{y}" font-family="{FONT}" font-size="12" fill="#888">{esc(about)}</text>')
    gx = qx
    for g in gauges[row*3:row*3+3]:
        parts.append(nested(g['source'], gx, y + 6)); gx += g['width'] + 12
    qx = max(gx + 40, qx + 8 + len(name)*7.2 + len(about)*6.6 + 40)
y += 6 + max(g['height'] for g in gauges) + 24
parts.append(f'<text x="22" y="{y}" font-family="{FONT}" font-size="12" font-weight="600" fill="#333">{esc(T[4]["text"])}</text>')
y += 18
parts.append(f'<text x="22" y="{y}" font-family="{FONT}" font-size="12" fill="#777">{esc(T[5]["text"])}</text>')
y += 12
x = 22
for sv in donuts:
    parts.append(nested(sv['source'], x, y)); x += sv['width'] + 30
y += max(sv['height'] for sv in donuts) + 30
def finish(parts, W, H, path):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">' + ''.join(parts).replace('HEIGHT', str(H - 1)).replace('WIDTH18', str(W - 18)).replace('WIDTH1', str(W - 1)) + '</svg>'
    open(path, 'w').write(svg)
    print(path, W, H)
topW = int(max(gx for gx in [qx]) - 18)
finish(parts, topW, y - 10, out)
# the history, a card of its own
parts = ['<rect x="0.5" y="0.5" width="WIDTH1" height="HEIGHT" rx="10" fill="#ffffff" stroke="#d8d8d8"/>']
y = 28
hist = next(i for i,t in enumerate(T) if t['text'] == 'This session history')
parts.append(f'<text x="22" y="{y}" font-family="{FONT}" font-size="12" font-weight="600" fill="#333">{esc(T[hist]["text"])}</text>')
y += 20
# table
i = hist + 1
rows = []
rows.append(('header', [t['text'] for t in T[i:i+21]], None, {})); i += 21
rows.append(('header', [t['text'] for t in T[i:i+21]], None, {})); i += 21
i += 1  # spacer
while i + 22 <= len(T):
    chunk = T[i:i+22]
    rows.append(('row', [t['text'] for t in chunk[:21]], chunk[21]['text'], {'bold': bool(chunk[1]['bold']) , 'dim': bool(chunk[0]['dim'])})); i += 22
cells = [[c for c in r[1] if c != '│'] for r in rows]
ncol = 18
widths = [max(len(c[k]) for c in cells) for k in range(ncol)]
CW = 7.0  # px per char at 11.5px mono
groups = [6, 7, 5]
COLORS = {4: '#8a8a8a', 5: '#d9534f'}
def colour(k):
    if k in COLORS: return COLORS[k]
    if 6 <= k < 13: return '#c96442'
    return '#333'
for r_i, (kind, raw, after, st) in enumerate(rows):
    c = [x for x in raw if x != '│']
    xx = 22; k = 0
    for g_i, n in enumerate(groups):
        if g_i > 0:
            parts.append(f'<text x="{xx}" y="{y}" font-family="{MONO}" font-size="11.5" fill="#c4c4c4">│</text>'); xx += 2 * CW
        for _ in range(n):
            w = widths[k] * CW
            bold = kind == 'header' or st.get('bold') or k == 6
            op = ' fill-opacity="0.62"' if st.get('dim') else ''
            parts.append(f'<text x="{xx + w:.1f}" y="{y}" text-anchor="end" font-family="{MONO}" font-size="11.5"{" font-weight=\"700\"" if bold else ""} fill="{colour(k)}"{op}>{esc(c[k])}</text>')
            xx += w + CW; k += 1
    parts.append(f'<text x="{xx}" y="{y}" font-family="{MONO}" font-size="11.5" fill="#c4c4c4">│</text>'); xx += 2 * CW
    if after and len(after) > 44: after = after[:43].rstrip(' ·') + '…'
    if after:
        op = ' fill-opacity="0.62"' if st.get('dim') else ''
        parts.append(f'<text x="{xx}" y="{y}" font-family="{FONT}" font-size="12"{" font-weight=\"600\"" if st.get("bold") else ""} fill="#333"{op}>{esc(after)}</text>')
    tablew = max(globals().get('tablew', 0), xx + (len(after) * 6.4 if after else 0))
    y += 18 if not (kind == 'header' and r_i == 1) else 26
W = int(tablew + 24)
finish(parts, W, y + 4, out.replace('.svg', '-history.svg'))
