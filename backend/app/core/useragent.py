"""Короткое имя устройства по заголовку User-Agent: «Chrome · Windows», «Safari · iOS».

Имена браузеров и систем не переводятся, поэтому хранятся в БД как есть
(sessions.device_label, trusted_devices.device_label). Не удалось узнать ни браузер,
ни систему — пустая строка, и фронтенд показывает свою подпись «Неизвестное устройство».
"""

import re

USER_AGENT_MAX_LENGTH = 512

# Порядок важен: Edge и Opera содержат «Chrome», Chrome содержит «Safari»
_BROWSERS = (
    ("Edge", re.compile(r"Edg(e|A|iOS)?/")),
    ("Opera", re.compile(r"OPR/|Opera")),
    ("Yandex", re.compile(r"YaBrowser/")),
    ("Firefox", re.compile(r"Firefox/|FxiOS/")),
    ("Chrome", re.compile(r"Chrome/|CriOS/")),
    ("Safari", re.compile(r"Safari/")),
)
_SYSTEMS = (
    ("iOS", re.compile(r"iPhone|iPad|iPod")),
    ("Android", re.compile(r"Android")),
    ("Windows", re.compile(r"Windows")),
    ("macOS", re.compile(r"Mac OS X|Macintosh")),
    ("Linux", re.compile(r"Linux|X11")),
)


def clip_user_agent(user_agent: str | None) -> str | None:
    if not user_agent:
        return None
    return user_agent[:USER_AGENT_MAX_LENGTH]


def device_label(user_agent: str | None) -> str:
    if not user_agent:
        return ""
    browser = next((name for name, rx in _BROWSERS if rx.search(user_agent)), "")
    system = next((name for name, rx in _SYSTEMS if rx.search(user_agent)), "")
    return " · ".join(part for part in (browser, system) if part)
