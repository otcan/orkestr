"""Closed operator-only managed Claude profile; no real paths or accounts."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from selected import claude


class ManagedClaudePlanTests(unittest.TestCase):
    def plan(self):
        value={key:'/srv/synthetic-claude/'+key for key in
               ('executable','account','workspace','home','temporary')}
        value['managed_host']={'environment':{'HOME':value['home'],'PATH':'/usr/bin:/bin'}}
        return {'authority_uid':20000,'claude':value}

    def test_explicit_managed_profile_needs_split_and_never_aliases_legacy_root_mode(self):
        plan=self.plan();self.assertEqual(claude(plan),plan['claude'])
        plan.pop('authority_uid')
        with self.assertRaises(RuntimeError):claude(plan)
        plan=self.plan();plan['host_full_access']={'environment':plan['claude']['managed_host']['environment']}
        with self.assertRaises(RuntimeError):claude(plan)
        plan=self.plan();plan['claude']['fast']=True
        with self.assertRaises(RuntimeError):claude(plan)

    def test_fixed_environment_cannot_change_home_or_select_an_account(self):
        for key,value in [('HOME','/other'),('CLAUDE_CODE_OAUTH_TOKEN','synthetic'),
                          ('ANTHROPIC_API_KEY','synthetic')]:
            plan=self.plan();plan['claude']['managed_host']['environment'][key]=value
            with self.assertRaises(RuntimeError):claude(plan)

if __name__=='__main__':unittest.main()
