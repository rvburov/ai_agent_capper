"""Клиент Claude API: один пул соединений на цикл событий, ключ — на каждый вызов.

Ключ передается явно и только в client_for: SDK тогда не берет ANTHROPIC_API_KEY из
окружения, а явный base_url не дает переменной ANTHROPIC_BASE_URL увести ключ на чужой
адрес. Ключ расшифровывается прямо перед вызовом (app/services/claude_key.py) и никуда
не сохраняется. Клиенты из client_for делят пул соединений своего цикла: закрывать их
нельзя. Пул привязан к циклу событий, поэтому у каждого цикла свой (API, воркер,
команда терминала с asyncio.run); закрывает его close_client в том же цикле, в конце его
жизни (lifespan API, остановка воркера, конец команды терминала).

Повторы делает SDK: ошибки сети, 408, 409, 429, 5xx и 529 — до max_retries раз с паузой
0,5–8 с. Тесты подменяют транспорт через set_http_client_for_tests (SDK работает на httpx2,
транспорт тоже из httpx2). Адрес API — настройка CAPPER_ANTHROPIC_BASE_URL (по умолчанию
BASE_URL): локальный прогон без ключа идет в поддельный сервер tests/fake_claude.py.
"""

import asyncio
import weakref

import anthropic

from app.core.config import get_settings

BASE_URL = "https://api.anthropic.com"
MAX_RETRIES = 2
# Без with_options(api_key=...) запрос уйдет с этим значением и получит 401
_PLACEHOLDER_KEY = "unset"

# Общий клиент каждого цикла событий; запись пропадает вместе с циклом
_clients: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, anthropic.AsyncAnthropic] = (
    weakref.WeakKeyDictionary()
)
_test_http_client: anthropic.DefaultAsyncHttpxClient | None = None
_test_max_retries: int = 0


def _base_client() -> anthropic.AsyncAnthropic:
    """Общий клиент текущего цикла событий (вне цикла — RuntimeError)."""
    loop = asyncio.get_running_loop()
    client = _clients.get(loop)
    if client is None or client.is_closed():
        testing = _test_http_client is not None
        client = anthropic.AsyncAnthropic(
            api_key=_PLACEHOLDER_KEY,
            base_url=get_settings().anthropic_base_url or BASE_URL,
            http_client=_test_http_client or anthropic.DefaultAsyncHttpxClient(),
            max_retries=_test_max_retries if testing else MAX_RETRIES,
        )
        _clients[loop] = client
    return client


def client_for(key: str, *, timeout: float | anthropic.Timeout) -> anthropic.AsyncAnthropic:
    """Клиент с ключом для одного шага, внутри цикла событий. timeout — на один запрос
    (для потока — время между порциями). Пустой ключ — ValueError: без ключа SDK взял бы
    его из окружения."""
    if not key or key == _PLACEHOLDER_KEY:
        raise ValueError("empty Claude API key")
    return _base_client().with_options(api_key=key, timeout=timeout)


def set_http_client_for_tests(
    http_client: anthropic.DefaultAsyncHttpxClient | None, *, max_retries: int = 0
) -> None:
    """Только для тестов: все клиенты идут через этот http_client (обычно с
    httpx2.MockTransport). None — вернуть настоящий. max_retries=0 — тесты 5xx и 529
    не ждут повторов."""
    global _test_http_client, _test_max_retries
    _test_http_client = http_client
    _test_max_retries = max_retries
    _clients.clear()


async def close_client() -> None:
    """Закрывает пул соединений текущего цикла событий (конец команды терминала,
    остановка воркера или API). http_client тестов не закрывается: его закрывает тест."""
    client = _clients.pop(asyncio.get_running_loop(), None)
    if client is not None and _test_http_client is None:
        await client.close()
