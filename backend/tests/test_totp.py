import pyotp

from app.core.security.totp import (
    INTERVAL,
    code_at_step,
    current_step,
    new_totp_secret,
    qr_svg,
    totp_uri,
    verify_totp,
)

NOW = 1_800_000_000.0


def test_secret_and_uri() -> None:
    secret = new_totp_secret()
    assert len(secret) == 32
    uri = totp_uri(secret, "anna@example.com")
    assert uri.startswith("otpauth://totp/AI%20Capper:anna%40example.com?")
    assert "issuer=AI%20Capper" in uri
    assert f"secret={secret}" in uri
    svg = qr_svg(uri)
    assert svg.startswith("<svg") and "</svg>" in svg


def test_code_matches_pyotp() -> None:
    secret = new_totp_secret()
    assert code_at_step(secret, current_step(NOW)) == pyotp.TOTP(secret).at(int(NOW))


def test_window_plus_minus_one_step() -> None:
    secret = new_totp_secret()
    step = current_step(NOW)
    for offset in (-1, 0, 1):
        code = code_at_step(secret, step + offset)
        assert verify_totp(secret, code, last_step=None, now=NOW) == step + offset
    for offset in (-2, 2):
        code = code_at_step(secret, step + offset)
        assert verify_totp(secret, code, last_step=None, now=NOW) is None


def test_replay_of_same_or_older_step_is_rejected() -> None:
    secret = new_totp_secret()
    step = current_step(NOW)
    code = code_at_step(secret, step)
    used = verify_totp(secret, code, last_step=None, now=NOW)
    assert used == step
    # Тот же код еще раз — отказ, даже в пределах того же окна
    assert verify_totp(secret, code, last_step=used, now=NOW) is None
    assert verify_totp(secret, code, last_step=used, now=NOW + INTERVAL) is None
    # Код предыдущего шага после использования текущего — тоже отказ
    older = code_at_step(secret, step - 1)
    assert verify_totp(secret, older, last_step=used, now=NOW) is None
    # Следующий шаг принимается
    newer = code_at_step(secret, step + 1)
    assert verify_totp(secret, newer, last_step=used, now=NOW + INTERVAL) == step + 1


def test_input_normalization_and_garbage() -> None:
    secret = new_totp_secret()
    code = code_at_step(secret, current_step(NOW))
    spaced = f"{code[:3]} {code[3:]}"
    assert verify_totp(secret, spaced, last_step=None, now=NOW) is not None
    assert verify_totp(secret, "12345", last_step=None, now=NOW) is None
    assert verify_totp(secret, "abcdef", last_step=None, now=NOW) is None
    assert verify_totp(secret, "", last_step=None, now=NOW) is None


def test_unicode_digits_do_not_crash() -> None:
    secret = new_totp_secret()
    code = code_at_step(secret, current_step(NOW))
    # Полноширинные и арабские цифры — те же цифры, код принимается
    fullwidth = "".join(chr(ord("\uff10") + int(d)) for d in code)
    arabic = "".join(chr(ord("\u0660") + int(d)) for d in code)
    assert verify_totp(secret, fullwidth, last_step=None, now=NOW) is not None
    assert verify_totp(secret, arabic, last_step=None, now=NOW) is not None
    # Надстрочные и прочие символы — просто неверный код, без исключения
    assert verify_totp(secret, code[:5] + "\u00b2", last_step=None, now=NOW) is None
    assert verify_totp(secret, code[:5] + "\u00e9", last_step=None, now=NOW) is None
