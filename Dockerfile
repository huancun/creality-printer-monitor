# Build the React frontend first; the Python image only ships the dist output.
FROM node:22-slim AS frontend
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY run.py ./
COPY src ./src
COPY --from=frontend /web/dist ./frontend/dist

ENV PM_DATA_DIR=/data \
    PM_HOST=0.0.0.0 \
    PM_PORT=8000
ENV PYTHONPATH=/app/src
VOLUME /data
EXPOSE 8000

CMD ["python", "run.py"]
