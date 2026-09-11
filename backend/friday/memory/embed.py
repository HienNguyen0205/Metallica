"""Embedding cho ký ức — đi qua đúng gateway §8 mà phần còn lại đang dùng.

Đo trước khi chọn: 20 embedding liên tiếp trong 10 giây, 0 lỗi. Quota embedding
tách khỏi 15 RPM của `generate_content`, nên một call mỗi turn không ăn vào cái
nút thắt vốn đã giới hạn ~5 query/phút. Nếu sau này đổi provider, đo lại điều
này trước - cả thiết kế đứng trên nó.
"""

import math
import os

from friday.llm import client

#: Gemini hỗ trợ cắt MRL: 3072 chiều gốc xuống 768 vẫn giữ được chất lượng và
#: đưa mỗi ký ức từ 12KB xuống 3KB.
EMBED_DIM = 768

DEFAULT_EMBED_MODEL = "gemini-embedding-001"


class EmbedError(RuntimeError):
    """Không embed được. Người gọi bỏ qua recall lượt này chứ không hỏng turn."""


def model() -> str:
    return os.getenv("FRIDAY_EMBED_MODEL") or DEFAULT_EMBED_MODEL


def normalize(vector: list[float]) -> list[float]:
    """Về vector đơn vị.

    Bắt buộc, không phải tuỳ chọn. Sau khi cắt MRL, vector Gemini không còn đảm
    bảo chuẩn đơn vị, nên tích vô hướng trên vector thô không phải cosine — nó
    vẫn ra một con số, vẫn xếp hạng được, và xếp sai. Không có lỗi nào để lần.
    """
    length = math.sqrt(sum(x * x for x in vector))
    if length == 0.0:
        return list(vector)
    return [x / length for x in vector]


async def embed(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    try:
        response = await client().embeddings.create(
            model=model(),
            input=texts,
            dimensions=EMBED_DIM,
        )
        return [normalize(list(item.embedding)) for item in response.data]
    except Exception as err:
        raise EmbedError(str(err)) from err
