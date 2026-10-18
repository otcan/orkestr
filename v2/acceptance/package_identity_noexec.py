import os
import sys
from pathlib import Path
from unittest.mock import patch
review_root = Path(os.environ['ORKESTR_V2_REVIEW_SOURCE_ROOT'])
sys.path.insert(0,str(review_root/'v2/packaging/candidate/tests'))
from test_candidate import CandidateTests, package, receipt
case=CandidateTests();case.setUp()
try:
    with patch('subprocess.Popen',side_effect=AssertionError('artifact verification must not execute')):
        case.assemble()
        package.verify(case.root/'candidate')
        receipt.verify(case.value,case.binary,case.ui)
        for field,value in [('version','2.0.0-dev'),('source_commit','b'*40)]:
            forged=dict(case.value);forged[field]=value
            try: receipt.verify(forged,case.binary,case.ui)
            except RuntimeError: pass
            else: raise AssertionError('relabel accepted')
    print('PASS: full synthetic assembly/verification and relabel refusals with every Popen forbidden')
finally: case.doCleanups()
