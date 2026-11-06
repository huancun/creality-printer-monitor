# React + Tailwind frontend

This is the only web UI. It replaced the old Python-served pages; static assets
(the 3D viewer, printer model images and vendored three.js) live in `public/`
and are served by Vite in development and copied into `dist/` by the build.

```bash
# Terminal 1: start the Python API
python run.py

# Terminal 2: start the frontend
cd frontend
npm install
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`). During development, Vite proxies
`/api` (including the authenticated printer WebSocket) to
`http://127.0.0.1:8000`. Set `PM_API_TARGET` if the Python service listens elsewhere,
for example `PM_API_TARGET=http://192.168.1.20:8000 npm run dev`.

The dashboard uses the Python service's login/setup, printer, history, and stats APIs.
Printer updates are streamed over `/api/ws`; adding printers, pause/resume, and G-code
upload use the existing API. Run `npm run build` to produce `dist/`; the Python
service serves it from the root route (set `PM_FRONTEND_DIST` if it lives elsewhere),
falling back to `<repo>/frontend/dist`.
