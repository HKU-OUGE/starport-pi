FROM docker.io/library/python:3.12-slim-bookworm
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update -o APT::Update::Error-Mode=any -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends \
    bash git locales tzdata fontconfig fonts-noto-cjk ca-certificates \
    && printf 'zh_TW.UTF-8 UTF-8\nen_US.UTF-8 UTF-8\n' > /etc/locale.gen \
    && locale-gen \
    && ln -snf /usr/share/zoneinfo/Asia/Taipei /etc/localtime \
    && printf 'Asia/Taipei\n' > /etc/timezone \
    && printf 'workspace\n' > /etc/hostname \
    && printf '127.0.0.1 localhost workspace\n' > /etc/hosts \
    && printf '' > /etc/machine-id \
    && printf '' > /etc/resolv.conf \
    && printf 'root:x:0:0:root:/tmp:/bin/bash\nworker:x:1000:1000:worker:/workspace:/bin/bash\n' > /etc/passwd \
    && printf 'root:x:0:\nworker:x:1000:\n' > /etc/group \
    && mkdir -p /workspace /output /data/shared /run/starport /opt/starport \
    && rm -rf /var/lib/apt/lists/* /root/.cache /root/.bash_history
COPY profiles/fonts.conf /etc/fonts/starport.conf
COPY profiles/taiwan.json /opt/starport/region.json
COPY server/guest_entry.py /opt/starport/guest_entry.py
COPY server/probe.py /opt/starport/probe.py
COPY server/gpu_probe.py /opt/starport/gpu_probe.py
ENV TZ=Asia/Taipei LANG=zh_TW.UTF-8 LC_ALL=zh_TW.UTF-8 LANGUAGE=zh_TW:zh:en \
    PYTHONUTF8=1 PYTHONIOENCODING=utf-8 FONTCONFIG_FILE=/etc/fonts/starport.conf
WORKDIR /workspace
CMD ["/bin/bash"]
