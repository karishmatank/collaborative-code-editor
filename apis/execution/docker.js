"use strict";

import Docker from "dockerode";

const LANGUAGE_CONFIG = {
  'python': {
    'exec': 'python3',
    'repl': ['python3']
  },
  'ruby': {
    // Ruby uses ruby -e to print a banner because plain `irb` shows no banner.
    'exec': 'ruby',
    'repl': ['ruby', '-e', "puts \"Ruby #{RUBY_VERSION}\"; require 'irb'; IRB.start"]
  },
  'javascript': {
    'exec': 'node',
    'repl': ['node']
  },
  'typescript': {
    // ts-node uses -e + -i to print a version banner before opening the interactive REPL,
    // mirroring the banners Python and Node show on startup.
    'exec': 'ts-node',
    'repl': ['ts-node', '--transpile-only', '-e', "console.log('TypeScript ' + require('/usr/lib/node_modules/typescript').version)", '-i']
  },
  'sql': {

  }
}

const LANGUAGE_FLAGS = {
  'python': '-c',
  'ruby': '-e',
  'javascript': '-e',
  'typescript': '--eval'
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

  createPtyProcess(container, language) {
    return tryAgain(async () => {
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
        Cmd: [LANGUAGE_CONFIG[language]['exec'], LANGUAGE_FLAGS[language], code],
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