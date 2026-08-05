"use strict";

import WebSocket, { WebSocketServer } from "ws";
import { DockerManager } from "./docker.js";

class PadSession {
  constructor(language, container, stream) {
    this.language = language;
    this.output = '';
    this.container = container;
    this.stream = null;
    this.runStream = null;
    this.users = new Set();

    this.switchStream(stream);
  }

  #broadcast(type, message, excludeUser) {
    let userList = Array.from(this.users);
    if (excludeUser) {
      userList = userList.filter(user => user !== excludeUser);
    }
    userList.forEach(user => {
      let msg = { 'type': type };
      if (message) {
        msg['data'] = message;
      }

      // Don't send to a client in the process of disconnecting
      if (user.readyState === WebSocket.OPEN) {
        user.send(JSON.stringify(msg));
      }
    });
  }

  handleInput(data, ws) {
    // // Broadcast the change to all other users
    // this.#broadcast('output', data, excludeUser=ws);

    // If REPL input has a newline, then it will automatically trigger code run
    // Too complex to set timeout here since it gets cleared prematurely in handleOutput
    // Otherwise, REPL will just accummulate input
    this.stream.write(data);
  }

  handleOutput() {
    // Broadcast output from stream to all users
    this.stream.on('data', (chunk) => {
      this.storeAndSendOutput(chunk.toString());
    });
  }

  storeAndSendOutput(output) {
    // Store output in session state
    this.output += output;

    // Broadcast incremental output to users
    this.#broadcast('output', output);
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
    this.stream = newStream;

    // Re-register event listener on new stream
    this.handleOutput();
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

  async #set_up_session(ws, padId, language) {
    if (!this.sessions.has(padId)) {
      // Start a new container
      const container = await this.dockerManager.createContainer();
      await this.dockerManager.startContainer(container);

      // Start a new pseudoterminal process
      const stream = await this.dockerManager.createPtyProcess(container, language);

      // Add to sessions map
      const padSession = new PadSession(language, container, stream);
      this.sessions.set(padId, padSession);
    }

    const padSession = this.sessions.get(padId);
    padSession.addUser(ws);
    ws.send(JSON.stringify({ type: 'ready' }));
    return padSession;
  }

  async handleConnection(ws, req) {
    // Parse URL for pad ID and language. Random base is fine, so I use localhost
    const url = new URL(req.url, 'http://localhost');
    const padId = url.searchParams.get('padId');
    const language = url.searchParams.get('language');

    // Set up the session data
    const padSession = await this.#set_up_session(ws, padId, language);

    // Register other event listeners
    ws.on('error', console.error);
    ws.on('close', async () => {
      await this.handleDisconnection(ws, padId);
    });
    ws.on('message', (data) => {
      data = JSON.parse(data);
      let type = data.type;
      if (type === 'languageChange') {
        this.handleLanguageChange(data['language'], padSession);
      } else if (type === 'input') {
        padSession.handleInput(data['data'], ws);
      } else if (type === 'run') {
        this.handleRunEditorCode(data['code'], padSession);
      } else if (type === 'reset') {
        this.handleReset(padSession);
      } else if (type === 'stop') {
        padSession.handleStopCode();
      }
    });
  }

  async handleDisconnection(ws, padId) {
    const padSession = this.sessions.get(padId);

    // Remove user from the set of users
    padSession.removeUser(ws);

    // If last user, destroy pty + container + delete session data
    if (padSession.userCount === 0) {
      this.dockerManager.killPtyProcess(padSession.stream);
      await this.dockerManager.killContainer(padSession.container);
      this.sessions.delete(padId);
    }
  }

  async handleLanguageChange(language, padSession) {
    // Update the language state
    padSession.changeLanguage(language);

    // Update output state
    padSession.resetOutput();

    // Kill the current pty process and start a new pty with the new language
    this.dockerManager.killPtyProcess(padSession.stream);
    const stream = await this.dockerManager.createPtyProcess(padSession.container, language);
    padSession.switchStream(stream);
  }

  async handleReset(padSession) {
    // Update output state
    padSession.resetOutput();

    // Kill the current pty process and start a new pty with the same language
    this.dockerManager.killPtyProcess(padSession.stream);
    const stream = await this.dockerManager.createPtyProcess(padSession.container, padSession.language);
    padSession.switchStream(stream);
  }

  async handleRunEditorCode(code, padSession) {
    // Clear anything in the buffer
    padSession.clearBuffer();

    // Broadcast message to rest of group to reflect run status in the UI
    padSession.sendRunStopTriggered('run');

    // Execute the one-off code
    try {
      await this.dockerManager.oneOffExecuteCode(padSession, code);
      padSession.storeAndSendOutput('\n');
    } catch (error) {
      console.log(error);
    }    
  }
}

new ReplServer();