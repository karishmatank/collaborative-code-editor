"use strict";

import WebSocket, { WebSocketServer } from "ws";
import http from 'http';
import { PtyManager } from "./pty.js";

const VALID_LANGUAGES = ['python', 'ruby', 'javascript', 'typescript', 'html', 'sql'];
const MAX_RUN_DURATION = 15000; // 15s
const MAX_RUN_OUTPUT_LENGTH = 512 * 1024; // 512 KB in characters
const WS_ACTIVITY_TIMEOUT = 20 * 60 * 1000; // 20 min
const IDLE_CLOSE_CODE = 4000;

export let wss;

class PadSession {
  constructor(language, stream, ptyManager) {
    this.language = language;
    this.output = '';
    this.stream = null;
    this.ptyManager = ptyManager;
    this.runStream = null;
    this.suppressReplOutput = false;
    this.postgresInitialized = null;
    this.isShuttingDown = false;
    this.dataListener = null;
    this.exitListener = null;

    this.switchStream(stream);
  }

  #broadcast(type, message, excludeUser) {
    let userList = Array.from(wss.clients);
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
    this.dataListener = this.stream.onData((chunk) => {
      if (!this.suppressReplOutput) {
        this.storeAndSendOutput(chunk.toString());
      }
    });
  }

  handleExit() {
    // Reset the pseudoterminal if a user manually exists (Ctrl+C, \q in SQL, etc)
    this.exitListener = this.stream.onExit(async () => {
      try {
        await this.resetPtyProcesses();
      } catch (err) {
        if (!this.isShuttingDown) {
          console.error('Auto-restart after REPL exit failed:', err);
          this.sendError('REPL failed to restart. Please refresh.');
        }
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
      this.ptyManager.killOneOffProcess(this.runStream);
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

  sendOutputOnConnection(ws) {
    // If output is non-empty, send the output back
    if (this.output) {
      ws.send(JSON.stringify({ 'type': 'output', 'data': this.output }));
    }
  }

  changeLanguage(language) {
    this.language = language;
  }

  switchStream(newStream) {
    if (!newStream) {
      return
    }

    this.stream = newStream;

    // Re-register event listeners on new stream
    this.handleOutput();
    this.handleExit();
  }

  clearBuffer() {
    // Clear anything in the buffer
    this.stream.write('\x15');
  }

  cleanUpPtyProcesses() {
    if (this.stream) {
      // Dispose of any event handlers on the stream itself
      this.dataListener?.dispose();
      this.exitListener?.dispose();

      // Kill the PTY process
      this.ptyManager.killPtyProcess(this.stream);
    }
  }

  async resetPtyProcesses(newLanguage) {
    let language;
    if (newLanguage) {
      language = newLanguage;
    } else {
      language = this.language;
    }

    this.cleanUpPtyProcesses();

    const stream = await this.ptyManager.createPtyProcess(language, this.postgresInitialized);
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
    let explained = false;

    // Record current padSession output length, as we will later stop execution
    // based on too much *incremental* output
    let currentOutputLen = this.output.length;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.storeAndSendOutput('\r\n\x1b[1;33mExecution timed out!\x1b[0m');
        explained = true;
        if (this.runStream) {
          this.ptyManager.killOneOffProcess(this.runStream);
        }
      }, MAX_RUN_DURATION);

      const onLongOutput = () => {
        clearTimeout(timeout);
        this.storeAndSendOutput('\r\n\x1b[1;33mExecution halted - output too long!\x1b[0m');
        explained = true;
        if (this.runStream) {
          this.ptyManager.killOneOffProcess(this.runStream);
        }
      }

      const onData = (chunk) => {
        this.storeAndSendOutput(chunk.toString());
        // Check incremental output size to see if it breaches our limit
        if ((this.output.length - currentOutputLen) >= MAX_RUN_OUTPUT_LENGTH && !explained) {
          onLongOutput();
        }
      }

      const dataListener = this.runStream.onData(onData);
      const exitListener = this.runStream.onExit(({ signal }) => {
        dataListener.dispose();
        exitListener.dispose();
        // Signal present means a signal was sent from elsewhere to close the stream
        // Code present (no signal) means the code finished evaluating, whether successfully or not
        // Explained being false means we haven't already explained the stop reason elsewhere
        if (!explained && signal) {
          this.storeAndSendOutput('\r\n\x1b[1;31mCode execution stopped!\x1b[0m');
        }
        clearTimeout(timeout);
        resolve();
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
      this.runStream = await this.ptyManager.oneOffExecuteCode(this.language, code);
      await this.#processRunEditorCodeResults();
      this.runStream = null;
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
    const port = parseInt(process.env.WS_PORT, 10) || 8080;

    this.server = http.createServer((req, res) => {
      // Cloudflare ping request handling
      if (req.url === '/ping') {
        res.writeHead(200).end('ok');
      } else {
        res.writeHead(404).end();
      }
    });

    wss = new WebSocketServer({ server: this.server });
    this.session = null;
    this.ptyManager = new PtyManager();
    this.activityTimeout = null;
    wss.on('connection',  this.handleConnection.bind(this));
    this.server.listen(port);

    process.on('SIGTERM', () => this.#onProcessStop());
    process.on('SIGINT', () => this.#onProcessStop());
  }

  #resetActivityTimeout() {
    // Set a timeout to track WebSocket activity
    // If no activity within that period, close all WS connections that are still connected
    // So that the container can destroy itself
    // Otherwise, users who keep a tab open and don't do anything, but are still connected
    // will keep the container alive, which means we are billed for it
    // Container sleepAfter only starts after everyone has disconnected
    // so it doesn't save us from people forgetting to X out of the pad tab
    clearTimeout(this.activityTimeout);
    this.activityTimeout = setTimeout(() => {
      wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(IDLE_CLOSE_CODE, 'idle');
        }
      });
    }, WS_ACTIVITY_TIMEOUT);
  }

  async #setUpSession(ws, language) {
    if (!this.session) {
      // Set a pending Promise to block any concurrently joining users from doing a duplicate setup
      const sessionPromise = (async () => {
        // Start a new pseudoterminal process
        let stream;
        if (language !== 'html') {
          stream = await this.ptyManager.createPtyProcess(language);
        } else {
          stream = null;
        }

        const padSession = new PadSession(language, stream, this.ptyManager);

        if (language === 'sql') {
          padSession.postgresInitialized = true;
        }

        return padSession;
      })();

      this.session = sessionPromise;
    }

    // Any concurrent users will then await the same promise
    const padSession = await this.session;

    // Replace the Promise in the map with the actual PadSession object
    this.session = padSession;

    this.session.sendOutputOnConnection(ws);
    ws.send(JSON.stringify({ type: 'ready' }));
  }

  async handleConnection(ws, req) {
    // Parse URL for pad ID and language. Random base is fine, so I use localhost
    const url = new URL(req.url, 'http://localhost');
    const language = url.searchParams.get('language');

    if (!VALID_LANGUAGES.includes(language)) {
      return;
    }

     // Set up the session data
    try {
      await this.#setUpSession(ws, language);
      this.#resetActivityTimeout();
    } catch (err) {
      this.session = null;
      console.error('Session setup failed: ', err);
      ws.send(JSON.stringify({ type: 'error', data: '\x1b[101m\x1b[97m Failed to start session, please refresh! \x1b[0m' }));
      ws.close();
      return;
    }

    // Register other event listeners
    ws.on('error', console.error);
    ws.on('close', async () => {
      try {
        await this.handleDisconnection();
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
      if (type === 'ping') {
        // For now, I won't do anything, client sending to keep the connection alive
        return;
      }

      this.#resetActivityTimeout();
      
      if (type === 'languageChange') {
        try {
          await this.session.handleLanguageChange(data['language']);
        } catch (err) {
          console.error('Language change failed:', err);
          this.session.sendError('Language change failed, please try again');
        }
      } else if (type === 'input') {
        this.session.handleInput(data['data']);
      } else if (type === 'run') {
        // We are not using await because we don't want to block for the entire run duration
        this.session.handleRunEditorCode(data['code'], data['preMessage']);
      } else if (type === 'reset') {
        try {
          await this.session.handleReset();
        } catch (err) {
          console.error('Reset failed:', err);
          this.session.sendError('Reset failed, please try again');
        }
      } else if (type === 'stop') {
        this.session.handleStopCode();
      }
    });
  }

  async handleDisconnection() {
    // If there is no padSession or if padSession is a Promise ("thenable" check)
    // return early
    if (!this.session || typeof this.session.then === 'function') return;

    // Last socket is gone, but keep the PTY/session until sleepAfter SIGTERM
    // so a reconnect in that window can reuse the same REPL
    if (wss.clients.size === 0) {
      clearTimeout(this.activityTimeout);
    }
  }

  #tearDownSession() {
    if (!this.session || typeof this.session.then === 'function') return;

    this.session.isShuttingDown = true;
    clearTimeout(this.activityTimeout);

    this.session.cleanUpPtyProcesses();

    if (this.session.runStream) {
      this.ptyManager.killOneOffProcess(this.session.runStream);
    }

    this.session = null;
  }

  #onProcessStop() {
    // SIGTERM = sleepAfter / container stop; SIGINT = Ctrl+C.
    // Node must exit here or Cloudflare cannot actually stop the VM.
    this.#tearDownSession();
    process.exit(0);
  }
}

new ReplServer();

// Catch Promise rejections that are never caught
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection: ', reason);
});

// Catch synchronous throws that are never caught
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception: ', err);
});