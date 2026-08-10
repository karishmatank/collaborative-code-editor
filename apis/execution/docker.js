"use strict";

import Docker from "dockerode";

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
  'typescript': {
    // ts-node uses -e + -i to print a version banner before opening the interactive REPL,
    // mirroring the banners Python and Node show on startup.
    'exec': ['ts-node', '--eval'],
    'repl': ['ts-node', '--transpile-only', '-e', "console.log('TypeScript ' + require('/usr/lib/node_modules/typescript').version)", '-i']
  },
  'sql': {
    'exec': ['psql', '-U', 'student', 'studentdb', '-c'],
    'repl': ['psql', '-U', 'student', 'studentdb']
  }
}

const MAX_RUN_DURATION = 15000; // 15s
const PTY_H = 80;
const PTY_W = 65;

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

export class DockerManager {
  constructor() {
    this.docker = new Docker();
    this.image = 'spot-editor:latest';
  }

  createAndStartContainer() {
    return tryAgain(async () => {
      const container = await this.docker.createContainer({
        Image: this.image,
        Tty: true,
        OpenStdin: true,
        StdinOnce: false
      });
      await container.start();
      return container;
    });
  }

  async killContainer(container) {
    try {
      await container.kill();
    } catch (err) {
      /* It's already dead, which is fine */
    }
    
    // Free up memory
    await container.remove();
  }

  async #startPostgresServer(container) {
    // Create a one-off exec to start the Postgres server
    // Start that exec and wait for it to end before moving on

    const startServerExec = await container.exec({
      Cmd: ['pg_ctlcluster', '18', 'main', 'start'],
      User: 'postgres',
      Tty: false,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
    });
    await startServerExec.start({ Detach: true });

    // Wait until we get the signal that the server is ready
    // Not using setTimeout as we can't await between ticks
    let isReady = false;
    for (let iterNum = 0; iterNum <= 5; iterNum += 1) {
      const readyExec = await container.exec({
        Cmd: ['pg_isready'],
        Tty: false,
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
      });
      const readyStream = await readyExec.start({ Detach: false });
      // Put stream in flowing mode so that it can eventually close
      readyStream.resume();
      // Wait for the stream to end
      await new Promise(resolve => readyStream.on('close', resolve));
      const info = await readyExec.inspect();
      if (info.ExitCode === 0) {
        isReady = true;
        break;
      }
      await delay(200);
    }

    if (!isReady) {
      return false;
    }

    // Run setup SQL
    const runSql = async (sql) => {
      const setupExec = await container.exec({
        Cmd: ['psql', '-U', 'postgres', '-c', sql],
        User: 'postgres',
        Tty: false,
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
      });
      const setupStream = await setupExec.start({ Detach: false });
      setupStream.resume();
      await new Promise(resolve => setupStream.on('close', resolve));
      const setupInfo = await setupExec.inspect();
      return setupInfo.ExitCode;
    }

    const r1 = await runSql('DROP DATABASE IF EXISTS studentdb');
    const r2 = await runSql('DROP USER IF EXISTS student; CREATE USER student;');
    const r3 = await runSql('CREATE DATABASE studentdb OWNER student');

    if ((r1 + r2 + r3) !== 0) {
      return false;
    }

    return true;
  }

  createPtyProcess(container, language, postgresInitialized) {
    return tryAgain(async () => {
      if (language === 'sql' && !postgresInitialized) {
        let readyStatus = await this.#startPostgresServer(container);
        if (!readyStatus) throw new Error('Postgres server startup failed.');
      }

      // Start the PTY process
      const exec = await container.exec({
        Cmd: LANGUAGE_CONFIG[language]['repl'],
        Tty: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Env: ['TERM=xterm-256color', 'TS_NODE_PROJECT=/tsconfig.json']
      });
      const stream = await exec.start({
        hijack: true,
        stdin: true,
        Tty: true
      });
      await exec.resize({ h: PTY_H, w: PTY_W });
      return stream;
    });    
  }

  killPtyProcess(stream) {
    stream.destroy();
  }

  async oneOffExecuteCode(padSession, code) {
    const container = padSession.container;
    const language = padSession.language;

    // Keep track of how stream was ended
    // If true, stream naturally ended after code finished executing
    // If false, stream was destroyed elsewhere
    let ended = false;

    const stream = await tryAgain(async () => {
      const exec = await container.exec({
        Cmd: LANGUAGE_CONFIG[language]['exec'].concat([code]),
        Tty: false,
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Env: ['TERM=xterm-256color', 'TS_NODE_PROJECT=/tsconfig.json']
      });
      return exec.start({
        Detach: false
      });
    });
    
    padSession.runStream = stream;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        padSession.storeAndSendOutput('\r\n\x1b[1;33mExecution timed out!\x1b[0m');
        stream.destroy();
        padSession.runStream = null;
        resolve();
      }, MAX_RUN_DURATION);

      // Docker multiplexed stream (Tty: false) wraps each write in an 8-byte frame header.
      // A single data event may carry multiple frames, so we must parse them all
      // rather than blindly slicing the first 8 bytes (which leaves subsequent
      // frame headers in the output — the size byte can be e.g. \x09 = TAB).
      let buffer = Buffer.alloc(0);

      stream.on('data', (chunk) => {
        // Whatever arrived gets appended to any leftover bytes from the prior event
        buffer = Buffer.concat([buffer, chunk]);

        // Onlly parse if we have at least a full header (8 bytes)
        while (buffer.length >= 8) {
          // Read bytes 4-7 of the header as a big-endian 32-bit integer 
          // to know how large the payload is
          const frameSize = buffer.readUInt32BE(4);

          // We might have an incomplete frame based on what we know of frame size
          // so we have to wait if so
          if (buffer.length < 8 + frameSize) break;

          // Extract the payload bytes for this frame
          const payload = buffer.subarray(8, 8 + frameSize).toString().replace(/\n/g, '\r\n');
          padSession.storeAndSendOutput(payload);

          // Advance past the frame we just processed
          buffer = buffer.subarray(8 + frameSize);
        }
      });

      stream.on('end', () => {
        ended = true;
      });

      stream.on('close', () => {
        // If we have separately closed the stream (i.e. user pressed the "Stop" button)
        if (!ended) {
          padSession.storeAndSendOutput('\r\n\x1b[1;31mCode execution stopped!\x1b[0m');
        }
        clearTimeout(timeout);
        padSession.runStream = null;
        resolve();
      });

      stream.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}