"""端到端模拟前端断点续传协议：
1) 乱序只传部分块（模拟中断）；
2) 重新 GET /chunks 查状态，只补缺块；
3) finalize 成功；
4) 再次 finalize 返回 already_completed。
"""
import os
import tempfile

_TEMP = tempfile.mkdtemp(prefix="pq-e2e-")
os.environ.setdefault("PQ_DATABASE_URL", f"sqlite+pysqlite:///{os.path.join(_TEMP, 'e2e.db')}")
os.environ.setdefault("PQ_OBJECT_STORE", "memory")
os.environ.setdefault("PQ_SPOOL_DIR", os.path.join(_TEMP, "spool"))

from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.storage import MemoryObjectStore, set_object_store  # noqa: E402
from tests.synthetic import create_manifest, make_chunks  # noqa: E402

init_db()
set_object_store(MemoryObjectStore())
Base.metadata.drop_all(bind=engine)
Base.metadata.create_all(bind=engine)

client = TestClient(app)
chunks = make_chunks(sample_chunks=(120, 240, 360, 300))
manifest = create_manifest(client, chunks)
mid = manifest["id"]

def put(seq):
    r = client.put(
        f"/manifests/{mid}/chunks/{seq}/raw",
        files={"chunk_file": (f"{seq}.bin", chunks[seq]["raw"], "application/octet-stream")},
    )
    assert r.status_code == 200, r.text

# 第一次会话：乱序传 3,1 后"中断"
for s in (3, 1):
    put(s)

# 重进页面：查服务端状态
remote = {c["sequence"]: c["sha256"] for c in client.get(f"/manifests/{mid}/chunks").json()}
missing = [c["sequence"] for c in chunks if c["sequence"] not in remote]
assert sorted(missing) == [0, 2], missing

# finalize 在缺块时必须拒绝
assert client.post(f"/manifests/{mid}/finalize").status_code == 422

# 只补缺块
for s in missing:
    put(s)

# 服务端摘要全部与清单一致
remote = {c["sequence"]: c["sha256"] for c in client.get(f"/manifests/{mid}/chunks").json()}
assert remote == {c["sequence"]: c["sha256"] for c in chunks}

first = client.post(f"/manifests/{mid}/finalize").json()
assert first["completed"] is True and first["already_completed"] is False
second = client.post(f"/manifests/{mid}/finalize").json()
assert second["completed"] is False and second["already_completed"] is True

# 完成后 PUT 被拒绝（原始块不可变）
r = client.put(f"/manifests/{mid}/chunks/0/raw",
               files={"chunk_file": ("0.bin", chunks[0]["raw"], "application/octet-stream")})
assert r.status_code == 409

# 错误内容的块被服务端 422 拒绝
m2 = create_manifest(client, make_chunks(sample_chunks=(120,)))
bad = bytearray(make_chunks(sample_chunks=(120,))[0]["raw"])
bad[0] ^= 0xFF
r = client.put(f"/manifests/{m2['id']}/chunks/0/raw",
               files={"chunk_file": ("0.bin", bytes(bad), "application/octet-stream")})
assert r.status_code == 422 and r.json()["detail"]["code"] == "byte_digest_mismatch"

print("E2E_OK")
