"""Trusted callback-only selected subscription binding; never dispatch authority."""
import secrets
from .claude_selected import SelectedAccount


class SelectedSubscription:
    """Pin server-private account identity/revision, reread immediately before launch.

    Resolver owns the canonical credential store. No paths, environment fallback,
    refresh token, login or provider request are implemented in this boundary.
    """
    __slots__=('_profile','_identity','_resolve')

    def __init__(self, profile, identity, resolve):
        if not isinstance(identity,dict) or set(identity)!={'owner_id','account_id','credential_revision'}:
            raise ValueError('selected subscription identity required')
        if not all(isinstance(identity[key],str) and 0<len(identity[key])<=256
                   for key in ('owner_id','account_id')):
            raise ValueError('selected subscription identity required')
        if type(identity['credential_revision']) is not int or identity['credential_revision']<0:
            raise ValueError('selected subscription revision required')
        if not callable(resolve):raise ValueError('private resolver required')
        self._profile,self._identity,self._resolve=profile,dict(identity),resolve

    def __reduce__(self):raise TypeError('private subscription binding')
    def __copy__(self):raise TypeError('private subscription binding')
    def __deepcopy__(self,memo):raise TypeError('private subscription binding')

    def _current(self):
        try:
            current=self._resolve()
            expected={**self._identity,'provider':'claude-code','auth_mode':'subscription',
                      'authentication_method':'subscription_token','state':'ready'}
            if not isinstance(current,dict) or set(current)!=set(expected)|{'token'}:
                raise ValueError()
            if any(type(current[key]) is not type(value) or current[key]!=value
                   for key,value in expected.items()):raise ValueError()
            token=current['token']
            if not isinstance(token,str) or not 0<len(token.encode())<=16384 or '\0' in token or '\n' in token:
                raise ValueError()
            return token
        except Exception:
            # Resolver exceptions may contain canonical paths or account details.
            raise ValueError('selected subscription unavailable or changed') from None

    def acquire(self):
        token=self._current()
        def check():
            if not secrets.compare_digest(self._current().encode(),token.encode()):
                raise ValueError('selected subscription changed')
        return SelectedAccount(self._profile,lambda:{'CLAUDE_CODE_OAUTH_TOKEN':token},_check=check)
