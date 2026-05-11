"""
Tennis Analytics Bot — полная версия с tool use
Claude сам ищет данные, читает и пишет файлы через инструменты.
"""

import os
import json
import logging
import httpx
from pathlib import Path
from datetime import datetime

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    CallbackQueryHandler, ContextTypes, filters
)
import anthropic
from dotenv import load_dotenv

load_dotenv()

# ─────────────────────────────────────────────
# КОНФИГУРАЦИЯ
# ─────────────────────────────────────────────

TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
ANTHROPIC_KEY  = os.environ["ANTHROPIC_API_KEY"]
MODEL          = "claude-sonnet-4-6"
MAX_TOOL_LOOPS = 20  # защита от бесконечного цикла

BASE_DIR     = Path(__file__).parent / "Tennis-Analytics"
PLAYERS_DIR  = BASE_DIR / "Игроки"
HISTORY_FILE = BASE_DIR / "Ставки" / "История-ставок.json"

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(message)s",
    level=logging.INFO,
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("bot.log", encoding="utf-8"),
    ]
)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# СИСТЕМНЫЙ ПРОМПТ
# ─────────────────────────────────────────────

def load_instructions() -> str:
    files = [
        "CLAUDE.md",
        "Стратегия-ставок.md",
        "Инструкция-Авто.md",
        "Инструкция-1-заполнение-базы.md",
        "Инструкция-2-обновление.md",
        "Инструкция-3-анализ.md",
    ]
    parts = []
    for f in files:
        path = BASE_DIR / f
        if path.exists():
            parts.append(f"# {f}\n{path.read_text('utf-8')}")
    return "\n\n---\n\n".join(parts)

SYSTEM_PROMPT = load_instructions()
log.info(f"Инструкции загружены: {len(SYSTEM_PROMPT)} символов")

# ─────────────────────────────────────────────
# ОПРЕДЕЛЕНИЕ ИНСТРУМЕНТОВ ДЛЯ CLAUDE
# ─────────────────────────────────────────────

TOOLS = [
    {
        "name": "web_search",
        "description": (
            "Поиск информации в интернете. Используй для получения данных об игроках: "
            "рейтинг ATP, форма, результаты матчей, травмы. "
            "Источники: atptour.com, flashscore.com, tennisexplorer.com, sofascore.com"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Поисковый запрос на английском для лучших результатов"
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "read_file",
        "description": "Читает файл из базы данных Tennis-Analytics. Используй для чтения данных игроков и истории ставок.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Путь относительно папки Tennis-Analytics, например: Игроки/Синнер/05-текущее-состояние.json"
                }
            },
            "required": ["path"]
        }
    },
    {
        "name": "write_file",
        "description": "Записывает файл в базу данных Tennis-Analytics. Используй для сохранения данных игроков и истории ставок.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Путь относительно Tennis-Analytics, например: Игроки/Синнер/05-текущее-состояние.json"
                },
                "content": {
                    "type": "string",
                    "description": "Содержимое файла (JSON или текст)"
                }
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "list_files",
        "description": "Список файлов и папок в директории базы данных.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Путь относительно Tennis-Analytics. Пустая строка = корень."
                }
            },
            "required": ["path"]
        }
    },
    {
        "name": "read_template",
        "description": "Читает шаблон JSON из папки _Шаблоны для создания нового профиля игрока.",
        "input_schema": {
            "type": "object",
            "properties": {
                "template_name": {
                    "type": "string",
                    "description": "Имя шаблона: 01-личные-данные, 02-игровой-профиль, 03-физика-и-техника, 04-психология, 05-текущее-состояние, 06-матчи"
                }
            },
            "required": ["template_name"]
        }
    }
]

# ─────────────────────────────────────────────
# РЕАЛИЗАЦИЯ ИНСТРУМЕНТОВ
# ─────────────────────────────────────────────

async def tool_web_search(query: str) -> str:
    """Веб-поиск через DuckDuckGo (бесплатно, без ключа)."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "https://api.duckduckgo.com/",
                params={
                    "q": query,
                    "format": "json",
                    "no_html": "1",
                    "skip_disambig": "1"
                },
                headers={"User-Agent": "TennisAnalyticsBot/1.0"}
            )
            data = resp.json()

        results = []

        # Основной результат
        if data.get("AbstractText"):
            results.append(f"Краткое: {data['AbstractText']}")
            if data.get("AbstractURL"):
                results.append(f"Источник: {data['AbstractURL']}")

        # Related topics
        for topic in data.get("RelatedTopics", [])[:5]:
            if isinstance(topic, dict) and topic.get("Text"):
                results.append(f"• {topic['Text']}")

        if not results:
            return f"Поиск '{query}' не дал прямых результатов. Попробуй другой запрос."

        return "\n".join(results)

    except Exception as e:
        log.error(f"web_search error: {e}")
        return f"Ошибка поиска: {e}. Попробуй другой запрос."


def tool_read_file(path: str) -> str:
    """Читает файл из базы данных."""
    full_path = BASE_DIR / path
    if not full_path.exists():
        return f"Файл не найден: {path}"
    if not full_path.is_file():
        return f"Это не файл: {path}"
    try:
        return full_path.read_text("utf-8")
    except Exception as e:
        return f"Ошибка чтения {path}: {e}"


def tool_write_file(path: str, content: str) -> str:
    """Записывает файл в базу данных."""
    full_path = BASE_DIR / path
    try:
        full_path.parent.mkdir(parents=True, exist_ok=True)
        # Валидируем JSON если расширение .json
        if path.endswith(".json"):
            json.loads(content)  # проверка синтаксиса
        full_path.write_text(content, "utf-8")
        log.info(f"Файл записан: {path}")
        return f"OK: {path} записан ({len(content)} символов)"
    except json.JSONDecodeError as e:
        return f"Ошибка: невалидный JSON в {path}: {e}"
    except Exception as e:
        return f"Ошибка записи {path}: {e}"


def tool_list_files(path: str) -> str:
    """Список файлов в директории."""
    full_path = BASE_DIR / path if path else BASE_DIR
    if not full_path.exists():
        return f"Директория не найдена: {path}"
    try:
        items = []
        for item in sorted(full_path.iterdir()):
            marker = "/" if item.is_dir() else ""
            items.append(f"{'📁' if item.is_dir() else '📄'} {item.name}{marker}")
        return "\n".join(items) if items else "Директория пуста"
    except Exception as e:
        return f"Ошибка: {e}"


def tool_read_template(template_name: str) -> str:
    """Читает шаблон из _Шаблоны/."""
    # Нормализуем имя
    if not template_name.endswith(".json"):
        template_name += ".json"
    path = BASE_DIR / "_Шаблоны" / template_name
    if not path.exists():
        available = [p.name for p in (BASE_DIR / "_Шаблоны").iterdir()]
        return f"Шаблон не найден: {template_name}. Доступные: {available}"
    return path.read_text("utf-8")


async def execute_tool(name: str, inputs: dict) -> str:
    """Диспетчер инструментов."""
    log.info(f"Инструмент: {name}({list(inputs.keys())})")
    if name == "web_search":
        return await tool_web_search(inputs["query"])
    elif name == "read_file":
        return tool_read_file(inputs["path"])
    elif name == "write_file":
        return tool_write_file(inputs["path"], inputs["content"])
    elif name == "list_files":
        return tool_list_files(inputs.get("path", ""))
    elif name == "read_template":
        return tool_read_template(inputs["template_name"])
    else:
        return f"Неизвестный инструмент: {name}"

# ─────────────────────────────────────────────
# ГЛАВНЫЙ ЦИКЛ CLAUDE + TOOL USE
# ─────────────────────────────────────────────

async def run_agent(user_message: str, status_callback=None) -> str:
    """
    Запускает Claude с tool use loop.
    Claude вызывает инструменты пока не сформирует финальный текстовый ответ.
    status_callback(text) — функция для отправки промежуточных статусов.
    """
    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_KEY)

    messages = [{"role": "user", "content": user_message}]

    # Добавляем контекст истории ставок в первое сообщение
    history_context = ""
    if HISTORY_FILE.exists():
        data = json.loads(HISTORY_FILE.read_text("utf-8"))
        data["ставки"] = data.get("ставки", [])[-10:]  # последние 10
        history_context = (
            "\n\n## Текущая история ставок:\n"
            f"```json\n{json.dumps(data, ensure_ascii=False, indent=2)}\n```"
        )
        messages[0]["content"] = user_message + history_context

    tool_calls_count = 0

    for loop in range(MAX_TOOL_LOOPS):
        resp = await client.messages.create(
            model=MODEL,
            max_tokens=4000,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )

        log.info(f"Цикл {loop+1}: stop_reason={resp.stop_reason}, блоков={len(resp.content)}")

        # Финальный ответ — Claude закончил
        if resp.stop_reason == "end_turn":
            text_blocks = [b.text for b in resp.content if hasattr(b, "text")]
            return "\n".join(text_blocks)

        # Claude хочет использовать инструменты
        if resp.stop_reason == "tool_use":
            # Добавляем ответ Claude в историю сообщений
            messages.append({"role": "assistant", "content": resp.content})

            # Собираем результаты всех tool_use блоков
            tool_results = []
            for block in resp.content:
                if block.type != "tool_use":
                    continue

                tool_calls_count += 1
                tool_name   = block.name
                tool_inputs = block.input

                # Статус пользователю
                status_text = {
                    "web_search":    f"Ищу: {tool_inputs.get('query', '')}...",
                    "read_file":     f"Читаю: {tool_inputs.get('path', '')}",
                    "write_file":    f"Записываю: {tool_inputs.get('path', '')}",
                    "list_files":    f"Смотрю директорию: {tool_inputs.get('path', '') or 'корень'}",
                    "read_template": f"Загружаю шаблон: {tool_inputs.get('template_name', '')}",
                }.get(tool_name, f"Выполняю: {tool_name}")

                if status_callback:
                    await status_callback(status_text)

                # Выполняем инструмент
                result = await execute_tool(tool_name, tool_inputs)

                tool_results.append({
                    "type":        "tool_result",
                    "tool_use_id": block.id,
                    "content":     result,
                })

            # Возвращаем результаты инструментов в Claude
            messages.append({"role": "user", "content": tool_results})

        else:
            # Неожиданный stop_reason
            text_blocks = [b.text for b in resp.content if hasattr(b, "text")]
            return "\n".join(text_blocks) or f"Неожиданное завершение: {resp.stop_reason}"

    return f"Превышен лимит циклов ({MAX_TOOL_LOOPS}). Попробуйте ещё раз."

# ─────────────────────────────────────────────
# УПРАВЛЕНИЕ ИСТОРИЕЙ СТАВОК
# ─────────────────────────────────────────────

def read_history() -> dict:
    if HISTORY_FILE.exists():
        return json.loads(HISTORY_FILE.read_text("utf-8"))
    return {
        "meta": {
            "дата_создания": datetime.now().strftime("%Y-%m-%d"),
            "последнее_обновление": "",
            "текущий_банк": None,
        },
        "статистика": {
            "всего_ставок": 0, "победы": 0, "поражения": 0,
            "винрейт_процент": None, "серия_текущая": "",
        },
        "ставки": [],
    }

def save_result(bet_id: int, status: str) -> dict:
    data   = read_history()
    ставки = data.get("ставки", [])

    for с in ставки:
        if с.get("id") == bet_id:
            с["результат"]["статус"] = status
            банк  = data["meta"].get("текущий_банк") or 0
            сумма = с.get("сумма_ставки", 0)
            кэф   = с.get("экспресс", {}).get("итоговый_кэф", 1)

            if status == "победа":
                прибыль = round(сумма * кэф - сумма, 2)
                с["результат"]["банк_после"]     = round(банк + прибыль, 2)
                с["результат"]["прибыль_убыток"] = прибыль
            elif status == "поражение":
                с["результат"]["банк_после"]     = round(банк - сумма, 2)
                с["результат"]["прибыль_убыток"] = -сумма
            else:
                с["результат"]["банк_после"]     = банк
                с["результат"]["прибыль_убыток"] = 0

            data["meta"]["текущий_банк"] = с["результат"]["банк_после"]
            break

    завершённые = [с for с in ставки if с.get("результат", {}).get("статус")]
    победы = sum(1 for с in завершённые if с["результат"]["статус"] == "победа")
    data["статистика"].update({
        "всего_ставок":    len(завершённые),
        "победы":          победы,
        "поражения":       len(завершённые) - победы,
        "винрейт_процент": round(победы / len(завершённые) * 100, 1) if завершённые else None,
    })

    data["meta"]["последнее_обновление"] = datetime.now().strftime("%Y-%m-%d")
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    return data

def get_last_open_bet() -> dict | None:
    data = read_history()
    for с in reversed(data.get("ставки", [])):
        if not с.get("результат", {}).get("статус"):
            return с
    return None

# ─────────────────────────────────────────────
# TELEGRAM ОБРАБОТЧИКИ
# ─────────────────────────────────────────────

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Tennis Analytics Bot\n\n"
        "Отправьте матчи в формате:\n\n"
        "Текущий банк: 10 000₽\n"
        "Букмекер: Лига Ставок\n\n"
        "События:\n"
        "Синнер vs Медведев, Рим, грунт\n"
        "Кэфы: П1 = 1.35, П2 = 3.10\n"
        "Фора: П1(-1.5) = 1.80, П2(+1.5) = 1.95\n\n"
        "/статистика — банк и винрейт\n"
        "/игроки — список базы\n"
        "/результат — внести итог ставки"
    )

async def cmd_stats(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    data   = read_history()
    meta   = data.get("meta", {})
    stat   = data.get("статистика", {})
    ставки = data.get("ставки", [])

    последние = []
    for с in reversed(ставки[-5:]):
        st     = с.get("результат", {}).get("статус") or "⏳"
        кэф    = с.get("экспресс", {}).get("итоговый_кэф", "?")
        сумма  = с.get("сумма_ставки", "?")
        дата   = с.get("дата", "?")
        иконка = "✅" if st == "победа" else ("❌" if st == "поражение" else "⏳")
        последние.append(f"{иконка} {дата} | ×{кэф} | {сумма}₽")

    await update.message.reply_text(
        f"Банк: {meta.get('текущий_банк', '?')}₽\n"
        f"Ставок: {stat.get('всего_ставок', 0)} "
        f"(W {stat.get('победы', 0)} / L {stat.get('поражения', 0)})\n"
        f"Винрейт: {stat.get('винрейт_процент', '?')}%\n\n"
        "Последние:\n" + ("\n".join(последние) or "нет")
    )

async def cmd_players(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not PLAYERS_DIR.exists():
        await update.message.reply_text("База игроков пуста.")
        return
    players = sorted(p.name for p in PLAYERS_DIR.iterdir() if p.is_dir())
    if not players:
        await update.message.reply_text("База игроков пуста.")
        return
    await update.message.reply_text(
        f"В базе {len(players)} игроков:\n\n" +
        "\n".join(f"• {p}" for p in players)
    )

async def cmd_result(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    с = get_last_open_bet()
    if not с:
        await update.message.reply_text("Все ставки закрыты.")
        return

    bet_id = с["id"]
    кэф    = с.get("экспресс", {}).get("итоговый_кэф", "?")
    сумма  = с.get("сумма_ставки", "?")
    дата   = с.get("дата", "?")
    события = "\n".join(
        f"• {e.get('игрок1')} vs {e.get('игрок2')} → {e.get('выбранный_рынок')} ×{e.get('выбранный_кэф')}"
        for e in с.get("события", [])
    ) or "—"

    await update.message.reply_text(
        f"Ставка #{bet_id} от {дата}\n"
        f"Кэф: ×{кэф} | Сумма: {сумма}₽\n\n"
        f"{события}\n\nВыберите результат:",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Победа",    callback_data=f"res:{bet_id}:победа"),
            InlineKeyboardButton("❌ Поражение", callback_data=f"res:{bet_id}:поражение"),
            InlineKeyboardButton("↩️ Возврат",   callback_data=f"res:{bet_id}:возврат"),
        ]])
    )

async def cb_result(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    _, bet_id_str, status = query.data.split(":")
    data  = save_result(int(bet_id_str), status)
    банк  = data["meta"].get("текущий_банк", "?")
    винр  = data["статистика"].get("винрейт_процент", "?")
    иконка = "✅" if status == "победа" else ("❌" if status == "поражение" else "↩️")
    await query.edit_message_text(
        f"{иконка} Ставка #{bet_id_str}: {status}\n"
        f"Банк: {банк}₽ | Винрейт: {винр}%"
    )

async def cb_open_result(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await cmd_result(update, ctx)

async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Главный обработчик — запускает агента с tool use loop."""
    text = update.message.text
    log.info(f"Запрос: {text[:60]}...")

    # Сообщение-статус которое будем обновлять
    status_msg = await update.message.reply_text("Запускаю анализ...")

    # Счётчик шагов для обновления статуса
    step = [0]

    async def update_status(new_text: str):
        step[0] += 1
        try:
            await status_msg.edit_text(f"Шаг {step[0]}: {new_text}")
        except Exception:
            pass  # ignore edit errors

    try:
        response = await run_agent(text, status_callback=update_status)

        # Удаляем статусное сообщение
        await status_msg.delete()

        # Отправляем ответ (разбиваем если > 4096 символов)
        for i in range(0, len(response), 4000):
            await update.message.reply_text(response[i:i+4000])

        # Кнопка результата если в ответе есть экспресс
        if any(kw in response.upper() for kw in ("ЭКСПРЕСС", "ИТОГОВЫЙ КЭФ", "СУММА СТАВКИ")):
            await update.message.reply_text(
                "После матча внесите результат:",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("Внести результат", callback_data="open_result")
                ]])
            )

    except Exception as e:
        log.error(f"Ошибка агента: {e}", exc_info=True)
        await status_msg.edit_text(f"Ошибка: {str(e)[:300]}\n\nПопробуйте ещё раз.")

# ─────────────────────────────────────────────
# ЗАПУСК
# ─────────────────────────────────────────────

def main():
    app = Application.builder().token(TELEGRAM_TOKEN).build()

    app.add_handler(CommandHandler("start",      cmd_start))
    app.add_handler(CommandHandler("статистика", cmd_stats))
    app.add_handler(CommandHandler("игроки",     cmd_players))
    app.add_handler(CommandHandler("результат",  cmd_result))

    app.add_handler(CallbackQueryHandler(cb_result,      pattern=r"^res:"))
    app.add_handler(CallbackQueryHandler(cb_open_result, pattern=r"^open_result$"))

    app.add_handler(MessageHandler(
        filters.TEXT & ~filters.COMMAND, handle_message
    ))

    log.info("Бот запущен с tool use")
    app.run_polling(drop_pending_updates=True)

if __name__ == "__main__":
    main()
