"""Provider descriptors — placeholder for future multi-provider routing."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    model: str
