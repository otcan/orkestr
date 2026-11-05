"""Root-only read-only Fast observer plus an exact-input Core completion join.

The Core response must come from the protected authenticated lookup adapter.
These diagnostic witnesses cannot authorize inference, Root actions or replay.
"""
import hashlib
import os
from pathlib import Path
import stat
import time
from codex_bounded.trust import digest,metadata,protected,Refused as CustodyRefused
from .contract import require,Refused
from . import fast_sample_evidence as evidence
from . import fast_sample_kernel as kernel


def capture(package,fast_receipt,output_directory):
    try:
        require(os.geteuid()==0 and package.identity_split,'fast_sampler_root_split_required')
        scope=evidence.scope(fast_receipt)
        require(scope['owner_id']==package.owner,'fast_sampler_owner')
        directory=protected(package.ledger_directory/'launches',True)
        paths=list(directory.glob('*.json'));require(len(paths)<=8192,'fast_journal_bound')
        matching=[]
        for path in paths:
            require(stat.S_IMODE(protected(path).stat().st_mode)==0o600,'fast_journal_private')
            claim=metadata(path,32768)
            if kernel.matches(claim,scope) and claim.get('state')=='spawned':matching.append((path,claim))
        require(len(matching)==1,'fast_live_launch_not_unique')
        path,claim=matching[0];observation=kernel.observe(package,path,claim)
        value={'format':evidence.FORMAT,'live_observed':True,'observed_at_ms':time.time_ns()//1000000,
            'package_root':str(package.root),'package_manifest_sha256':digest(protected(package.root/'manifest.json')),
            'core_scope':scope,'launch':{'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                'identity':kernel.claim_identity(claim)},**observation}
        output=evidence.publish(output_directory,value)
        return evidence.summary(output)
    except (Refused,CustodyRefused,OSError,ValueError,KeyError,TypeError):
        return {'status':'unknown','reason':'fast_live_custody_not_proven'}


def verify(receipt_path,completed_fast_receipt,package=None):
    try:
        require(os.geteuid()==0,'fast_sampler_root_required')
        scope=evidence.scope(completed_fast_receipt);value=evidence.read(Path(receipt_path))
        require(value['core_scope']==scope,'fast_completed_scope_changed')
        require(completed_fast_receipt['state']=='succeeded' and completed_fast_receipt['acceptance_event_id'] is not None,
                'fast_core_acceptance_missing')
        require(value['launch']['identity']['setup']['role']=='fast'
                and value['observed_native_process']['metadata_only'] is True,'fast_witness_scope')
        result={'status':'diagnostic','package_bound':False,'core_accepted':True,
                'core_scope':scope,'acceptance_event_id':completed_fast_receipt['acceptance_event_id'],
                'receipt_path':str(receipt_path),'receipt_sha256':evidence.summary(receipt_path)['receipt_sha256'],
                'original_native_pid_registered':False,'native_pid_claim':None,
                'observed_process_tree_and_root_io':True,'external_effects_proven':False}
        if package is None:return result
        require(package.identity_split and scope['owner_id']==package.owner
            and value['package_root']==str(protected(package.root,True))
            and value['package_manifest_sha256']==digest(protected(package.root/'manifest.json')),
            'fast_current_package_changed')
        result['current_core_listener']=kernel.current(package,value)
        result.update(status='accepted',package_bound=True,
            package_root=value['package_root'],package_manifest_sha256=value['package_manifest_sha256'])
        return result
    except (Refused,CustodyRefused,OSError,ValueError,KeyError,TypeError):
        return {'status':'unknown','reason':'fast_completed_custody_not_proven'}
