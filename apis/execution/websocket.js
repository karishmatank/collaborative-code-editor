"use strict";

import WebSocket, { WebSocketServer } from "ws";
import { DockerManager } from "./docker.js";

class PadSession {
  static VALID_LANGUAGES = ['python', 'ruby', 'javascript', 'typescript', 'html', 'sql'];
  static MAX_RUN_DURATION = 15000; // 15s

  constructor(language, container, stream, dockerManager) {
    this.language = language;
    this.output = '';
    this.container = container;
    this.stream = null;
    this.dockerManager = dockerManager;
    this.runStream = null;
    this.users = new Set();
    this.suppressReplOutput = false;
    this.postgresInitialized = null;
    this.onStreamCloseHandler = null;
    this.isShuttingDown = false;

    this.switchStream(stream);
  }

  #broadcast(type, message, excludeUser) {
    let userList = Array.from(this.users);
    if (excludeUser) {
      userList = userList.filter(user => user !== excludeUser);
    }
    userList.forEach(user => {
      let msg = { type: type };
      if (message) {
        msg['data'] = message;
      }

      // Don't send to a client in the process of disconnecting
      if (user.readyState === WebSocket.OPEN) {
        user.send(JSON.stringify(msg));
      }
    });
  }

  handleInput(data) {
    if (!this.stream) return;
    // No need to broadcast change to others users as it echos (is caught by handleOutput)

    // If REPL input has a newline, then it will automatically trigger code run
    // Too complex to set timeout here since it gets cleared prematurely in handleOutput
    // Otherwise, REPL will just accummulate input
    this.stream.write(data);
  }

  handleOutput() {
    // Broadcast output from stream to all users
    this.stream.on('data', (chunk) => {
      if (!this.suppressReplOutput) {
        this.storeAndSendOutput(chunk.toString());
      }
    });
  }

  storeAndSendOutput(output) {
    // Store output in session state
    this.output += output;

    // Broadcast incremental output to users
    this.#broadcast('output', output);
  }

  sendError(error) {
    this.#broadcast('error', `\x1b[101m\x1b[97m ${error} \x1b[0m`);
  }

  sendRunStopTriggered(status) {
    // Send a status to the rest of the group that a run or stop has been triggered
    // status will be either 'run' or 'stop'
    this.#broadcast(status + 'Triggered');
  }

  sendRunFinished() {
    // Send a status to the rest of the group that a run finished
    this.#broadcast('runFinished');
  }

  sendReset() {
    this.#broadcast('reset');
  }

  handleStopCode() {
    if (this.runStream) {
      // Destroy the run stream
      this.runStream.destroy();
      this.runStream = null;

      // Broadcast message to rest of group to reflect stop status in the UI
      this.sendRunStopTriggered('stop');
    } 
  }

  resetOutput() {
    this.output = '';

    // Broadcast to the group to reflect in the UI
    this.sendReset();
  }

  addUser(ws) {
    // Add user to our users set
    this.users.add(ws);

    // If output is non-empty, send the output back
    if (this.output) {
      ws.send(JSON.stringify({ 'type': 'output', 'data': this.output }));
    }
  }

  removeUser(ws) {
    // Remove user from the set of users
    this.users.delete(ws);
  }

  get userCount() {
    // Return the user count
    return this.users.size;
  }

  changeLanguage(language) {
    this.language = language;
  }

  switchStream(newStream) {
    if (!newStream) {
      return
    }

    this.stream = newStream;

    // Re-register event listener on new stream
    this.handleOutput();

    // Add in an error listener
    this.stream.on('error', (err) => {
      console.error('PTY stream error: ', err);
      this.sendError('\x1b[101m\x1b[97m Terminal stream failed, please refresh! \x1b[0m');
    });

    // Reset the pseudoterminal if a user manually exists (Ctrl+C, \q in SQL, etc)
    this.onStreamCloseHandler = async () => {
      try {
        await this.resetPtyProcesses();
      } catch (err) {
        if (!this.isShuttingDown) {
          console.error('Auto-restart after REPL exit failed:', err);
          this.sendError('REPL failed to restart. Please refresh.');
        }
      }
    };;
    this.stream.on('close', this.onStreamCloseHandler);
  }

  clearBuffer() {
    // Clear anything in the buffer
    this.stream.write('\x15');
  }

  async resetPtyProcesses(newLanguage) {
    let language;
    if (newLanguage) {
      language = newLanguage;
    } else {
      language = this.language;
    }

    if (this.stream) {
      this.stream.off('close', this.onStreamCloseHandler);
      this.dockerManager.killPtyProcess(this.stream);
    }
    const stream = await this.dockerManager.createPtyProcess(this.container, language, this.postgresInitialized);
    if (language === 'sql') {
      this.postgresInitialized = true;
    }
    this.switchStream(stream);
  }

  async handleLanguageChange(language) {
    if (language === 'html') {
      return
    }

    // Update the language state
    this.changeLanguage(language);

    // Update output state
    this.resetOutput();

    // Kill the current pty process and start a new pty with the new language
    // There may not be a current pty process if the original language was html
    await this.resetPtyProcesses(language);
  }

  async handleReset() {
    // Update output state
    this.resetOutput();

    // Kill the current pty process and start a new pty with the same language
    if (this.language !== 'html') {
      await this.resetPtyProcesses();
    }
  }

  async #processRunEditorCodeResults() {
    // Keep track of how stream was ended
    // If true, stream naturally ended after code finished executing
    // If false, stream was destroyed elsewhere
    let ended = false;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.storeAndSendOutput('\r\n\x1b[1;33mExecution timed out!\x1b[0m');
        this.runStream.destroy();
        this.runStream = null;
        resolve();
      }, PadSession.MAX_RUN_DURATION);

      // Docker multiplexed stream (Tty: false) wraps each write in an 8-byte frame header.
      // A single data event may carry multiple frames, so we must parse them all
      // rather than blindly slicing the first 8 bytes (which leaves subsequent
      // frame headers in the output — the size byte can be e.g. \x09 = TAB).
      let buffer = Buffer.alloc(0);

      this.runStream.on('data', (chunk) => {
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
          this.storeAndSendOutput(payload);

          // Advance past the frame we just processed
          buffer = buffer.subarray(8 + frameSize);
        }
      });

      this.runStream.on('end', () => {
        ended = true;
      });

      this.runStream.on('close', () => {
        // If we have separately closed the stream (i.e. user pressed the "Stop" button)
        if (!ended) {
          this.storeAndSendOutput('\r\n\x1b[1;31mCode execution stopped!\x1b[0m');
        }
        clearTimeout(timeout);
        this.runStream = null;
        resolve();
      });

      this.runStream.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async handleRunEditorCode(code, preMessage) {
    if (this.stream === null) {
      return
    }

    // Suppress REPL PTY output so the REPL's async response to clearBuffer
    // doesn't appear between the preMessage and the code output
    this.suppressReplOutput = true;

    // Clear anything in the buffer
    this.clearBuffer();

    // Broadcast message to rest of group to reflect run status in the UI
    this.sendRunStopTriggered('run');

    // Show the pre message immediately, before any code output arrives
    this.storeAndSendOutput(preMessage);

    // Execute the one-off code
    try {
      this.runStream = await this.dockerManager.oneOffExecuteCode(this.container, this.language, code);
      await this.#processRunEditorCodeResults();
      this.storeAndSendOutput('\n');
    } catch (error) {
      this.sendError('Code execution failed. Please refresh and try again.');
    } finally {
      this.sendRunFinished();
      // Re-enable REPL output before writing \r so the returning carrot is visible
      this.suppressReplOutput = false;
      // Newline in REPL to bring back carrot
      if (this.stream) {
        this.stream.write('\r');
      }
    }
  }
}

export class ReplServer {
  constructor() {
    this.wss = new WebSocketServer({ port: parseInt(process.env.WS_PORT, 10)});
    this.dockerManager = new DockerManager();
    this.sessions = new Map();
    this.wss.on('connection', this.handleConnection.bind(this));
  }

  async #setUpSession(ws, padId, language) {
    if (!this.sessions.has(padId)) {
      // Set a pending Promise to the map to block any concurrently joining users from doing a duplicate setup
      const sessionPromise = (async () => {
        // Start a new container
        const container = await this.dockerManager.createAndStartContainer();

        // Start a new pseudoterminal process
        let stream;
        if (language !== 'html') {
          stream = await this.dockerManager.createPtyProcess(container, language);
        } else {
          stream = null;
        }

        const padSession = new PadSession(language, container, stream, this.dockerManager);

        if (language === 'sql') {
          padSession.postgresInitialized = true;
        }

        return padSession;
      })();
      
      // Stored synchronously
      this.sessions.set(padId, sessionPromise);
    }

    // Any concurrent users will then await the same promise
    const padSession = await this.sessions.get(padId);

     // Replace the Promise in the map with the actual PadSession object
    this.sessions.set(padId, padSession);

    padSession.addUser(ws);
    ws.send(JSON.stringify({ type: 'ready' }));
    return padSession;
  }

  async handleConnection(ws, req) {
    // Parse URL for pad ID and language. Random base is fine, so I use localhost
    const url = new URL(req.url, 'http://localhost');
    const padId = url.searchParams.get('padId');
    const language = url.searchParams.get('language');

    if (!PadSession.VALID_LANGUAGES.includes(language)) {
      return;
    }

    // Set up the session data
    let padSession;
    try {
      padSession = await this.#setUpSession(ws, padId, language);
    } catch (err) {
      this.sessions.delete(padId);
      console.error('Session setup failed: ', err);
      ws.send(JSON.stringify({ type: 'error', data: '\x1b[101m\x1b[97m Failed to start session, please refresh! \x1b[0m' }));
      ws.close();
      return;
    }

    // Register other event listeners
    ws.on('error', console.error);
    ws.on('close', async () => {
      try {
        await this.handleDisconnection(ws, padId);
      } catch (err) {
        console.error('Disconnection cleanup error: ', err);
      }
    });
    ws.on('message', async (data) => {
      try {
        data = JSON.parse(data);
      } catch (err) {
        console.error('Invalid message: ', err);
        return;
      }
      
      let type = data.type;
      if (type === 'languageChange') {
        try {
          await padSession.handleLanguageChange(data['language']);
        } catch (err) {
          padSession.sendError('Language change failed, please try again');
        }
      } else if (type === 'input') {
        padSession.handleInput(data['data']);
      } else if (type === 'run') {
        // We are not using await because we don't want to block for the entire run duration
        padSession.handleRunEditorCode(data['code'], data['preMessage']);
      } else if (type === 'reset') {
        try {
          await padSession.handleReset();
        } catch (err) {
          padSession.sendError('Reset failed, please try again');
        }
      } else if (type === 'stop') {
        padSession.handleStopCode();
      }
    });
  }

  async handleDisconnection(ws, padId) {
    const padSession = this.sessions.get(padId);

    // If there is no padSession or if padSession is a Promise ("thenable" check)
    // return early
    if (!padSession || typeof padSession.then === 'function') return;

    // Remove user from the set of users
    padSession.removeUser(ws);

    // If last user, destroy pty + container + delete session data
    if (padSession.userCount === 0) {
      padSession.isShuttingDown = true;
      if (padSession.stream) {
        this.dockerManager.killPtyProcess(padSession.stream);
      }
      this.sessions.delete(padId);
      await this.dockerManager.killContainer(padSession.container);
    }
  }
}

const server = new ReplServer();

// Catch Promise rejections that are never caught
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection: ', reason);
});

// Catch synchronous throws that are never caught
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception: ', err);
});

// In case the server goes down, clean up all terminals
async function cleanupAllSessions() {
  for (const session of server.sessions.values()) {
    // If the session is real and not a Promise
    if (session && typeof session.then !== 'function') {
      if (session.stream) {
        server.dockerManager.killPtyProcess(session.stream);
      }
      await server.dockerManager.killContainer(session.container)
        .catch(() => {});
    }
  }
}

// SIGTERM = What process managers like Docker send to gracefully stop the server
process.on('SIGTERM', async () => {
  await cleanupAllSessions();
  process.exit(0);
});

// SIGINT = Ctrl+C in the terminal
process.on('SIGINT', async () => {
  await cleanupAllSessions();
  process.exit(0);
});