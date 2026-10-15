import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { Callout, Card, Chip, EmptyState, Icon, Skeleton, useToast, type IconName } from '../../components';
import { useAdminAttention } from '../../features/admin/useAdminAttention';
import {
  fileProblem,
  isActive,
  isTooLarge,
  latestReport,
  refreshAfterUpload,
  sizeMb,
  stepStates,
  UPLOAD_STEPS,
  useDataUpload,
  useDataUploads,
  useUploadTennisData,
  type DataUpload,
  type DataUploadReport,
  type FileProblem,
  type StepState,
} from '../../features/admin/dataUploads';
import { cx } from '../../lib/cx';
import { formatDate, formatDateTime, formatNumber, formatTime } from '../../lib/format';
import { HowTo, Item, LoadError } from './parts';
import './DataTab.css';

/*
 * «Данные» (PANELS.data макета, этап 5, В1): файл tennis-data раз в неделю — статус архива,
 * как скачать и загрузить, ход обработки, отчет последней загрузки, история и другие источники.
 * Р14: в отчете нет сумм, исходов и имен участников — только сколько рассчитано и у скольких.
 */

/** Год файла для подсказок: файл текущего года — «2026.xlsx». */
function fileYear(): number {
  return new Date().getFullYear();
}

/** «2,4 МБ»; файл меньше 0,1 МБ — в килобайтах («6 КБ»), а не «0,0 МБ». */
function sizeText(bytes: number, t: TFunction): string {
  const mb = sizeMb(bytes);
  if (mb >= 0.1) return t('admin.data.size', { mb: formatNumber(mb, 1) });
  return t('admin.data.sizeKb', { kb: formatNumber(Math.max(1, Math.round(bytes / 1024))) });
}

const STEP_ICON: Record<StepState, IconName> = {
  done: 'check',
  run: 'refresh',
  wait: 'clock',
  failed: 'alert',
  skipped: 'arrowRight',
};

/** Ход обработки: шаги воркера и итог. */
function UploadProgress({ upload }: { upload: DataUpload }) {
  const { t } = useTranslation();
  const states = stepStates(upload);
  return (
    <div className="stack adm-data-progress">
      {upload.status === 'queued' && <div className="small muted">{t('admin.data.progress.queued', { name: upload.filename })}</div>}
      {upload.status === 'running' && <div className="small muted">{t('admin.data.progress.running', { name: upload.filename })}</div>}
      <ol className="adm-data-steps" aria-label={t('admin.data.progress.label')}>
        {UPLOAD_STEPS.map((step) => {
          const state = states[step];
          return (
            <li key={step} className={state}>
              <Icon name={STEP_ICON[state]} />
              <span>
                {t(`admin.data.steps.${step}`)}
                <span className="sr-only"> — {t(`admin.data.stepState.${state}`)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** «Новых матчей нет, ставки и банк не менялись» — только если и рассчитать было нечего. */
function nothingNew(report: DataUploadReport): boolean {
  return (report.unchanged || report.new_matches === 0) && report.settled_bets === 0;
}

/** Итог законченной загрузки: новых матчей нет, загружено или ошибка. */
function UploadResult({ upload }: { upload: DataUpload }) {
  const { t } = useTranslation();
  if (upload.status === 'failed') {
    return (
      <Callout kind="bad" role="alert">
        <b>{t('admin.data.result.failedTitle')}</b> {upload.error ?? t('admin.data.result.failedNoText')}
      </Callout>
    );
  }
  const report = upload.report;
  if (!report) return null;
  const to = report.matches_to ? formatDate(report.matches_to) : null;
  // новых матчей нет, но ставки могли рассчитаться по матчам, которые уже были в архиве
  if (nothingNew(report)) {
    return (
      <Callout kind="warn" icon="info" role="status">
        <b>{t('admin.data.result.noNewTitle')}</b>{' '}
        {to ? t('admin.data.result.noNew', { date: to }) : t('admin.data.result.noNewNoDate')}
      </Callout>
    );
  }
  return (
    <Callout kind="good" role="status">
      <b>{t('admin.data.result.doneTitle')}</b>{' '}
      {report.settled_bets > 0
        ? t('admin.data.result.done', {
            matches: t('admin.data.matches', { count: report.new_matches }),
            bets: t('admin.data.bets', { count: report.settled_bets }),
            people: t('admin.data.people', { count: report.people }),
          })
        : t('admin.data.result.doneNoBets', { matches: t('admin.data.matches', { count: report.new_matches }) })}
    </Callout>
  );
}

function resultToast(upload: DataUpload, t: TFunction): string {
  if (upload.status === 'failed') return t('admin.data.toast.failed');
  const report = upload.report;
  if (!report || nothingNew(report)) return t('admin.data.toast.noNew');
  const matches = t('admin.data.matches', { count: report.new_matches });
  if (report.settled_bets === 0) return t('admin.data.toast.doneNoBets', { matches });
  return t('admin.data.toast.done', { matches, bets: t('admin.data.bets', { count: report.settled_bets }) });
}

function problemText(problem: FileProblem, maxMb: number, t: TFunction): string {
  return t(`admin.data.problem.${problem}`, { limit: maxMb, year: fileYear() });
}

/** Карточка загрузки: статус архива, как скачать, «Выбрать файл .xlsx», ход и итог. */
function UploadCard({ data }: { data: ReturnType<typeof useDataUploads>['data'] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useQueryClient();
  const upload = useUploadTennisData();
  const [problem, setProblem] = useState<string | null>(null);
  // Загрузка, ход которой показываем: только что отправленная или идущая (после перезагрузки страницы)
  const running = data?.uploads.find((u) => isActive(u)) ?? null;
  const [watchId, setWatchId] = useState<number | null>(null);
  const shownId = watchId ?? running?.id ?? null;
  const watched = useDataUpload(shownId);
  const current = watched.data ?? (running && running.id === shownId ? running : null);
  const finished = useRef<number | null>(null);

  // Загрузка закончилась: данные заново и сообщение — один раз на загрузку
  useEffect(() => {
    if (!current || isActive(current) || finished.current === current.id) return;
    finished.current = current.id;
    refreshAfterUpload(client);
    if (watchId === current.id) toast.show(resultToast(current, t), { icon: current.status === 'failed' ? 'alert' : 'check' });
  }, [current, client, toast, t, watchId]);

  const archive = data?.archive;
  const maxMb = archive?.max_mb ?? 10;
  const year = fileYear();

  async function send(file: File) {
    setProblem(null);
    const local = fileProblem(file, maxMb);
    if (local) {
      setProblem(problemText(local, maxMb, t));
      return;
    }
    try {
      const created = await upload.mutateAsync(file);
      finished.current = null;
      setWatchId(created.id);
    } catch (error) {
      setProblem(isTooLarge(error) ? problemText('too_large', maxMb, t) : errorMessage(error));
    }
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // одно и то же имя можно выбрать снова (повторная загрузка того же файла ничего не ломает)
    event.target.value = '';
    if (file) void send(file);
  }

  const busy = upload.isPending || isActive(current);
  const lastLoad = archive?.last_load ?? null;
  // день следующей загрузки считает сервер (то же правило, что у «ждет результата» в «Ставках»)
  const next = archive?.next_upload ?? null;
  const last = data?.uploads.find((u) => u.status === 'done') ?? null;
  let chip;
  if (!archive) chip = null;
  else if (!lastLoad) {
    chip = (
      <Chip kind="warn" icon="alert">
        {t('admin.data.chip.never')}
      </Chip>
    );
  } else if (archive.stale) {
    chip = (
      <Chip kind="warn" icon="alert">
        {t('admin.data.chip.stale')}
      </Chip>
    );
  } else {
    chip = (
      <Chip kind="good" icon="check">
        {t('admin.data.chip.fresh', { date: formatDate(lastLoad) })}
      </Chip>
    );
  }

  return (
    <Card id="adm-upload" title={t('admin.data.upload.title')} subtitle={t('admin.data.upload.subtitle')} actions={chip ?? undefined}>
      {archive ? (
        <dl className="adm-kv3 adm-data-kv">
          <div>
            <dt>{t('admin.data.upload.matchesTo')}</dt>
            <dd>
              {archive.matches_to ? t('admin.data.upload.to', { date: formatDate(archive.matches_to) }) : '—'}
              <small>
                {lastLoad
                  ? t('admin.data.upload.loaded', { date: formatDate(lastLoad), time: formatTime(lastLoad) })
                  : t('admin.data.upload.neverLoaded')}
              </small>
            </dd>
          </div>
          <div>
            <dt>{t('admin.data.upload.by')}</dt>
            <dd>
              {last?.uploaded_by ?? '—'}
              <small>{t('admin.data.upload.byHint')}</small>
            </dd>
          </div>
          <div>
            <dt>{t('admin.data.upload.next')}</dt>
            <dd>
              {next && !archive.stale ? t('admin.data.upload.nextDay', { date: formatDate(next) }) : t('admin.data.upload.now')}
              <small>{t('admin.data.upload.reminder')}</small>
            </dd>
          </div>
        </dl>
      ) : (
        <Skeleton lines={2} />
      )}
      <ol className="adm-howsteps">
        <li>
          <b>{t('admin.data.how.downloadTitle')}</b> {t('admin.data.how.download', { file: `${year}.xlsx` })}
        </li>
        <li>
          <b>{t('admin.data.how.uploadTitle')}</b> {t('admin.data.how.upload', { limit: maxMb })}
        </li>
      </ol>
      <div className="row">
        {/* поле файла лежит поверх кнопки: нажатие и клавиатура — у самого поля, зона — вся кнопка */}
        <label className={cx('btn primary adm-file', busy && 'is-disabled')} aria-disabled={busy || undefined}>
          <Icon name="upload" />
          <span>{busy ? t('admin.data.upload.busy') : t('admin.data.upload.pick')}</span>
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="adm-file-input"
            disabled={busy}
            onChange={onPick}
          />
        </label>
      </div>
      <div className="adm-upload-status" aria-live="polite">
        {upload.isPending && <div className="small muted">{t('admin.data.progress.sending')}</div>}
        {current && isActive(current) && <UploadProgress upload={current} />}
        {current && !isActive(current) && watchId === current.id && <UploadResult upload={current} />}
        {problem && (
          <Callout kind="bad" role="alert">
            {problem}
          </Callout>
        )}
      </div>
      <HowTo>{t('admin.data.upload.delay')}</HowTo>
    </Card>
  );
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {sub && <small>{sub}</small>}
      </dd>
    </div>
  );
}

/** Отчет последней законченной загрузки (uploadReportCard макета). */
function ReportCard({ upload }: { upload: (DataUpload & { report: DataUploadReport }) | null }) {
  const { t } = useTranslation();
  if (!upload) {
    return (
      <Card title={t('admin.data.report.titleEmpty')}>
        <EmptyState>{t('admin.data.report.empty')}</EmptyState>
      </Card>
    );
  }
  const r = upload.report;
  const at = upload.finished_at ?? upload.created_at;
  const subtitle = [upload.filename, sizeText(upload.size_bytes, t), r.file_rows !== null ? t('admin.data.report.rows', { count: r.file_rows, n: formatNumber(r.file_rows) }) : null]
    .filter(Boolean)
    .join(' · ');
  const failedSteps = r.steps.filter((s) => s.status === 'failed');
  return (
    <Card title={t('admin.data.report.title', { date: formatDate(at), time: formatTime(at) })} subtitle={subtitle}>
      <dl className="adm-kv3 adm-kv4 adm-data-kv">
        <Cell label={t('admin.data.report.newMatches')} value={String(r.new_matches)} sub={r.matches_to ? t('admin.data.upload.to', { date: formatDate(r.matches_to) }) : undefined} />
        <Cell
          label={t('admin.data.report.settled')}
          value={String(r.settled_bets)}
          sub={
            r.settled_bets > 0
              ? t('admin.data.report.settledSub', { people: t('admin.data.people', { count: r.people }), legs: t('admin.data.legs', { count: r.legs }) })
              : undefined
          }
        />
        <Cell label={t('admin.data.report.closing')} value={String(r.closing)} sub={t('admin.data.report.closingSub')} />
        <Cell label={t('admin.data.report.linked')} value={String(r.linked)} sub={r.waiting ? t('admin.data.report.waiting', { count: r.waiting }) : t('admin.data.report.linkedSub')} />
      </dl>
      {r.unlinked > 0 && (
        <div className="stack adm-data-unlinked">
          <h4>{t('admin.data.report.unlinked', { count: r.unlinked })}</h4>
          {r.unlinked_matches.length > 0 && (
            <div className="adm-list">
              {r.unlinked_matches.map((m) => (
                <Item
                  key={m.match_id}
                  icon="link"
                  iconKind="warn"
                  title={`${m.player1} — ${m.player2} · ${formatDate(m.day)}`}
                  meta={t(`admin.data.report.reason.${m.reason}`)}
                />
              ))}
            </div>
          )}
          {r.not_found > 0 && <div className="small muted">{t('admin.data.report.notFound', { count: r.not_found })}</div>}
          <HowTo>{t('admin.data.report.mergeHint')}</HowTo>
        </div>
      )}
      <Callout kind="info">
        <div className="stack adm-data-notes">
          <span>
            <b>{t('admin.data.report.conflicts', { count: r.conflicts })}</b> {t('admin.data.report.conflictsText')}
          </span>
          <span>
            <b>{t('admin.data.report.manual', { count: r.manual })}</b> {t('admin.data.report.manualText')}
          </span>
          {r.legacy_legs > 0 && <span>{t('admin.data.report.legacy', { count: r.legacy_legs })}</span>}
        </div>
      </Callout>
      {failedSteps.map((s) => (
        <Callout key={s.step} kind="warn">
          {t('admin.data.report.stepFailed', { step: t(`admin.data.steps.${s.step}`), error: s.error ?? '' })}
        </Callout>
      ))}
      <HowTo>{t('admin.data.report.private')}</HowTo>
    </Card>
  );
}

function historyMeta(upload: DataUpload, t: TFunction): string {
  if (upload.status === 'failed') return upload.error ?? t('admin.data.history.failed');
  if (isActive(upload)) return t(`admin.data.history.${upload.status as 'queued' | 'running'}`);
  const r = upload.report;
  if (!r) return t('admin.data.history.noReport');
  const parts = [
    r.matches_to ? t('admin.data.history.to', { date: formatDate(r.matches_to) }) : null,
    t('admin.data.history.new', { count: r.new_matches }),
    r.settled_bets > 0 ? t('admin.data.history.settled', { count: r.settled_bets }) : t('admin.data.history.settledNone'),
    r.unlinked ? t('admin.data.history.unlinked', { count: r.unlinked }) : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** История загрузок (uploadsHistoryCard макета): последние 20, полный список — в журнале. */
function HistoryCard({ uploads }: { uploads: readonly DataUpload[] }) {
  const { t } = useTranslation();
  return (
    <Card title={t('admin.data.history.title')} subtitle={t('admin.data.history.subtitle', { count: uploads.length })}>
      {uploads.length ? (
        <div className="adm-list">
          {uploads.map((u) => (
            <Item
              key={u.id}
              icon="upload"
              iconKind={u.status === 'failed' ? 'bad' : isActive(u) ? 'info' : undefined}
              title={formatDateTime(u.created_at)}
              titleExtra={u.status === 'failed' ? <Chip kind="bad">{t('admin.data.history.failedChip')}</Chip> : undefined}
              meta={`${u.filename} · ${historyMeta(u, t)}`}
              side={<span className="xsmall muted">{sizeText(u.size_bytes, t)}</span>}
            />
          ))}
        </div>
      ) : (
        <EmptyState>{t('admin.data.history.empty')}</EmptyState>
      )}
    </Card>
  );
}

/** Другие источники (sourcesAdminCard макета). */
function SourcesCard() {
  const { t } = useTranslation();
  const attention = useAdminAttention();
  const status = attention.data?.archive_status;
  const nightly = status ? `${String(status.update_hour_utc).padStart(2, '0')}:${String(status.update_minute).padStart(2, '0')}` : null;
  return (
    <Card title={t('admin.data.sources.title')} subtitle={t('admin.data.sources.subtitle')}>
      <div className="adm-list">
        <Item icon="database" title={t('admin.data.sources.sackmann')} meta={nightly ? t('admin.data.sources.sackmannText', { time: nightly }) : t('admin.data.sources.sackmannTextNoTime')} />
        <Item icon="globe" title={t('admin.data.sources.news')} meta={t('admin.data.sources.newsText')} />
        <Item icon="clock" title={t('admin.data.sources.paid')} meta={t('admin.data.sources.paidText')} />
      </div>
    </Card>
  );
}

/** Вкладка «Данные» кабинета администратора. */
export function DataTab() {
  const uploads = useDataUploads();
  if (uploads.isError && !uploads.data) {
    return <LoadError error={uploads.error} onRetry={() => void uploads.refetch()} />;
  }
  const list = uploads.data?.uploads ?? [];
  return (
    <div className="adm-main">
      <div className="adm-col">
        <UploadCard data={uploads.data} />
        {uploads.data ? <ReportCard upload={latestReport(list)} /> : <Skeleton lines={4} />}
      </div>
      <div className="adm-col">
        {uploads.data ? <HistoryCard uploads={list} /> : <Skeleton lines={4} />}
        <SourcesCard />
      </div>
    </div>
  );
}
