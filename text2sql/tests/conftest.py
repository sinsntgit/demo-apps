import os
import tempfile
import threading
import time

import pytest

_tmp = tempfile.mkdtemp(prefix="t2s-test-")
os.environ["T2S_DATA_DIR"] = _tmp
os.environ["T2S_ADMIN_EMAIL"] = "admin@test.local"
os.environ["T2S_ADMIN_PASSWORD"] = "Admin-Passw0rd!"
os.environ["T2S_SECRET_KEY"] = "test-secret-key"
os.environ.pop("T2S_DATABASE_URL", None)

FAKE_PORT = 8791
H = {"X-Requested-With": "fetch"}


@pytest.fixture(scope="session")
def fake_llm():
    import uvicorn
    from tests import fake_llm as mod
    server = uvicorn.Server(uvicorn.Config(mod.app, host="127.0.0.1", port=FAKE_PORT, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(50):
        if server.started:
            break
        time.sleep(0.1)
    yield mod
    server.should_exit = True


@pytest.fixture(scope="session")
def client(fake_llm):
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def admin(client):
    """Signed-in admin with a fake model configured. Returns (client, connection_id, model_id)."""
    r = client.post("/api/auth/login", json={"email": "admin@test.local", "password": "Admin-Passw0rd!"}, headers=H)
    assert r.status_code == 200, r.text
    m = client.post("/api/admin/models", headers=H, json={
        "name": "Fake", "provider": "openai_compatible", "model_id": "fake-1",
        "base_url": f"http://127.0.0.1:{FAKE_PORT}/v1", "is_default": True, "price_in": 1, "price_out": 2}).json()
    client.put("/api/admin/settings", headers=H, json={"rate_limit_per_min": 600})      # the suite asks a lot of questions
    conn = client.get("/api/connections").json()[0]
    return client, conn["id"], m["id"]
