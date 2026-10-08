"""Заголовки безопасности ответов API. Общие для SecurityHeadersMiddleware и ответа 500:
обработчик необработанных ошибок работает снаружи middleware приложения, и его ответ
иначе ушел бы без них.

Cache-Control: no-store — на всех ответах /api/ (личные данные не должны оседать в
кэше браузера и прокси), если маршрут не задал свой. HSTS и CSP ставит Caddy.
"""


def security_headers(path: str) -> dict[str, str]:
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "DENY",
    }
    if path.startswith("/api/"):
        headers["Cache-Control"] = "no-store"
    return headers
