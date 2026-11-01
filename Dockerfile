FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

ARG TARGETARCH

# bash and curl run install.sh, which fetches releases for agent upgrades, SSH
# provisioning and server updates. openssh-client provides the `ssh` the server
# spawns for SSH-backed agents and the `ssh-keygen` it uses for managed keys.
RUN apk add --no-cache bash ca-certificates curl openssh-client tzdata \
    && addgroup -S -g 10001 redoor \
    && adduser -S -D -u 10001 -G redoor -h /home/redoor redoor \
    && mkdir -p /etc/redoor /home/redoor/.local/share/redoor \
    && chown -R 10001:10001 /home/redoor

COPY target/container/${TARGETARCH}/redoor /usr/local/bin/redoor
COPY --chown=10001:10001 docker/demo-config.toml /etc/redoor/config.toml

ENV HOME=/home/redoor

USER 10001:10001
WORKDIR /home/redoor

EXPOSE 7666

ENTRYPOINT ["/usr/local/bin/redoor"]
CMD ["server", "--config", "/etc/redoor/config.toml"]
