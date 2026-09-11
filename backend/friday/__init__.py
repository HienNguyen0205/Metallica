"""FRIDAY orchestrator.

Environment is loaded here rather than at an entry point so every way of
starting the service sees the same config — `uvicorn`, a test run, or a bare
`import friday`. Real environment variables win over the file, so a container
or CI secret is never shadowed by a stale local `.env`.
"""

from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
