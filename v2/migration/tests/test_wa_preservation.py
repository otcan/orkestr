import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wa_preservation import assert_preserved


class Preservation(unittest.TestCase):
    def setUp(self):
        path=Path(__file__).resolve().parents[2]/'fixtures/migration-audit/wa-preservation/seven-holds.json'
        value=json.loads(path.read_text());self.source=value['source'];self.target=value['preserved']

    def test_seven_after_cutoff_with_sent_and_unknown_remain_dormant(self):
        self.assertTrue(all(r['created_at']>self.source['route_cutoff'] for r in self.source['inputs']))
        self.assertEqual(assert_preserved(self.source,self.target)['preserved_holds'],7)

    def test_mutations_refuse(self):
        def drop(t):t['holds'].pop()
        def sent_replay(t):t['holds'][0]['replay_policy']='retry'
        def queued(t):t['holds'][2]['state']='queued'
        def historical_loss(t):t['holds'][0]['provenance']['historical_effects'].pop()
        def cutoff_rewrite(t):t['holds'][0]['provenance']['created_at']=self.source['route_cutoff']
        def activate(t):t['automatic_reply_enabled']=True
        def personal(t):t['skill_only_routing_enabled']=True
        def invent_generation(t):t['holds'][6]['provenance']['source_route_generation']={'availability':'known','value':1}
        def duplicate(t):t['holds'][6]=copy.deepcopy(t['holds'][0])
        def lose_revision(t):t['holds'][0]['provenance']['hold']['source_revision']={'availability':'unknown','value':None}
        for mutation in (drop,sent_replay,queued,historical_loss,cutoff_rewrite,activate,personal,invent_generation,duplicate,lose_revision):
            with self.subTest(mutation=mutation.__name__):
                target=copy.deepcopy(self.target);mutation(target)
                with self.assertRaises(ValueError):assert_preserved(self.source,target)


if __name__=='__main__':unittest.main()
