// Ключи запросов личного кабинета. Префикс не 'me': по ключу ['me'] клиент запросов
// берет пояс показа дат (queryClient.ts), и данные сеансов не должны туда попадать.
export const accountKeys = {
  all: ['account'] as const,
  sessions: ['account', 'sessions'] as const,
  trustedDevices: ['account', 'trusted-devices'] as const,
  loginEvents: ['account', 'login-events'] as const,
  recoveryCodes: ['account', 'recovery-codes'] as const,
  // Сводка «Доступ к аккаунту» у администратора: число участников и ждущих приглашений
  adminPeople: ['account', 'admin-people'] as const,
  adminInvites: ['account', 'admin-invites'] as const,
};

export const publicSettingsKey = ['settings'] as const;
