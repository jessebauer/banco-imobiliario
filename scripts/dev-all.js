'use strict';

const { spawn } = require('child_process');

// Run both client and server dev scripts in parallel for environments without modern helpers.
const commands = [
  { label: 'client', command: 'npm --workspace client run dev' },
  { label: 'server', command: 'npm --workspace server run dev' }
];

let live = commands.length;
let failure = false;
const children = [];

function killOthers(except) {
  children.forEach(function (child) {
    if (child !== except && child.pid) {
      child.kill('SIGTERM');
    }
  });
}

commands.forEach(function (task) {
  const child = spawn(task.command, { shell: true, stdio: 'inherit' });
  children.push(child);

  child.on('exit', function (code) {
    live -= 1;

    if (failure) {
      if (live === 0) {
        process.exit(process.exitCode || 1);
      }
      return;
    }

    if (code !== 0) {
      failure = true;
      console.error('[' + task.label + '] exited with code ' + (code || 1));
      process.exitCode = code || 1;
      killOthers(child);
      if (live === 0) {
        process.exit(process.exitCode);
      }
      return;
    }

    if (live === 0) {
      process.exit(0);
    }
  });
});

['SIGINT', 'SIGTERM'].forEach(function (signal) {
  process.on(signal, function () {
    children.forEach(function (child) {
      if (child.pid) {
        child.kill(signal);
      }
    });
    process.exit();
  });
});
