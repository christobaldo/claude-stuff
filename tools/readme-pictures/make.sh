#!/bin/sh
# Redraws the README pictures in docs/ from the mod as it is: made-up data,
# the pane drawn by the test kit, then laid out as SVG.
set -e
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/../.." && pwd); mod=$repo/mods/session-monitor
work=$(mktemp -d)
python3 "$here/snapshot.py" > "$work/seed.json"
python3 "$here/build_test.py" "$mod/tests/session-monitor.test.tsx" "$here/illustration.test.tsx.in" "$work/seed.json" "$mod/tests/zz-illustration.test.tsx"
(cd "$repo/mods" && claude plugin test session-monitor > "$work/illus.out" 2>&1) || true
rm -f "$mod/tests/zz-illustration.test.tsx"
python3 -c "
import json,sys;t=open(sys.argv[1]).read();j=t[t.index('@@ILLUSTRATION@@')+16:];json.dump(json.JSONDecoder().raw_decode(j)[0],open(sys.argv[2],'w'))" "$work/illus.out" "$work/illus.json"
echo '[]' > "$work/gauges.json"
python3 "$here/compose.py" "$work" "$repo/docs/session-monitor.svg"
python3 "$here/chat.py" "$repo/docs/session-monitor-chat.svg"
rm -rf "$work"
