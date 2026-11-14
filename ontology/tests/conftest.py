import os
import tempfile
import threading
import time

import pytest

_tmp = tempfile.mkdtemp(prefix="onto-test-")
os.environ["ONTO_DATA_DIR"] = _tmp
os.environ["ONTO_ADMIN_EMAIL"] = "admin@test.local"
os.environ["ONTO_ADMIN_PASSWORD"] = "Admin-Passw0rd!"
os.environ["ONTO_SECRET_KEY"] = "test-secret-key"
os.environ.pop("ONTO_DATABASE_URL", None)

FAKE_PORT = 8792
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
def app_client(fake_llm):
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c


def login(app, email, password):
    """A separate signed-in client (its own cookie jar)."""
    from fastapi.testclient import TestClient
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"email": email, "password": password}, headers=H)
    assert r.status_code == 200, r.text
    return c


@pytest.fixture(scope="session")
def admin(app_client):
    """Signed-in admin with the stand-in model configured. Returns (client, model_id)."""
    from app.main import app
    c = login(app, "admin@test.local", "Admin-Passw0rd!")
    m = c.post("/api/admin/models", headers=H, json={
        "name": "Fake", "provider": "openai_compatible", "model_id": "fake-1", "api_key": "sk-secret-value",
        "base_url": f"http://127.0.0.1:{FAKE_PORT}/v1", "is_default": True, "price_in": 1, "price_out": 2}).json()
    c.put("/api/admin/settings", headers=H, json={"builds_per_hour": 500, "tests_per_min": 120})
    return c, m["id"]


def make_user(admin_client, email, role):
    """Create a user and take them through the forced password change. Returns a signed-in client."""
    from app.main import app
    r = admin_client.post("/api/admin/users", headers=H, json={"email": email, "name": email.split("@")[0], "role": role})
    assert r.status_code == 200, r.text
    c = login(app, email, r.json()["temporary_password"])
    assert c.post("/api/auth/change-password", headers=H, json={"current": r.json()["temporary_password"], "new": "User-Passw0rd!1"}).status_code == 200
    return c


def wait_job(c, job_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = c.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.15)
    raise AssertionError("job did not finish")
