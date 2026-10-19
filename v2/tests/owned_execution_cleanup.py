"""A failed identity oracle must still stop its own ordinary server process."""
from owned_execution_http import Case


case = Case()
try:
    case.start()  # default disabled: no provider or credentials
    process = case.process
    root = case.root
    def refused_identity():
        raise AssertionError("synthetic identity observation failure")
    case.trace = refused_identity
    try:
        case.cleanup()
    except AssertionError as error:
        assert str(error) == "synthetic identity observation failure"
    else:
        raise AssertionError("cleanup must preserve the failed identity gate")
    assert process.poll() is not None, "own server must be waited even when identity capture fails"
    assert case.process is None
    assert not root.exists(), "failed test must clean its disposable installation"
finally:
    case.trace = lambda: []
    case.cleanup()
print("cleanup assertion and process ownership preserved", flush=True)
