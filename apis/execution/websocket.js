"use strict";

import WebSocket, { WebSocketServer } from "ws";
import { DockerManager } from "./docker.js";

class PadSession {
  static VALID_LANGUAGES = ['python', 'javascript', 'typescript', 'html', 'sql'];

  constructor(language, container, stream) {
    this.language = language;
    this.output = '';
    this.container = container;
    this.stream = null;
    this.runStream = null;
    this.users = new Set();
    this.suppressReplOutput = false;

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
  }

  clearBuffer() {
    // Clear anything in the buffer
    this.stream.write('\x15');
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

        const padSession = new PadSession(language, container, stream);
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
          await this.handleLanguageChange(data['language'], padSession);
        } catch (err) {
          padSession.sendError('Language change failed, please try again');
        }
      } else if (type === 'input') {
        padSession.handleInput(data['data']);
      } else if (type === 'run') {
        // We are not using await because we don't want to block for the entire run duration
        this.handleRunEditorCode(data['code'], data['preMessage'], padSession);
      } else if (type === 'reset') {
        try {
          await this.handleReset(padSession);
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
      if (padSession.stream) {
        this.dockerManager.killPtyProcess(padSession.stream);
      }
      this.sessions.delete(padId);
      await this.dockerManager.killContainer(padSession.container);
    }
  }

  async handleLanguageChange(language, padSession) {
    if (language === 'html') {
      return
    }

    // Update the language state
    padSession.changeLanguage(language);

    // Update output state
    padSession.resetOutput();

    // Kill the current pty process and start a new pty with the new language
    // There may not be a current pty process if the original language was html
    if (padSession.stream) {
      this.dockerManager.killPtyProcess(padSession.stream);
    }
    const stream = await this.dockerManager.createPtyProcess(padSession.container, language);
    padSession.switchStream(stream);
  }

  async handleReset(padSession) {
    // Update output state
    padSession.resetOutput();

    // Kill the current pty process and start a new pty with the same language
    if (padSession.language !== 'html') {
      if (padSession.stream) {
        this.dockerManager.killPtyProcess(padSession.stream);
      }
      const stream = await this.dockerManager.createPtyProcess(padSession.container, padSession.language);
      padSession.switchStream(stream);
    }
  }

  async handleRunEditorCode(code, preMessage, padSession) {
    if (padSession.stream === null) {
      return
    }

    // Suppress REPL PTY output so the REPL's async response to clearBuffer
    // doesn't appear between the preMessage and the code output
    padSession.suppressReplOutput = true;

    // Clear anything in the buffer
    padSession.clearBuffer();

    // Broadcast message to rest of group to reflect run status in the UI
    padSession.sendRunStopTriggered('run');

    // Show the pre message immediately, before any code output arrives
    padSession.storeAndSendOutput(preMessage);

    // Execute the one-off code
    try {
      await this.dockerManager.oneOffExecuteCode(padSession, code);
      padSession.storeAndSendOutput('\n');
    } catch (error) {
      padSession.sendError('Code execution failed. Please refresh and try again.');
    } finally {
      padSession.sendRunFinished();
      // Re-enable REPL output before writing \r so the returning carrot is visible
      padSession.suppressReplOutput = false;
      // Newline in REPL to bring back carrot
      if (padSession.stream) {
        padSession.stream.write('\r');
      }
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