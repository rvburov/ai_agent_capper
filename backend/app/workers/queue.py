"""Очередь arq: ключи с префиксом приложения и соединение для постановки задач.

Отдельно от app.workers.main: воркер запускается как python -m app.workers.main, и этот
модуль у него — __main__. Сервис, которому нужна очередь (загрузка файла, прогрев кэша,
анализ, быстрая проверка урока), импортировал бы app.workers.main второй раз, уже под
своим именем, и вторая копия ставила бы префикс поверх первого (capper:capper:arq:job:) —
воркер перестал бы находить задачи («job expired»). Этот модуль никогда не бывает
__main__, поэтому импортируется один раз; ставить задачи — только через create_queue_pool()
отсюда.

Префикс — CAPPER_REDIS_PREFIX: тесты и разные окружения в одном Redis не берут чужие
задачи и не видят чужих результатов.
"""

from types import FunctionType

import arq.connections
import arq.constants
import arq.jobs
import arq.worker
from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from app.core.config import Settings, get_settings

# Имена ключей arq. В arq 0.28 они — константы модулей (arq.constants), настройки
# префикса нет; модули импортируют их к себе по имени, поэтому меняются копии в каждом
_ARQ_KEY_NAMES = (
    "default_queue_name",
    "job_key_prefix",
    "in_progress_key_prefix",
    "result_key_prefix",
    "retry_key_prefix",
    "abort_jobs_ss",
)
_ARQ_MODULES = (arq.constants, arq.connections, arq.jobs, arq.worker)
# Исходные имена ключей хранятся на самом arq.constants: если этот файл все же исполнится
# второй раз (другой копией модуля), он возьмет их оттуда, а не из констант, которые первая
# копия уже снабдила префиксом
_DEFAULTS_ATTR = "_capper_default_keys"


def _default_keys() -> dict[str, str]:
    stored = getattr(arq.constants, _DEFAULTS_ATTR, None)
    if isinstance(stored, dict):
        return {str(name): str(value) for name, value in stored.items()}
    keys = {name: str(getattr(arq.constants, name)) for name in _ARQ_KEY_NAMES}
    setattr(arq.constants, _DEFAULTS_ATTR, dict(keys))
    return keys


_ARQ_DEFAULT_KEYS = _default_keys()
# Параметры, у которых очередь по умолчанию — значение константы на момент импорта arq
# (Python вычисляет его при определении функции): Job(job_id, pool) без них искал бы
# задачу в очереди без префикса и для ждущей задачи отвечал not_found
_ARQ_QUEUE_PARAMS: tuple[tuple[object, str], ...] = (
    (arq.jobs.Job.__init__, "_queue_name"),
    (arq.connections.ArqRedis.__init__, "default_queue_name"),
    (arq.connections.create_pool, "default_queue_name"),
    (arq.worker.Worker.__init__, "queue_name"),
)


def _set_param_default(func: object, param: str, value: str) -> None:
    """Новое значение параметра по умолчанию: именованный после * — в __kwdefaults__,
    обычный — в __defaults__ (они выровнены по последним параметрам)."""
    if not isinstance(func, FunctionType):
        raise TypeError(f"{func!r}: ожидается функция")
    kwdefaults = func.__kwdefaults__ or {}
    if param in kwdefaults:
        func.__kwdefaults__ = {**kwdefaults, param: value}
        return
    names = func.__code__.co_varnames[: func.__code__.co_argcount]
    defaults = func.__defaults__ or ()
    index = names.index(param) - (len(names) - len(defaults)) if param in names else -1
    if index < 0:
        raise ValueError(f"{func.__qualname__}: нет параметра {param} со значением по умолчанию")
    func.__defaults__ = (*defaults[:index], value, *defaults[index + 1 :])


def apply_redis_prefix(prefix: str) -> None:
    """Ключи arq с префиксом приложения: capper:arq:job:<id>, capper:arq:result:<id> и т. д.
    Меняются константы модулей и очередь по умолчанию в параметрах Job, ArqRedis,
    create_pool и Worker. Действует на весь процесс (воркер или API). Значение всегда
    считается от исходных имен arq, поэтому повторный вызов (и из второй копии модуля)
    префикс не удваивает. Проверка, что ни один ключ не ушел без префикса, —
    tests/test_workers.py: после обновления arq она покажет, если в нем появились новые
    ключи или параметры."""
    for module in _ARQ_MODULES:
        for name, default in _ARQ_DEFAULT_KEYS.items():
            if hasattr(module, name):
                setattr(module, name, prefix + default)
    queue_name = prefix + _ARQ_DEFAULT_KEYS["default_queue_name"]
    for func, param in _ARQ_QUEUE_PARAMS:
        _set_param_default(func, param, queue_name)


def make_queue_name(settings: Settings) -> str:
    """Очередь arq с префиксом приложения: capper:arq:queue."""
    return f"{settings.redis_prefix}{_ARQ_DEFAULT_KEYS['default_queue_name']}"


# При импорте: настройки воркера, check_health и create_queue_pool работают уже с префиксом
apply_redis_prefix(get_settings().redis_prefix)


async def create_queue_pool(
    settings: Settings | None = None, *, retries: int | None = None
) -> ArqRedis:
    """Соединение для постановки задач: та же очередь и те же ключи, что у воркера.
    Статус уже поставленной задачи — Job(job_id, pool): очередь по умолчанию у Job тоже
    с префиксом (apply_redis_prefix). retries — попыток соединиться (по умолчанию arq —
    5 раз с паузой в секунду); 0 — для необязательных задач вроде прогрева кэша."""
    settings = settings or get_settings()
    apply_redis_prefix(settings.redis_prefix)
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    if retries is not None:
        redis_settings.conn_retries = retries
    return await create_pool(redis_settings, default_queue_name=make_queue_name(settings))
