/**
 * pm2 configuration.
 *
 * One process. The server is not clustered on purpose: it holds sessions in
 * memory and runs a backup timer, and a second copy would give half the staff
 * phantom logouts and take two backups at once. A hospital OPD is a few dozen
 * users, which one Node process handles without noticing.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup          # prints a command to run with sudo
 */
module.exports = {
  apps: [{
    name: 'hms',
    script: 'dist/server/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',

    // The .env in this folder is read by the server itself, so nothing
    // sensitive needs to live in here.
    env: { NODE_ENV: 'production' },

    // Restart on crash, but give up if it is crash-looping. Without this a
    // bad DATABASE_URL produces thousands of restarts and a log file that
    // fills the disk overnight.
    autorestart: true,
    max_restarts: 10,
    min_uptime: '30s',
    restart_delay: 4000,

    // Power cuts and load shedding are the normal case here, not the
    // exception: come back up on boot without anyone logging in.
    watch: false,
    max_memory_restart: '500M',

    error_file: 'logs/hms-error.log',
    out_file: 'logs/hms-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
}
