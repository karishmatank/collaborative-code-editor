import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const terminalElement = document.getElementById('terminal');
const runBtn = document.getElementById('run-btn');
const stopBtn = document.getElementById('stop-btn');

class CodeExecutionManager {
  constructor(terminal) {
    this.serverUrl = null;
    this.ws = null;
    this.terminal = terminal;
  }

  connect(padId, initialLanguage) {
    const queryString = `?padId=${padId}&language=${initialLanguage}`;
    this.serverUrl = import.meta.env.VITE_EXECUTION_WS_URL + queryString;
    this.ws = new WebSocket(this.serverUrl);

    // Event listeners on messages we can receive from the server
    this.ws.addEventListener('error', (err) => {
      console.error('Connection error:', err);
    });

    this.ws.addEventListener('close', () => {
      console.log('Disconnected');
    });

    this.ws.addEventListener('message', (event) => {
      const { type, data } = JSON.parse(event.data);
      if (type === 'output') {
        this.terminal.write(data);
      } else if (type === 'runTriggered') {
        runBtn.hidden = true;
        stopBtn.hidden = false;
      } else if (type === 'stopTriggered' || type === 'runFinished') {
        runBtn.hidden = false;
        stopBtn.hidden = true;
      } else if (type === 'reset') {
        this.terminal.reset();
      }
    });

    this.ws.addEventListener('open', () => {
      console.log('WebSocket connection open');
    });

    // Event listeners on user input to the REPL
    this.terminal.onData((data) => {
      this.sendReplInput(data);
    });
  }

  disconnect() {
    this.ws?.close();
  }

  changeLanguage(newLanguage) {
    this.ws.send(JSON.stringify({ 'type': 'languageChange', 'language': newLanguage }));
  }

  sendReplInput(input) {
    this.ws.send(JSON.stringify({ 'type': 'input', 'data': input }));
  }

  runEditorCode(code) {
    this.ws.send(JSON.stringify({ 'type': 'run', 'code': code }));
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