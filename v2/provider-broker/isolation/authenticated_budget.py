"""Trusted authenticated-only budgets; offline policy defaults remain strict."""
from dataclasses import dataclass


@dataclass(frozen=True)
class AuthenticatedBudget:
    cpu_seconds: int = 600
    address_bytes: int = 8*1024**3
    file_bytes: int = 256*1024**2
    descriptors: int = 256
    tunnel_seconds: int = 900
    tunnel_bytes: int = 64*1024**2
    connections: int = 4


AUTHENTICATED = AuthenticatedBudget()
