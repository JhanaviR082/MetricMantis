FROM alpine:3.20
RUN apk add --no-cache iproute2
COPY netem.sh /netem.sh
# Strip Windows CRLF line endings so the shebang works on Linux.
RUN sed -i 's/\r//' /netem.sh && chmod 0555 /netem.sh
ENTRYPOINT ["/netem.sh"]
