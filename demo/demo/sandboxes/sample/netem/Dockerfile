FROM alpine:3.20
RUN apk add --no-cache iproute2
COPY netem.sh /netem.sh
RUN chmod 0555 /netem.sh
ENTRYPOINT ["/netem.sh"]
