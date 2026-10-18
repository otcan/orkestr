"""Fail closed on accidental privileged imports at the shared crate boundaries."""
from pathlib import Path
import tomllib

root = Path(__file__).resolve().parents[1]
allowed = {
    "orkestr-domain": {"serde"},
    "contracts": {"serde", "uuid"},
    "application": {"orkestr-v2-contracts"},
}
for crate, dependencies in allowed.items():
    manifest = tomllib.loads((root / "crates" / crate / "Cargo.toml").read_text())
    actual = set(manifest.get("dependencies", {}))
    assert actual <= dependencies, f"{crate}: privileged dependency {actual - dependencies}"
    assert not manifest.get("target"), f"{crate}: review target-specific dependencies explicitly"
print("3 crate dependency boundaries passed")
