"""Stopped successor-package restore checkpoint; never activates copied auth."""
from contextlib import closing
import sqlite3

from real_package import invoke, require, sha256
from recovery import validate_snapshot


def exercise(entry, package, source, root, port, old_snapshot, expected_versions):
    snapshot=root/'successor-snapshot'
    invoke(entry,'backup',source,'--output',snapshot)
    _,manifest=validate_snapshot(snapshot)
    digest=manifest['files']['core.sqlite3']
    with closing(sqlite3.connect((snapshot/'core.sqlite3').as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
        actual=[r[0] for r in db.execute('SELECT version FROM _sqlx_migrations WHERE success ORDER BY version')]
        require(actual==expected_versions,'successor restore snapshot migration inventory differs')
    target=root/'successor-dormant'
    invoke(entry,'install',target,'--package',package,'--port',port)
    retained={name:sha256(target/name) for name in ('install.json','control/bootstrap.token')}
    # Raw cross-package auth import stays forbidden. Rejection must leave an empty target.
    rejected=invoke(entry,'restore-apply',target,'--snapshot',old_snapshot,expected=1)
    require('same exact package' in rejected.stderr,'cross-package restore did not explicitly refuse')
    require(not list((target/'data').iterdir()) and not (target/'control/restore-dormant.json').exists(),
            'cross-package refusal mutated dormant target')
    invoke(entry,'restore-apply',target,'--snapshot',snapshot)
    require(sha256(target/'data/core.sqlite3')==digest,'successor dormant copy differs from snapshot')
    marker=sha256(target/'control/restore-dormant.json')
    rejected=invoke(entry,'start',target,expected=1)
    require('dormant' in rejected.stderr,'restored auth activation not refused')
    require(sha256(target/'control/restore-dormant.json')==marker and sha256(target/'data/core.sqlite3')==digest,
            'refused activation mutated dormant restore')
    invoke(entry,'restore-rollback',target)
    require(not list((target/'data').iterdir()) and not (target/'control/restore-dormant.json').exists(),
            'dormant rollback did not recover empty target')
    require({name:sha256(target/name) for name in retained}==retained,'restore changed target configuration/bootstrap')
    require(sha256(snapshot/'core.sqlite3')==digest,'successor snapshot changed')
    return {'scope':'stopped same-package dormant apply only; no activation or cross-version import',
            'snapshot_sha256':digest,'schema_versions':actual,'cross_package_restore_refused':True,
            'dormant_activation_refused':True,'rollback_empty':True,'target_configuration_preserved':True}
