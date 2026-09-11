import json
import logging
from typing import Any

from openai import BadRequestError

from friday import llm
from friday.schemas.visualization import VisualizationPlan

from .prompts import SYSTEM

log = logging.getLogger("friday.planner")


def _schema(pinned: str | None = None) -> dict[str, Any]:
    """The plan schema, optionally narrowed to a single visualization type.

    Narrowing the enum rather than rewriting the model's answer afterwards is
    the whole point. A type swapped in after the fact arrives carrying the data
    fields of the type the model *did* choose, so forcing `bar_3d` onto a plan
    written as `radial_gauge` produces a bar chart with no series in it. Told up
    front, the model fills the fields that component actually reads.
    """
    schema = VisualizationPlan.model_json_schema()
    if pinned:
        schema["properties"]["type"] = {"const": pinned}
    return schema


async def plan(
    query: str,
    answer: str,
    evidence: list[dict[str, Any]],
    pinned_type: str | None = None,
) -> VisualizationPlan:
    context = f"Question: {query}\n\nFRIDAY's answer: {answer}"
    if evidence:
        context += f"\n\nMeasured evidence:\n{json.dumps(evidence, indent=2)}"
    else:
        context += "\n\nMeasured evidence: none — no tool was run."

    if pinned_type:
        context += (
            f"\n\nThe component is already decided: `{pinned_type}`. It is on "
            "screen in front of the user. Fill the data fields it reads."
        )

    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": context},
    ]

    text = await _complete(messages, pinned_type)
    return VisualizationPlan.model_validate_json(_strip_fence(text))


async def _complete(messages: list[dict[str, Any]], pinned: str | None = None) -> str:
    api = llm.client()
    try:
        response = await api.chat.completions.create(
            model=llm.model(),
            messages=messages,  # type: ignore[arg-type]
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "visualization_plan", "schema": _schema(pinned)},
            },
            # The same question must pick the same component twice. Left to the
            # provider's default, "which processes use the most memory" planned
            # bar_3d on one run and radial_gauge on the next, so the UI
            # materialised bars and then replaced them with gauges — a correct
            # §18 sequence that reads as a bug. Choosing a component is a
            # classification, and nothing here wants variety.
            temperature=0,
        )
        return response.choices[0].message.content or ""
    except BadRequestError as err:
        log.warning("provider rejected json_schema, falling back to json_object: %s", err)

    relaxed = [
        *messages,
        {"role": "system", "content": f"Match this JSON Schema exactly:\n{json.dumps(_schema(pinned))}"},
    ]
    response = await api.chat.completions.create(
        model=llm.model(),
        messages=relaxed,  # type: ignore[arg-type]
        response_format={"type": "json_object"},
        temperature=0,
    )
    return response.choices[0].message.content or ""


def _strip_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[-1]
        stripped = stripped.rsplit("```", 1)[0]
    return stripped.strip()
