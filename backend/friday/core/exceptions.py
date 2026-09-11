"""Centralised exception helpers (placeholder for future expansion)."""

from fastapi import HTTPException


def pending_not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="no pending decision with that id")
