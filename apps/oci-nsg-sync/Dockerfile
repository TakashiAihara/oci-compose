FROM alpine:3.20

RUN apk add --no-cache \
      python3 py3-pip \
      bind-tools \
      jq \
      curl \
      ca-certificates \
      tzdata \
    && pip3 install --break-system-packages --no-cache-dir 'oci-cli==3.49.4' \
    && rm -rf /var/cache/apk/* /root/.cache

COPY sync.sh /usr/local/bin/sync.sh
COPY crontab /etc/crontabs/root
RUN chmod +x /usr/local/bin/sync.sh

VOLUME /var/lib/oci-nsg-sync

CMD ["crond", "-f", "-L", "/dev/stdout"]
