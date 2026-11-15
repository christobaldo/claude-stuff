# Made-up morning for the README pictures: five interactions, with quota readings.
import json, datetime
base = int(datetime.datetime(2026,11,2,9,50,5).timestamp()*1000)
rows = [
 # label, idle, answering, wait, think, write, tool, sub, misc, calls
 ('Fix the login redirect bug',      0,     0, 4100, 11200, 14800, 38500,     0, 2800, 6),
 ('Add a test for it',           95000,     0, 2600,  4100, 19700, 26400,     0, 2100, 4),
 ('Review the whole module',    240000,     0, 5200, 16900,  9800, 12300, 41200, 5400, 3),
 ('Pick an option and apply it', 60000, 14200, 3100,  6400,  8800, 15100,     0, 2400, 3),
]
keys = ['modelWaitMs','thinkingMs','writingMs','toolMs','subagentMs','answeringMs','toolCalls','idleMs','inTokens','outTokens','cachedTokens']
t = base; inter = []; q5 = 8.0; wk = 41.0
day = dict(turns=0, wallMs=0, **{k: 0 for k in keys})
for i, (label, idle, ans, w, th, wr, tool, sub, misc, calls) in enumerate(rows):
    t += idle
    wall = ans + w + th + wr + tool + sub + misc
    mv5 = round(0.6 + i * 0.35, 1); mvw = round(0.2 + 0.1 * i, 1)
    one = dict(id=f't{i}', dayId=base, n=i + 1, label=label, start=t, end=t + wall,
      modelWaitMs=w, thinkingMs=th, writingMs=wr, toolMs=tool, subagentMs=sub, answeringMs=ans,
      toolCalls=calls + (9 if sub else 0), idleMs=idle,
      inTokens=(calls + 2) * 190000, outTokens=1800 + wr // 8, cachedTokens=(calls + 2) * 176000,
      quotaStart=dict(fiveHour=dict(percent=q5), week=dict(percent=wk)),
      quotaEnd=dict(fiveHour=dict(percent=round(q5 + mv5, 1)), week=dict(percent=round(wk + mvw, 1))))
    q5 = round(q5 + mv5, 1); wk = round(wk + mvw, 1)
    inter.append(one); t += wall
    day['turns'] += 1; day['wallMs'] += wall
    for k in keys: day[k] += one[k]
d = dict(day, id=base, date='2026-11-02', startedAt=base, manual=False, started=4, firstStart=base, lastEnd=t, stoppedAt=None)
now = t + 30_000
snap = dict(v=1, interactions=inter, days=[d], clock=dict(mode='active', idleFrom=t, banked=0), lines=[])
# A reading a minute: the 5h quota over the last 70 minutes, the week over the last 25 hours.
readings = []
for m in range(25 * 60, -1, -10):
    at = now - m * 60_000
    one = dict(at=at, week=round(wk - 2.4 + (25 * 60 - m) / (25 * 60) * 2.4, 1))
    if m <= 70: one['fiveHour'] = round(max(0, q5 - 4.5) + (70 - m) / 70 * 4.5, 1)
    readings.append(one)
print(json.dumps({'session:session-1': snap, 'readings': readings, 'q5': q5, 'wk': wk, 'now': now}, separators=(',', ':')))
