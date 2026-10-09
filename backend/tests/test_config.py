import base64
import os

import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import Settings, SettingsError, load_settings
from app.core.cookies import cookie_name

PROD_KEY = "1:" + base64.b64encode(os.urandom(32)).decode()


@pytest.fixture(autouse=True)
def plain_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Без переменных, которые conftest задал для тестов, и без файла .env."""
    for name in ("ENV", "COOKIE_SECURE", "HIBP_ENABLED", "PUBLIC_ORIGIN"):
        monkeypatch.delenv(f"CAPPER_{name}", raising=False)
    monkeypatch.setitem(Settings.model_config, "env_file", None)


def _prod(**overrides: object) -> Settings:
    fields: dict[str, object] = {
        "env": "prod",
        "secret_key": SecretStr("s" * 48),
        "master_keys": SecretStr(PROD_KEY),
        "public_origin": "https://capper.example.com",
    }
    fields.update(overrides)
    return Settings.model_validate(fields)


def test_prod_defaults() -> None:
    settings = _prod()
    assert settings.cookie_secure is True
    assert settings.hibp_enabled is True
    assert cookie_name("session", settings) == "__Host-session"
    assert cookie_name("csrf", settings) == "__Host-csrf"


@pytest.mark.parametrize(
    ("overrides", "fragment"),
    [
        ({"secret_key": SecretStr("")}, "CAPPER_SECRET_KEY"),
        ({"secret_key": SecretStr("short")}, "CAPPER_SECRET_KEY"),
        ({"master_keys": SecretStr("")}, "CAPPER_MASTER_KEYS"),
        ({"master_keys": SecretStr("1:bad")}, "CAPPER_MASTER_KEYS"),
        ({"public_origin": "http://capper.example.com"}, "CAPPER_PUBLIC_ORIGIN"),
        ({"cookie_secure": False}, "CAPPER_COOKIE_SECURE"),
    ],
)
def test_prod_refuses_to_start_without_secrets(overrides: dict[str, object], fragment: str) -> None:
    with pytest.raises(ValidationError, match=fragment):
        _prod(**overrides)


def test_dev_defaults_work_without_secrets() -> None:
    settings = Settings.model_validate({"env": "dev"})
    assert settings.cookie_secure is False
    assert settings.hibp_enabled is False
    assert settings.secret_key_bytes
    assert len(settings.master_key_map[1]) == 32
    assert cookie_name("session", settings) == "capper_session"


def test_env_variables_are_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPPER_ENV", "prod")
    monkeypatch.setenv("CAPPER_SECRET_KEY", "k" * 40)
    monkeypatch.setenv("CAPPER_MASTER_KEYS", PROD_KEY)
    monkeypatch.setenv("CAPPER_PUBLIC_ORIGIN", "https://capper.example.com")
    settings = Settings()
    assert settings.cookie_secure is True
    assert settings.hibp_enabled is True
    monkeypatch.setenv("CAPPER_HIBP_ENABLED", "false")
    assert Settings().hibp_enabled is False


def test_startup_error_has_no_secret_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAPPER_ENV", "prod")
    monkeypatch.setenv("CAPPER_DATABASE_URL", "postgresql+asyncpg://u:db-pass-123@h/d")
    monkeypatch.setenv("CAPPER_SECRET_KEY", "")
    with pytest.raises(SettingsError) as info:
        load_settings()
    assert "CAPPER_SECRET_KEY" in str(info.value)
    assert "db-pass-123" not in str(info.value)


@pytest.mark.parametrize(
    "fields",
    [
        # Забыли CAPPER_ENV=prod на сервере
        {"public_origin": "https://capper.example.com"},
        {"env": "test", "public_origin": "http://192.168.1.10:5173"},
        {"cookie_secure": True},
        {"public_origin": "https://capper.example.com", "secret_key": SecretStr("s" * 48)},
    ],
)
def test_dev_keys_only_on_localhost(fields: dict[str, object]) -> None:
    with pytest.raises(ValidationError, match=r"CAPPER_(SECRET|MASTER)_KEY"):
        Settings.model_validate(fields)


def test_non_local_dev_with_own_keys_works() -> None:
    settings = Settings.model_validate(
        {
            "public_origin": "https://capper.example.com",
            "secret_key": SecretStr("s" * 48),
            "master_keys": SecretStr(PROD_KEY),
        }
    )
    assert settings.env == "dev"
    assert settings.secret_key_bytes == b"s" * 48
    for origin in ("http://localhost:5173", "http://127.0.0.1:8000", "http://[::1]:5173"):
        assert Settings.model_validate({"public_origin": origin}).env == "dev"


def test_data_sources_defaults_and_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Загрузка архивов (этап 2): адреса, первые годы и час ночного обновления."""
    settings = Settings.model_validate({"env": "dev"})
    assert settings.sackmann_base_url == (
        "https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master"
    )
    assert settings.tennis_data_base_url == "http://www.tennis-data.co.uk"
    assert settings.data_first_year == 2000
    assert settings.tennis_data_first_year == 2013
    assert settings.data_update_hour_utc == 5

    monkeypatch.setenv("CAPPER_SACKMANN_BASE_URL", "https://mirror.example.com/atp")
    monkeypatch.setenv("CAPPER_DATA_UPDATE_HOUR_UTC", "23")
    settings = Settings()
    assert settings.sackmann_base_url == "https://mirror.example.com/atp"
    assert settings.data_update_hour_utc == 23


@pytest.mark.parametrize(
    "fields",
    [
        {"data_update_hour_utc": 24},
        {"data_update_hour_utc": -1},
        # Файлы tennis-data до 2013 года — в формате .xls, загрузчик их не читает
        {"tennis_data_first_year": 2012},
    ],
)
def test_data_settings_out_of_range(fields: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        Settings.model_validate({"env": "dev", **fields})
