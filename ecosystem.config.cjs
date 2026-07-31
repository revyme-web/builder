module.exports = {
  apps: [
    {
      name: 'canvas-poc',
      cwd: '/Projects/canvas-poc',
      script: 'node_modules/vite/bin/vite.js',
      args: 'preview --port 3333 --host',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'canvas-sandbox',
      cwd: '/Projects/canvas-poc',
      script: 'node_modules/vite/bin/vite.js',
      // Internal only — nginx terminates TLS on the PUBLIC :5174 and proxies
      // here, so the editor's `https://<host>:5174` iframe works under HTTPS.
      args: 'preview --config vite.sandbox.config.ts --port 15174 --host 127.0.0.1',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'canvas-preview',
      cwd: '/Projects/canvas-poc',
      script: 'node_modules/vite/bin/vite.js',
      // Internal only — nginx terminates TLS on the PUBLIC :5175 and proxies here.
      args: 'preview --config vite.preview.config.ts --port 15175 --host 127.0.0.1',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
