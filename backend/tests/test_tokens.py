import re

from pydantic import SecretStr

from app.core.security.tokens import (
    CODE_ALPHABET,
    gen_invite_code,
    gen_recovery_codes,
    gen_reset_code,
    hash_code,
    hash_token,
    new_token,
    normalize_code,
)
from tests.support import SettingsOverride


def test_new_token_is_256_bit_and_hashed_with_sha256() -> None:
    token = new_token()
    assert len(token) == 43
    assert new_token() != token
    digest = hash_token(token)
    assert re.fullmatch(r"[0-9a-f]{64}", digest)
    assert hash_token(token) == digest


def test_code_formats() -> None:
    body = f"[{CODE_ALPHABET}]{{4}}"
    for _ in range(50):
        assert re.fullmatch(f"CAP-{body}-{body}", gen_invite_code())
        assert re.fullmatch(f"RST-{body}-{body}", gen_reset_code())
    assert not set("IO01") & set(CODE_ALPHABET)


def test_recovery_codes() -> None:
    codes = gen_recovery_codes()
    assert len(codes) == 8
    assert len(set(codes)) == 8
    lower = CODE_ALPHABET.lower()
    for code in codes:
        assert re.fullmatch(f"[{lower}]{{4}}-[{lower}]{{4}}", code)


def test_normalize_ignores_case_spaces_and_dashes() -> None:
    assert normalize_code("cap-abcd-efgh") == "CAPABCDEFGH"
    assert normalize_code(" CAP ABCD EFGH ") == "CAPABCDEFGH"
    assert normalize_code("abcd-efgh", prefix="CAP") == "CAPABCDEFGH"
    assert normalize_code("CAP-ABCD-EFGH", prefix="CAP") == "CAPABCDEFGH"
    assert normalize_code("4f7k-2m9q") == "4F7K2M9Q"


def test_hash_code_is_hmac_of_normalized_code() -> None:
    code = gen_invite_code()
    digest = hash_code(code)
    assert re.fullmatch(r"[0-9a-f]{64}", digest)
    assert hash_code(code.lower().replace("-", " ")) == digest
    assert hash_code(code[4:], prefix="CAP") == digest
    assert hash_code(gen_invite_code()) != digest
    # Это HMAC с секретом, а не простой sha256 кода
    assert digest != hash_token(normalize_code(code))


def test_hash_code_depends_on_secret(override_settings: SettingsOverride) -> None:
    code = "CAP-ABCD-EFGH"
    before = hash_code(code)
    override_settings(secret_key=SecretStr("another-secret-key-for-tests-0123456789"))
    assert hash_code(code) != before
