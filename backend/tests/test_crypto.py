import base64
import os

import pytest
from pydantic import SecretStr

from app.core.config import Settings, parse_master_keys
from app.core.security import crypto
from tests.support import SettingsOverride


def _key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


def test_roundtrip_with_aad() -> None:
    aad = crypto.aad_for(crypto.AAD_TOTP_SECRET, 7)
    ciphertext, version = crypto.encrypt_str("JBSWY3DPEHPK3PXP", aad)
    assert b"JBSWY3DPEHPK3PXP" not in ciphertext
    assert crypto.decrypt_str(ciphertext, version, aad) == "JBSWY3DPEHPK3PXP"
    # Каждый раз новый nonce
    again, _ = crypto.encrypt_str("JBSWY3DPEHPK3PXP", aad)
    assert again != ciphertext


def test_wrong_aad_fails() -> None:
    ciphertext, version = crypto.encrypt(b"secret", crypto.aad_for(crypto.AAD_TOTP_SECRET, 1))
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt(ciphertext, version, crypto.aad_for(crypto.AAD_TOTP_SECRET, 2))


def test_tampered_or_unknown_version_fails() -> None:
    aad = b"x:1"
    ciphertext, version = crypto.encrypt(b"secret", aad)
    broken = ciphertext[:-1] + bytes([ciphertext[-1] ^ 1])
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt(broken, version, aad)
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt(ciphertext, version + 100, aad)
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt(b"short", version, aad)


def test_key_rotation(override_settings: SettingsOverride) -> None:
    old, new = _key(), _key()
    override_settings(master_keys=SecretStr(f"1:{old}"))
    ciphertext, version = crypto.encrypt(b"api-key", b"aad")
    assert version == 1
    # Новый ключ дописан в конец: шифруем им, старые записи расшифровываются
    override_settings(master_keys=SecretStr(f"1:{old},2:{new}"))
    assert crypto.current_key_version() == 2
    assert crypto.needs_reencrypt(version)
    assert crypto.decrypt(ciphertext, version, b"aad") == b"api-key"
    fresh, fresh_version = crypto.encrypt(b"api-key", b"aad")
    assert fresh_version == 2
    # Ключ другой версии не подходит к чужому шифротексту
    with pytest.raises(crypto.CryptoError):
        crypto.decrypt(fresh, 1, b"aad")


@pytest.mark.parametrize(
    "value",
    ["", "1", "x:AAAA", "1:not-base64!", f"0:{_key()}", "1:" + base64.b64encode(b"short").decode()],
)
def test_parse_master_keys_rejects(value: str) -> None:
    with pytest.raises(ValueError, match="CAPPER_MASTER_KEYS"):
        parse_master_keys(value)


def test_parse_master_keys_order() -> None:
    a, b = _key(), _key()
    keys = parse_master_keys(f" 3:{a} , 2:{b} ")
    assert list(keys) == [3, 2]
    assert Settings(master_keys=SecretStr(f"3:{a},2:{b}")).master_key_map == keys
