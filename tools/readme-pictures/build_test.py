# Writes the illustration test: the mod's test helpers, then the body with the seed filled in.
import json, sys
helpers, template, seed, out = sys.argv[1:]
d = json.load(open(seed))
src = open(helpers).read()
head = src[:src.index("\ntest(")]
body = open(template).read()
stored = {k: d[k] for k in ('session:session-1', 'readings')}
for key, value in [('@@Q5END@@', round(d['q5'] + 2, 1)), ('@@WKEND@@', round(d['wk'] + 0.6, 1)),
                   ('@@Q5@@', d['q5']), ('@@WK@@', d['wk']), ('@@NOW@@', d['now']), ('@@STORED@@', json.dumps(stored))]:
    body = body.replace(key, str(value))
open(out, 'w').write(head + body)
