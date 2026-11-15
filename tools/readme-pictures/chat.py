import sys, html
out = sys.argv[1]
esc = html.escape
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
W = 1000; X = 28; MAXW = W - 2 * X; CH = 6.15  # px per char at 12.5px, roughly
STY = {'i': 'font-style="italic" fill="#6b6b6b"', 'b': 'font-weight="700" fill="#2b2b2b"', 'n': 'fill="#6b6b6b"', 't': 'fill="#2b2b2b"'}
def line_segments(lead, quotas):
    segs = [(lead, 'i')]
    for dot, text in quotas:
        segs += [(f' · {dot} ', 'n'), (text, 'b')]
    return segs
def wrap(segs, width):
    # word-wrap styled segments into lines of (text, style)
    words = []
    for text, st in segs:
        for k, w in enumerate(text.split(' ')):
            words.append((w, st, k > 0 or (text.startswith(' '))))
    lines, cur, n = [], [], 0
    for w, st, space in words:
        add = (1 if (cur and space) else 0) + len(w)
        if cur and (n + add) * CH > width:
            lines.append(cur); cur, n = [], 0; space = False; add = len(w)
        cur.append(((' ' if (cur and space) else '') + w, st)); n += add
    if cur: lines.append(cur)
    return lines
parts = []; y = 0
parts.append('<rect x="0.5" y="0.5" width="WIDTH1" height="HEIGHT" rx="10" fill="#faf9f5" stroke="#d8d8d8"/>')
y = 30
def user(text):
    global y
    w = len(text) * 6.6 + 28
    parts.append(f'<rect x="{W - X - w:.0f}" y="{y - 18}" width="{w:.0f}" height="30" rx="14" fill="#ecebe6"/>')
    parts.append(f'<text x="{W - X - 14}" y="{y + 2}" text-anchor="end" font-family="{FONT}" font-size="13" fill="#2b2b2b">{esc(text)}</text>')
    y += 40
def para(segs, size=13, gap=19):
    global y
    for ln in wrap(segs, MAXW):
        spans = ''.join(f'<tspan {STY[st]}>{esc(t)}</tspan>' for t, st in ln)
        parts.append(f'<text x="{X}" y="{y}" font-family="{FONT}" font-size="{size}" xml:space="preserve">{spans}</text>')
        y += gap
    y += 10
user('Fix the login redirect bug')
para([("The redirect lost the original path when the session had expired. It is now kept in the sign-in link and restored after sign-in; a test covers it.", 't')])
para(line_segments('⏱ #1 · 09:50:05 → 09:51:16 · Claude 1m 11s — model wait 4.1s · thinking 11.2s · writing 14.8s · tools 38.5s (6 calls) · misc 2.8s · 1.52M in / 3.6k out',
     [('🟢', '5h +0.6% (8.6%)'), ('🟢', 'week +0.2% (41.2%)')]), size=12.5, gap=18)
para([('📅 Sun 01 Nov 2026: 18 interactions · was idle 1h 10m · user answering 4m 00s · Claude 38m 00s · efficiency 34% — model wait 11m 24s (30%) · thinking 5m 42s (15%) · writing 7m 36s (20%) · tools 7m 36s (20%) (108 calls) · subagents 1m 54s (5%) · misc 3m 48s (10%) · 4.50M in / 54k out', 'i')], size=12.5, gap=18)
y += 6
user('Commit it')
para([('Done: committed as 4f2a91c.', 't')])
para(line_segments('⏱ #5 · 10:01:37 → 10:01:52 · was idle 30.0s · Claude 15.5s — model wait 1.4s · thinking 2.1s · writing 3.9s · tools 6.2s (2 calls) · misc 1.9s · 760k in / 2.3k out',
     [('🟢', '5h +2% (14.4%)'), ('🟢', 'week +0.6% (43%)')]), size=12.5, gap=18)
H = int(y)
svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">' + ''.join(parts).replace('HEIGHT', str(H - 1)).replace('WIDTH1', str(W - 1)) + '</svg>'
open(out, 'w').write(svg); print(out, W, H)
