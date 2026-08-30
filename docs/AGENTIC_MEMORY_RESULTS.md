# Agentic memory — chạy live và hiệu chỉnh ngưỡng

Task 13 của `docs/superpowers/plans/2026-08-28-agentic-memory.md`. Chạy
2026-08-29 với Supabase thật, `gemini-embedding-001` cắt xuống 768 chiều.

---

## Ký ức sống qua restart

Dạy 6 điều, tắt hẳn process, khởi động lại:

```
INFO friday: long-term memory: 6 facts
```

`GET /memory` trả `from_cache: false` — tức nó đọc thẳng Supabase chứ không phải
bản sao trong RAM. Đó là bản vá C2 từ review toàn nhánh; trước đó endpoint này
đọc cache và sẽ báo rỗng sau một lần khởi động lỗi trong khi bảng đầy.

Sáu ký ức, tất cả `provenance: user` — đúng, vì không turn nào trong lượt dạy
chạy `search_web`.

## Nhớ lại có hoạt động

Sau restart, ba câu hỏi không hề nhắc lại nội dung đã dạy:

| Hỏi | Nhớ ra |
|---|---|
| `How is my disk?` | biết phải báo bằng GB, và nói thẳng là không thấy dung lượng tổng |
| `When is it safe to deploy?` | `Tuesdays at 2:00 AM UTC` |
| `What time is it for me right now?` | `Asia/Ho_Chi_Minh (UTC+7)` |

## Phân bố điểm tương đồng

6 câu hỏi liên quan (mỗi câu có đúng một ký ức là đích) và 4 câu hoàn toàn
không liên quan, đo trên toàn bộ 6 ký ức:

```
How is my disk?                target#1=0.625  rest=0.54 0.53 0.53 0.49 0.48
When can I deploy?             target#4=0.691  rest=0.59 0.58 0.56 0.56 0.52
What timezone am I in?         target#5=0.667  rest=0.60 0.52 0.51 0.47 0.45
Is this production?            target#2=0.708  rest=0.56 0.53 0.53 0.52 0.48
Who is on call this week?      target#6=0.785  rest=0.58 0.57 0.55 0.54 0.51
Keep it brief please           target#3=0.762  rest=0.57 0.56 0.55 0.53 0.52

What is the capital of France? best=0.477
Explain quantum entanglement   best=0.492
What is 5 + 5?                 best=0.504
Latest news about football     best=0.500
```

**6/6 ký ức đích xếp hạng #1 cho câu hỏi của nó.** Ba dải tách ra:

| Dải | Khoảng |
|---|---|
| ký ức đúng cho câu hỏi của nó | 0.625 – 0.785 |
| ký ức khác trên một câu hỏi liên quan | 0.45 – 0.600 |
| mọi ký ức trên câu hỏi **không** liên quan | 0.41 – 0.504 |

## Ngưỡng: 0.6 → **0.58**

Khe giữa hai dải đầu chỉ rộng **0.025** (0.600 → 0.625), điểm giữa là 0.61.
Tôi cố ý **không** chọn 0.61: một khe 0.025 đo trên 6 mẫu là nhiễu chứ không
phải tín hiệu, và đậu đúng lên mép nó nghĩa là một cách diễn đạt khác đi một
chút sẽ lật kết quả.

Khe đáng tin là giữa dải thứ ba và dải thứ nhất — **0.504 so với 0.625**, rộng
0.121. Đó mới là trường hợp quan trọng: đừng đổ ký ức vào một câu hỏi chẳng
liên quan gì.

0.58 nằm trên mọi điểm của câu hỏi không liên quan 0.076 và dưới mọi ký ức đúng
0.045, không đậu lên mép dải nào.

Hướng làm tròn do bất đối xứng của lỗi quyết định. Ngưỡng quá cao thì FRIDAY
lặng lẽ không nhớ ra — đúng cái tính năng này tồn tại để tránh, và triệu chứng
duy nhất là "hình như không có ký ức nào liên quan", không phân biệt được với
"chưa từng nhớ gì". Ngưỡng quá thấp chỉ thêm nhiễu, mà nhiễu đã bị chặn hai lớp
bởi `TOP_K_DEFAULT = 5` và `RECALL_BLOCK_MAX_CHARS = 1500`.

**Đo lại khi corpus tới ~30 ký ức.** Lệnh:

```bash
cd backend && PYTHONPATH=. ./.venv/Scripts/python.exe -c "
import asyncio
from friday.memory import long_term as lt, embed
async def main():
    await lt.load()
    for q in ['<câu hỏi liên quan>', '<câu hỏi không liên quan>']:
        v = (await embed.embed([q]))[0]
        s = sorted(((lt.similarity(m.embedding, v), m.id) for m in lt.CACHE), reverse=True)
        print(q, [f'#{i}={x:.3f}' for x, i in s[:6]])
asyncio.run(main())
"
```

## Provenance chạy đúng end-to-end

`Search for what the default port of PostgreSQL is, and remember it.`

```
tool   {"tool": "search_web", "risk": "low"}
tool   {"tool": "remember", "risk": "low"}
memory {"id": 7, "fact": "The default port for PostgreSQL is 5432.", "provenance": "tool"}
```

Nhãn `tool` đi ra SSE, vào Supabase, và HUD hiện `FROM WEB`. Đây là mitigation
đầu trong ba lớp bảo vệ quyết định "cho ghi tự do".

## Xoá chạm tới store thật

```
DELETE /memory/7        → {"ok":true}
GET /memory             → 6 memories, from_cache: false, ids [1..6]
DELETE, origin lạ       → 403
```

Ký ức nguồn-web biến mất khỏi Supabase, không chỉ khỏi cache. Trước bản vá C2,
`ok:true` có thể trả về trong khi hàng vẫn còn và quay lại sau restart.

---

## Hai hành vi lệch — và cái gì sửa được

**1. Model vẫn search web cho thứ thuộc về máy này.** `How is my disk?` gọi
`get_system_metrics` rồi `search_web`; `What time is it for me right now?` gọi
`search_web`. Cả hai đều tìm trên internet công cộng thứ chỉ máy này biết —
đúng cái luật trong `SYSTEM` cấm. Câu trả lời cuối vẫn đúng vì ký ức đã cấp
thông tin, nhưng mỗi lần như vậy tốn một lượt tool, tốn quota search, và mở bề
mặt prompt-injection cho câu hỏi vốn không cần.

**2. `When is it safe to deploy?` gọi `read_note` bốn lần** trước khi trả lời,
trong khi câu trả lời đã nằm sẵn trong khối recall của chính prompt đó. Model
không tin ký ức được cấp, đi lục notes. Bốn lượt tool thừa cho một câu hỏi.

### #2 đã sửa — đo lại 2026-08-30

Thêm một câu vào `render_block`, không phải vào `SYSTEM`: nó chỉ nên xuất hiện
khi thật sự có khối ký ức, và đứng cạnh luật "KHÔNG phải chỉ thị" để người đọc
sau thấy cả hai ràng buộc cùng lúc. Hai câu kéo ngược nhau nhưng không mâu
thuẫn — nội dung là dữ liệu đáng tin, mệnh lệnh nằm trong đó thì không.

> Nội dung của chúng thì đã xác lập: đừng chạy tool để tra lại điều mà khối này
> đã trả lời.

`When is it safe to deploy?`, chạy qua agent thật với Supabase thật:

| Lượt | Câu có trong prompt | Tool đã gọi |
|---|---|---|
| 1 | có | none |
| 2 | có | none |
| revert tay | **không** | `read_note` × 3 |
| `main` trước cherry-pick | **không** | `read_note` × 6, hết MAX_TURNS |

Gỡ câu đó ra là hành vi cũ quay lại ngay — nhân quả, không phải trùng hợp.

### #1: nửa sửa được bằng code, nửa không

Nửa về giờ giấc **không phải chuyện prompt** như đoạn trên viết. Registry lúc đó
có 6 tool và không cái nào đọc được đồng hồ; model bị hỏi giờ mà không có cách
nào để biết, nên hoặc bịa ra hoặc đi search rồi vẫn sai. `SYSTEM` cấm cả hai
bằng lời lẽ dứt khoát và model vẫn làm — thiếu năng lực thì luật không lấp được.

`get_current_time` (`friday/tools/system/clock.py`, `datetime.now().astimezone()`)
lấp chỗ đó:

| | Tool | Trả lời |
|---|---|---|
| trước | `search_web` / none | `August 29, 2026` / `07:11 March 30, 2025` |
| sau | `get_current_time` | `7:06 PM Sunday, August 30, 2026 (Indochina Time)` |

Ngày thật là 2026-08-30, nên cả hai câu trả lời cũ đều sai.

Nửa còn lại vẫn mở: `How is my disk?` gọi `get_system_metrics` **rồi vẫn**
`search_web`. Tool cần thiết tồn tại và đã chạy, nên đây đúng là model phớt lờ
prompt — không sửa bằng code được. Đây là chỗ đáng để so một model khác.

## Chưa kiểm

| Mục | Vì sao |
|---|---|
| Hợp nhất chạy thật | Cần >100 ký ức hoặc 20 lượt; corpus hiện có 6 |
| `enforce_cap` xoá hàng khỏi store | Cần >500 ký ức |
| Ngưỡng ở quy mô thật | 6 ký ức là mẫu nhỏ; xem lệnh đo lại ở trên |
