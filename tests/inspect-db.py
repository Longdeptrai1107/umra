import json
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
print('Types:', db.execute('SELECT type, COUNT(*) FROM events GROUP BY type').fetchall())
print('Methods:', db.execute('SELECT class_name,method_name,COUNT(*) FROM events GROUP BY class_name,method_name ORDER BY COUNT(*) DESC LIMIT 40').fetchall())
for row in db.execute("SELECT data FROM events WHERE type IN ('TRACE_WARNING','USER_INPUT','NETWORK_SEND','NETWORK_RECEIVE') ORDER BY seq LIMIT 40"):
    print(json.dumps(json.loads(row[0]), ensure_ascii=False))
