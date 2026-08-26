import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const HEARTBEAT = 30 * 1000; // 30s
const IDLE_CLOSE_CODE = 4000;
const MAX_RECONNECTION_RETRIES = 3;
const RECONNECTION_DELAY_MS = 500;

const terminalElement = document.getElementById('terminal');
const runBtn = document.getElementById('run-btn');
const stopBtn = document.getElementById('stop-btn');
const loadingSpinner = document.getElementById('spinner-loading-terminal');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class CodeExecutionManager {
  constructor(terminal) {
    this.serverUrl = null;
    this.ws = null;
    this.terminal = terminal;
    this.heartbeatInterval = null;
    this.intentionalClose = false;
    this.padId = null;
    this.currentLanguage = null;
    this.reconnectAttempts = 0;

    this.registerTerminalEvents();
  }

  registerTerminalEvents() {
    // Event listeners on user input to the REPL
    this.terminal.onData((data) => {
      this.sendReplInput(data);
    });
  }

  connect(padId, language) {
    this.padId = padId;
    this.currentLanguage = language;

    this.intentionalClose = false;
    const queryString = `?padId=${padId}&language=${language}`;
    this.serverUrl = import.meta.env.VITE_EXECUTION_WS_URL + queryString;
    this.ws = new WebSocket(this.serverUrl);

    // Event listeners on messages we can receive from the server
    this.ws.addEventListener('error', (err) => {
      console.error('Connection error:', err);
    });

    this.ws.addEventListener('close', async (event) => {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;

      console.info('Execution WS closed', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        intentionalClose: this.intentionalClose,
        shouldReconnect: !this.intentionalClose && event.code !== IDLE_CLOSE_CODE,
      });

      // Clean exit if client intentially closed the tab (called the disconnect method)
      if (this.intentionalClose) {
        return;
      }

      // Message to terminal if idle close
      if (event.code === IDLE_CLOSE_CODE) {
        this.terminal.write('\r\n\x1b[101m\x1b[97m You are not around, so we have closed the connection. Please refresh when you get back! \x1b[0m\r\n');
        return;
      }

      this.terminal.write('\r\n\x1b[101m\x1b[97m Trying to reconnect, please wait... \x1b[0m\r\n');

      // Otherwise, we should reconnect
      if (this.reconnectAttempts > MAX_RECONNECTION_RETRIES) {
        this.terminal.write('\r\n\x1b[101m\x1b[97m Disconnected from server, please refresh the page! \x1b[0m\r\n');
        return;
      }
      this.reconnectAttempts += 1;
      await delay(RECONNECTION_DELAY_MS);
      this.connect(this.padId, this.currentLanguage);
      
    });

    this.ws.addEventListener('message', (event) => {
      const { type, data } = JSON.parse(event.data);
      if (type === 'output') {
        this.terminal.write(data);
        loadingSpinner.hidden = true;
      } else if (type === 'runTriggered') {
        runBtn.hidden = true;
        stopBtn.hidden = false;
      } else if (type === 'stopTriggered' || type === 'runFinished') {
        runBtn.hidden = false;
        stopBtn.hidden = true;
      } else if (type === 'reset') {
        this.terminal.reset();
        loadingSpinner.hidden = false;
      } else if (type === 'error') {
        this.terminal.write('\r\n' + data + '\r\n');
        loadingSpinner.hidden = true;
      } else if (type === 'ready') {
        loadingSpinner.hidden = true;
      }
    });

    this.ws.addEventListener('open', () => {
      console.log('WebSocket connection open');

      // Reset anything previously in the terminal, for example if user reconnected
      this.terminal.reset();

      // Reset reconnection attempt counter
      this.reconnectAttempts = 0;

      // Set up heartbeat to keep connnection alive
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ 'type': 'ping' }));
        }
      }, HEARTBEAT);
    });
  }

  disconnect() {
    this.intentionalClose = true;
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
    this.ws?.close();
  }

  changeLanguage(newLanguage) {
    this.currentLanguage = newLanguage;
    this.ws.send(JSON.stringify({ 'type': 'languageChange', 'language': newLanguage }));
  }

  sendReplInput(input) {
    this.ws.send(JSON.stringify({ 'type': 'input', 'data': input }));
  }

  runEditorCode(code, preMessage) {
    this.ws.send(JSON.stringify({ 'type': 'run', 'code': code, 'preMessage': preMessage }));
  }

  reset() {
    this.terminal.reset();
    this.ws.send(JSON.stringify({ 'type': 'reset' }));
  }

  stopCodeExecution() {
    this.ws.send(JSON.stringify({ 'type': 'stop' }));
  }

}

export function showTerminalUI() {
  terminalElement.hidden = false;
}

export function hideTerminalUI() {
  terminalElement.hidden = true;
}

export function initializeTerminal() {
  // Initialize xterm.js
  const term = new Terminal({
    fontSize: 14,
    cursorBlink: true,
  });
  const fitAddOn = new FitAddon();

  term.loadAddon(fitAddOn);
  term.open(terminalElement);
  fitAddOn.fit();

  // Re-fit the terminal whenever it is resized
  const resizeObserver = new ResizeObserver(() => {
    fitAddOn.fit();
  });
  resizeObserver.observe(terminalElement);

  // Initialize class
  const codeExec = new CodeExecutionManager(term);
  return codeExec;
}