"use strict";

import pty from 'node-pty';
import { spawn, exec, execSync } from 'child_process';

const LANGUAGE_CONFIG = {
  'python': {
    'exec': ['python3', '-c'],
    'repl': ['python3']
  },
  'ruby': {
    // Ruby uses ruby -e to print a banner because plain `irb` shows no banner.
    'exec': ['ruby', '-e'],
    'repl': ['ruby', '-e', "puts \"Ruby #{RUBY_VERSION}\"; require 'irb'; IRB.start"]
  },
  'javascript': {
    'exec': ['node', '-e'],
    'repl': ['node']
  },
  'sql': {
    'exec': ['psql', '-U', 'student', 'studentdb', '-c'],
    'repl': ['psql', '-U', 'student', 'studentdb']
  }
}

const PTY_H = 40;
const PTY_W = 80;

// Caps total concurrent processes owned by the `sandbox` user (REPL + any
// one-off run share this budget) so a fork bomb stalls out instead of
// taking down the container. Cloudflare Containers has no HostConfig-style
// PidsLimit equivalent, so this is enforced via `prlimit` (RLIMIT_NPROC)
// right before exec'ing the user-facing command.
const MAX_SANDBOX_PROCESSES = 50;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const tryAgain = async (fn, maxRetries = 3, delayMs = 500) => {
  let numRetries = 0;

  async function attempt() {
    try {
      let result = await fn();
      return result;
    } catch (err) {
      if (numRetries >= maxRetries) {
        throw err;
      }
      numRetries += 1;
      await delay(delayMs * numRetries);
      return attempt();
    }
  }

  return attempt();
}

export class PtyManager {
  constructor() {
    this.sandboxUid = this.#getUid('sandbox');
    this.postgresUid = this.#getUid('postgres');
  }

  #getUid(user) {
    return parseInt(execSync(`id -u ${user}`).toString().trim());
  }

  // Prepend a `prlimit` wrapper so the eventual exec'd command inherits an
  // RLIMIT_NPROC cap. node-pty applies `uid` before exec'ing the first
  // argument (prlimit here), so prlimit itself also runs as `sandbox` -
  // lowering your own rlimit never requires elevated privileges.
  #withProcessLimit(file, args) {
    return ['prlimit', [`--nproc=${MAX_SANDBOX_PROCESSES}`, '--', file, ...args]];
  }

  async #startPostgresServer() {
    // Run as root so pg_ctlcluster can switch to the postgres user with the
    // correct supplementary groups
    await new Promise((resolve, reject) => {
      exec('pg_ctlcluster 18 main start', (error, stdout, stderr) => {
        if (error) {
          console.error('pg_ctlcluster failed:', stderr || error.message);
          reject(error);
        } else {
          resolve();
        }
      });
    });

    // Wait until we get the signal that the server is ready.
    // Must use the Unix socket: listen_addresses is empty so TCP localhost is down.
    // Run as the postgres OS user so the leftover `local all postgres peer` pg_hba
    // rule still matches.
    let isReady = false;
    for (let iterNum = 0; iterNum <= 5; iterNum += 1) {
      isReady = await new Promise((resolve) => {
        const options = { uid: this.postgresUid };
        exec('pg_isready -h /var/run/postgresql -U postgres', options, (error) => {
          resolve(!error);
        });
      });
      if (isReady) {
        break;
      }
      await delay(200);
    }

    if (!isReady) {
      console.error('Postgres did not become ready (pg_isready timed out).');
      return false;
    }

    // Run setup SQL
    const runSql = (sql) => {
      return new Promise((resolve) => {
        const options = { uid: this.postgresUid };
        const psql = spawn('psql', ['-U', 'postgres', '-c', sql], options);
        psql.on('close', (code) => resolve(code === 0));
      });
    };

    const r1 = await runSql('DROP DATABASE IF EXISTS studentdb;');
    const r2 = await runSql('DROP USER IF EXISTS student; CREATE USER student;');
    const r3 = await runSql('CREATE DATABASE studentdb OWNER student;');

    if (!(r1 && r2 && r3)) {
      console.error('Postgres setup SQL failed:', { r1, r2, r3 });
      return false;
    }

    return true;
  }

  createPtyProcess(language, postgresInitialized) {
    return tryAgain(async () => {
      if (language === 'sql' && !postgresInitialized) {
        let readyStatus = await this.#startPostgresServer();
        if (!readyStatus) throw new Error('Postgres server startup failed.');
      }

      // Start the PTY process
      const [ file, ...args ] = LANGUAGE_CONFIG[language]['repl'];
      const [ limitedFile, limitedArgs ] = this.#withProcessLimit(file, args);
      return pty.spawn(limitedFile, limitedArgs, this.#defaultPtyOptions());
    });
  }

  #defaultPtyOptions() {
    return {
      cols: PTY_W,
      rows: PTY_H,
      uid: this.sandboxUid,
      name: 'xterm-256color',
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      },
      cwd: '/home/sandbox'
    };
  }

  // Kill the process and its process group (any children it spawned)
  // Negative PID = "this process group"
  // ESRCH means the group is already gone
  #killProcessAndGroup(proc) {
    const pid = proc.pid;
    proc.kill();
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }

  killPtyProcess(ptyProcess) {
    this.#killProcessAndGroup(ptyProcess);
  }

  killOneOffProcess(childProcess) {
    this.#killProcessAndGroup(childProcess);
  }

  oneOffExecuteCode(language, code) {
    return tryAgain(async () => {
      const [ file, ...args ] = [...LANGUAGE_CONFIG[language]['exec'], code];
      const [ limitedFile, limitedArgs ] = this.#withProcessLimit(file, args);
      return pty.spawn(limitedFile, limitedArgs, this.#defaultPtyOptions());
    });
  }
}