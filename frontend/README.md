# React + Tailwind frontend

This is a standalone React + Tailwind frontend. It does not replace or modify the
existing Python-served interface in `src/printermonitor/static`.

```bash
# Terminal 1: start the existing Python API
python run.py

# Terminal 2: start the new frontend
cd frontend
npm install
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`). During development, Vite proxies
`/api` (including the authenticated printer WebSocket) and `/static` to
`http://127.0.0.1:8000`. Set `PM_API_TARGET` if the Python service listens elsewhere,
for example `PM_API_TARGET=http://192.168.1.20:8000 npm run dev`.

The dashboard uses the Python service's login/setup, printer, history, and stats APIs.
Printer updates are streamed over `/api/ws`; adding printers, pause/resume, and G-code
upload use the existing API. Production assets can be built with `npm run build`;
the current Python root route continues to serve the original interface.
