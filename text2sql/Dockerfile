FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 T2S_DATA_DIR=/data
WORKDIR /srv
RUN apt-get update && apt-get install -y --no-install-recommends freetds-dev gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY requirements.txt requirements-drivers.txt ./
RUN pip install -r requirements.txt -r requirements-drivers.txt
COPY app ./app
COPY static ./static
COPY sample_data ./sample_data
RUN useradd -r -u 10001 t2s && mkdir /data && chown t2s /data
USER t2s
VOLUME /data
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
