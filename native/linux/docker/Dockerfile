FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-gi gir1.2-gtk-4.0 git ca-certificates xvfb x11-utils x11vnc novnc websockify openbox dbus-x11 fonts-dejavu-core xterm tini util-linux && rm -rf /var/lib/apt/lists/*
COPY release.tar.gz /tmp/release.tar.gz
RUN mkdir -p /opt/heav3ns && tar -xzf /tmp/release.tar.gz --strip-components=1 -C /opt/heav3ns && rm /tmp/release.tar.gz && useradd -m -u 1001 desktop && mkdir -p /home/desktop/Projects && chown -R desktop:desktop /home/desktop
COPY start.sh /usr/local/bin/start-desktop
RUN chmod +x /usr/local/bin/start-desktop
USER desktop
ENV HOME=/home/desktop DISPLAY=:0 GTK_A11Y=none GSK_RENDERER=cairo
WORKDIR /home/desktop
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-desktop"]
