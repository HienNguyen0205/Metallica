"""Identity plumbing (P3): who owns a run, and who is asking.

This is deliberately *plumbing*, not authentication: there is no login
system, so unattributed requests are anonymous and session_id remains the
working boundary for them. What this step establishes:

- UserIdentity: user_id (or None), session_id, tenant_id (reserved).
- Runs record owner_user_id at creation; run endpoints enforce ownership:
  identified-owned runs refuse mismatched callers (403), anonymous-owned
  runs behave exactly as before.
- Identity headers are honored only when FRIDAY_TRUST_IDENTITY_HEADERS is
  true — blindly trusting a client header without a proxy stripping it
  would let anyone be anyone. Default: off, everyone anonymous.

Real authentication (login, API keys) arrives later; it will fill
resolve_identity() instead of spreading conditionals through the routes.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class UserIdentity:
    user_id: str | None = None
    session_id: str | None = None
    tenant_id: str | None = None

    @property
    def actor(self) -> str:
        """Stable audit attribution: the user when known, else the session,
        else the string 'anonymous' — never None, so logs stay greppable."""
        return self.user_id or self.session_id or "anonymous"


def resolve_identity(session_id: str | None = None,
                     user_id_header: str | None = None,
                     trust_headers: bool = False) -> UserIdentity:
    """Build the caller identity. The header counts only in trust mode."""
    user_id = (user_id_header or "").strip() or None
    if not trust_headers:
        user_id = None
    return UserIdentity(user_id=user_id, session_id=session_id)


def may_access(run_owner: str | None, caller: UserIdentity) -> bool:
    """Ownership gate for run endpoints. Anonymous-owned runs keep today's
    behavior; identified-owned runs refuse anyone else (including anonymous)."""
    if run_owner is None:
        return True
    return caller.user_id is not None and caller.user_id == run_owner
