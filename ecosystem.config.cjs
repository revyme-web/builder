// pm2 process definitions for the deployed builder.
//
// `cwd: __dirname` — NOT a hardcoded path. pm2 resolves it to wherever this
// file actually lives, so the processes always run from the directory the
// deploy just wrote to. A literal path here silently rots the moment
// DEPLOY_PATH changes: the rsync lands in the new directory, pm2 keeps
// serving the old one, and every deploy reports success while shipping
// nothing. That exact drift (canvas-poc -> builder) served a stale bundle
// for hours. Keep this relative.

module.exports = {
  apps: [
    {
      name: 'canvas-poc',
      cwd: __dirname,
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
      cwd: __dirname,
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
      cwd: __dirname,
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
