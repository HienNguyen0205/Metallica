"""§15 memory — the short-term half, and deliberately only that.

The doc lists PostgreSQL, Redis, a vector DB and object storage behind five
kinds of memory. None of that is here, because none of it is needed to fix the
thing that is actually broken: every question is currently answered with no
knowledge that the previous one happened, so "and the disk?" means nothing.

What this is: the last few exchanges per session, in the orchestrator's own
process, replayed into the next prompt. What it is not: durable, shared between
workers, or searchable. Those matter at a scale this does not have — and the
approvals in `api/dependencies.py` already pin the service to one process, so
process-local state changes no deployment constraint.

Only the final text of each turn is kept. Replaying `tool_calls` would oblige us
to replay every matching tool result alongside them or the provider rejects the
message list, and a half-replayed tool exchange is a subtly broken prompt rather
than a loud error. Tool output is re-fetched by the next turn if it is needed,
which is also the only way the numbers stay current.
"""

from collections import OrderedDict, deque

#: Exchanges replayed into the next prompt. Each one costs tokens on every
#: subsequent turn, and the free tier's binding limit is requests, not context —
#: but a long tail of stale context makes the model answer the wrong question.
MAX_TURNS = 3

#: Sessions retained, least-recently-used evicted first. `/query` is public and
#: the session id comes from the client, so an unbounded dict here is a way to
#: exhaust the server's memory with a loop of random ids, not merely a leak.
MAX_SESSIONS = 200

_sessions: OrderedDict[str, deque[dict[str, str]]] = OrderedDict()


def history(session_id: str | None) -> list[dict[str, str]]:
    """Prior exchanges for this session, oldest first. Empty when unknown."""
    if not session_id:
        return []
    turns = _sessions.get(session_id)
    if turns is None:
        return []
    _sessions.move_to_end(session_id)
    return list(turns)


def remember(session_id: str | None, query: str, answer: str) -> None:
    """Record one completed exchange."""
    if not session_id or not answer.strip():
        return

    turns = _sessions.get(session_id)
    if turns is None:
        # maxlen does the trimming, so the deque cannot grow past the cap even
        # if this is called in a loop
        turns = _sessions[session_id] = deque(maxlen=MAX_TURNS * 2)
    _sessions.move_to_end(session_id)

    turns.append({"role": "user", "content": query})
    turns.append({"role": "assistant", "content": answer})

    while len(_sessions) > MAX_SESSIONS:
        _sessions.popitem(last=False)


def clear() -> None:
    """Drop everything. For tests, and for a restart-shaped reset."""
    _sessions.clear()
