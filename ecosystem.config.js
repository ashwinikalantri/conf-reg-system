// PM2 process definition. Watch is restricted to actual source files --
// without an ignore list, PM2 was watching the whole project directory,
// including conference.db (rewritten by SQLite on nearly every request) and
// uploads/ and bank-statements/ (written on every upload). Every one of
// those writes was triggering a full app restart, killing in-flight
// requests -- the root cause of SMS OTPs silently never sending and logins
// that submitted correctly but never navigated past the OTP screen.
module.exports = {
  apps: [
    {
      name: 'nqocn',
      script: 'server.js',
      cwd: __dirname,
      watch: ['server.js', 'public', 'views', 'package.json'],
      ignore_watch: [
        'node_modules',
        'conference.db*',
        'uploads',
        'bank-statements',
        'docs',
        '.git',
        '*.log',
      ],
      watch_options: {
        followSymlinks: false,
      },
    },
  ],
};
