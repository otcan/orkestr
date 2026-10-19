import json
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from current_activity import recent_messages, QUERY, INDEX


class CurrentActivity(unittest.TestCase):
    def test_recent_beyond_old_prefix_and_binary_classification(self):
        with tempfile.TemporaryDirectory() as home:
            path = Path(home)/'messages.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE orkestr_thread_messages(thread_id,source,connector TEXT COLLATE NOCASE,role,state,created_at,data,position)')
                db.execute(f'CREATE INDEX {INDEX} ON orkestr_thread_messages(thread_id,source,connector,role,state,created_at,position)')
                row = ('fake-thread',None,None,'assistant',None,'2020-01-01T00:00:00.000Z','{}')
                db.executemany('INSERT INTO orkestr_thread_messages VALUES(?,?,?,?,?,?,?,?)', [(*row,i) for i in range(10001)])
                for i,connector in enumerate(('whatsapp','WHATSAPP')):
                    db.execute('INSERT INTO orkestr_thread_messages VALUES(?,?,?,?,?,?,?,?)',('fake-thread',None,connector,'user',None,'2026-10-19T10:00:00.000Z',json.dumps({'attachments':[{'fake':True}]}),10002+i))
                plans = db.execute('EXPLAIN QUERY PLAN '+QUERY, ('2026-09-19','2026-10-20','2026-10-18')).fetchall()
                self.assertTrue(any('created_at>?' in r[3] and 'created_at<?' in r[3] for r in plans))
            result = recent_messages(path,datetime(2026,10,19,12,tzinfo=timezone.utc))
            self.assertEqual(result['counts'],dict(within_30d=2,within_24h=2,whatsapp_30d=1,owner_user_30d=2,assistant_30d=0,attachment_messages_30d=2))

    def test_missing_index_and_symlink_refused(self):
        with tempfile.TemporaryDirectory() as home:
            path=Path(home)/'source.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE orkestr_thread_messages(data)')
            now=datetime.now(timezone.utc)
            with self.assertRaises(ValueError): recent_messages(path,now)
            link=Path(home)/'link'; link.symlink_to(path)
            with self.assertRaises(ValueError): recent_messages(link,now)

if __name__ == '__main__': unittest.main()
