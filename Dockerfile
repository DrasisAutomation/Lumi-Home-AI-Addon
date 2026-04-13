ARG BUILD_FROM=ghcr.io/hassio-addons/base:14.2.2
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm

COPY . /app
WORKDIR /app

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
