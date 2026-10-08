// Ключи запросов TanStack Query: по одному месту на ресурс, чтобы сбрасывать кэш точно.
export const meQueryKey = ['me'] as const;
// Не под ['me']: подписка клиента запросов на ['me'] ставит пояс показа дат из данных профиля
export const notificationsQueryKey = ['notifications'] as const;
