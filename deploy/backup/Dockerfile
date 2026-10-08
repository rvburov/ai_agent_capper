# Образ бэкапов: pg_dump и pg_restore той же major-версии, что сервер (postgres:18),
# age для шифрования, rclone для S3-совместимого хранилища, cron из busybox.
# Сборка — из deploy/docker-compose.yml (сервис backup). Секретов в образе нет.

# age собирается из исходников известной версии: модуль проверяется по sum.golang.org
FROM golang:1.26-alpine AS age
ARG AGE_VERSION=v1.3.2
RUN CGO_ENABLED=0 GOBIN=/out go install -trimpath -ldflags="-s -w" \
      "filippo.io/age/cmd/age@${AGE_VERSION}" "filippo.io/age/cmd/age-keygen@${AGE_VERSION}"

# rclone — статический бинарник из официального образа
FROM rclone/rclone:1.75 AS rclone

FROM postgres:18-alpine
COPY --from=age /out/age /out/age-keygen /usr/local/bin/
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY common.sh backup.sh restore.sh restore-check.sh healthcheck.sh entrypoint.sh /usr/local/bin/
COPY crontab /etc/crontabs/root
RUN chmod 0755 /usr/local/bin/*.sh \
 && chmod 0600 /etc/crontabs/root \
 && age --version && rclone version > /dev/null
ENV BACKUP_DIR=/backups
WORKDIR /backups
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["crond", "-f", "-d", "8"]
