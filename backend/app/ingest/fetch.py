"""Файлы источников данных: скачивание по HTTP или чтение из локальной папки.

    async with DataSource.http(settings.sackmann_base_url) as source:
        file = await source.fetch("atp_matches_2024.csv")   # None — файла нет (404)

Папка (--dir у команды загрузки) нужна без сети и для проверки на своих файлах: в ней
ищется тот же относительный путь («2024/2024.xlsx»), а если его нет — файл с тем же
именем прямо в папке («2024.xlsx»).

HTTP: переходы по редиректам, таймаут 60 с, 3 повтора с паузой при сетевой ошибке и
ответах 5xx и 429, User-Agent AI-Capper/<версия>. 404 и 410 — файла нет (у Сакманна
файла текущего года может еще не быть), прочие ответы 4xx — ошибка без повторов.
Ответ больше 50 МБ не дочитывается: настоящие файлы в десятки раз меньше.

Адрес закрытого зеркала может содержать логин и пароль (https://user:pass@host/...):
httpx отправит их как basic auth, а в лог, тексты ошибок, отчет и FetchedFile.url адрес
попадает без них.
"""

import asyncio
import hashlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import TracebackType
from typing import Any, Self
from urllib.parse import quote

import httpx
import structlog

from app.core.config import get_settings
from app.core.i18n import t
from app.ingest.runs import IngestError

log = structlog.get_logger(__name__)

TIMEOUT_SECONDS = 60.0
RETRIES = 3
RETRY_PAUSE_SECONDS = 2.0
MAX_BYTES = 50 * 1024 * 1024
_MISSING = frozenset({404, 410})
_RETRY_STATUSES = frozenset({429})


class FetchError(IngestError):
    """Файл не получен: нет связи после повторов, ответ 4xx/5xx, слишком большой файл.
    message — текст для журнала загрузок: адрес в нем без логина и пароля. status — код
    ответа HTTP, если сервер ответил (403 у tennis-data — закрыто Cloudflare), иначе None."""

    def __init__(self, key: str, /, *, status: int | None = None, **params: Any) -> None:
        super().__init__(key, **params)
        self.status = status


@dataclass(frozen=True)
class FetchedFile:
    """Полученный файл. path — относительный путь, как его запросили (ключ в отчете и
    в last_ok_file_hashes), url — откуда взят на самом деле (после редиректов или file://)."""

    path: str
    content: bytes
    sha256: str
    url: str


def public_url(url: str | httpx.URL) -> str:
    """Адрес для лога, журнала загрузок и отчета: без логина и пароля."""
    return str(httpx.URL(url).copy_with(userinfo=b""))


def _checked_path(relative_path: str) -> PurePosixPath:
    """Только относительный путь внутри источника: без «..», без корня."""
    path = PurePosixPath(relative_path)
    if not relative_path or path.is_absolute() or ".." in path.parts or "\\" in relative_path:
        raise ValueError(t("ingest.fetch.bad_path", path=relative_path))
    return path


def _make_file(path: str, content: bytes, url: str) -> FetchedFile:
    return FetchedFile(
        path=path, content=content, sha256=hashlib.sha256(content).hexdigest(), url=url
    )


class DataSource:
    """Источник файлов: адрес HTTP (base_url) или локальная папка (directory)."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        directory: Path | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        retries: int = RETRIES,
        retry_pause: float = RETRY_PAUSE_SECONDS,
        max_bytes: int = MAX_BYTES,
    ) -> None:
        if (base_url is None) == (directory is None):
            raise ValueError("DataSource: нужен ровно один из base_url и directory")
        self.base_url = base_url.rstrip("/") if base_url is not None else None
        self.directory = directory
        self.retries = retries
        self.retry_pause = retry_pause
        self.max_bytes = max_bytes
        self._client: httpx.AsyncClient | None = None
        if base_url is not None:
            self._client = httpx.AsyncClient(
                follow_redirects=True,
                timeout=TIMEOUT_SECONDS,
                headers={"User-Agent": f"AI-Capper/{get_settings().version}"},
                transport=transport,
            )

    @classmethod
    def http(cls, base_url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> Self:
        return cls(base_url=base_url, transport=transport)

    @classmethod
    def local(cls, directory: Path | str) -> Self:
        return cls(directory=Path(directory))

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    @property
    def location(self) -> str:
        """Откуда берутся файлы: адрес без логина и пароля или папка (для отчета)."""
        return public_url(self.base_url) if self.base_url is not None else str(self.directory)

    async def fetch(self, relative_path: str) -> FetchedFile | None:
        """Файл по относительному пути. None — файла нет (404, 410, нет в папке).
        Ошибка получения — FetchError, неверный путь — ValueError."""
        path = _checked_path(relative_path)
        if self.directory is not None:
            return await asyncio.to_thread(self._read_local, relative_path, path)
        return await self._download(relative_path, path)

    def _read_local(self, relative_path: str, path: PurePosixPath) -> FetchedFile | None:
        assert self.directory is not None
        for candidate in (self.directory.joinpath(*path.parts), self.directory / path.name):
            if candidate.is_file():
                if candidate.stat().st_size > self.max_bytes:
                    raise self._too_large(str(candidate))
                try:
                    content = candidate.read_bytes()
                except OSError as exc:
                    raise FetchError(
                        "ingest.fetch.read_failed",
                        path=str(candidate),
                        error=exc.strerror or type(exc).__name__,
                    ) from None
                return _make_file(relative_path, content, candidate.resolve().as_uri())
        return None

    def _too_large(self, where: str) -> FetchError:
        return FetchError("ingest.fetch.too_large", url=where, limit=-(-self.max_bytes // 2**20))

    async def _download(self, relative_path: str, path: PurePosixPath) -> FetchedFile | None:
        assert self._client is not None and self.base_url is not None
        url = f"{self.base_url}/{quote(str(path))}"
        shown = public_url(url)
        attempt = 0
        while True:
            attempt += 1
            try:
                return await self._get(url, shown, relative_path)
            except _Retryable as exc:
                if attempt > self.retries:
                    raise FetchError(
                        "ingest.fetch.failed", url=shown, reason=exc.reason, status=exc.status
                    ) from None
                log.warning("ingest.fetch_retry", url=shown, attempt=attempt, reason=exc.reason)
                await asyncio.sleep(self.retry_pause * attempt)

    async def _get(self, url: str, shown: str, relative_path: str) -> FetchedFile | None:
        """GET url; shown — тот же адрес без логина и пароля, для текстов ошибок."""
        assert self._client is not None
        try:
            async with self._client.stream("GET", url) as response:
                if response.status_code in _MISSING:
                    return None
                status = response.status_code
                if status >= 500 or status in _RETRY_STATUSES:
                    raise _Retryable(t("ingest.fetch.http_status", status=status), status)
                if status >= 400:
                    reason = t("ingest.fetch.http_status", status=status)
                    raise FetchError("ingest.fetch.failed", url=shown, reason=reason, status=status)
                declared = response.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > self.max_bytes:
                    raise self._too_large(shown)
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > self.max_bytes:
                        raise self._too_large(shown)
                    chunks.append(chunk)
                return _make_file(relative_path, b"".join(chunks), public_url(response.url))
        except httpx.TransportError as exc:
            # Только вид ошибки (ConnectTimeout, ConnectError): в тексте бывает адрес прокси
            raise _Retryable(t("ingest.fetch.network", error=type(exc).__name__)) from None
        except httpx.RequestError as exc:
            # Слишком много редиректов, битое сжатие: повтор не поможет
            reason = t("ingest.fetch.network", error=type(exc).__name__)
            raise FetchError("ingest.fetch.failed", url=shown, reason=reason) from None


class _Retryable(Exception):
    """Сбой, после которого стоит повторить запрос: сеть, 5xx, 429."""

    def __init__(self, reason: str, status: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status
