#!/usr/bin/env bash
# Проверка всего репозитория по правилам из CLAUDE.md. Запускается в CI и вручную:
#   bash scripts/check-rules.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0

# 1. Буква «е с двумя точками» (U+0451 и U+0401) в файлах.
pattern=$(printf '\321\221|\320\201')
hits=$(git ls-files -z | LC_ALL=C xargs -0 grep -nIE "$pattern" | head -20)
if [ -n "$hits" ]; then
  echo "Ошибка: буква «е с двумя точками» в файлах, пишите «е»:" >&2
  printf '%s\n' "$hits" >&2
  fail=1
fi

# 2. Claude не автор и не коммитер, в сообщениях нет строк о соавторстве.
bad=$(git log --format='%h %an <%ae> / %cn <%ce>' | grep -iE 'claude|anthropic' | head -10)
if [ -n "$bad" ]; then
  echo "Ошибка: коммиты с автором или коммитером Claude:" >&2
  printf '%s\n' "$bad" >&2
  fail=1
fi
bad=$(git log --format='%h %B' | grep -iE '(co-authored-by:.*(claude|anthropic)|claude-session:|generated with .*claude)' | head -10)
if [ -n "$bad" ]; then
  echo "Ошибка: строки о соавторстве Claude в сообщениях коммитов:" >&2
  printf '%s\n' "$bad" >&2
  fail=1
fi

[ $fail -eq 0 ] && echo "Правила CLAUDE.md соблюдены."
exit $fail
