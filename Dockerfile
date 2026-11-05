FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY run.py ./
COPY src ./src

ENV PM_DATA_DIR=/data \
    PM_HOST=0.0.0.0 \
    PM_PORT=8000
ENV PYTHONPATH=/app/src
VOLUME /data
EXPOSE 8000

CMD ["python", "run.py"]
