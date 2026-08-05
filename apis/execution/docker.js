"use strict";

import Docker from "dockerode";

const LANGUAGE_RUNTIMES = {
  'python': 'python3',
  'ruby': 'irb',
  'javascript': 'node',
  'typescript': 'tsx',
  'sql': 'psql'
}

const LANGUAGE_FLAGS = {
  'python': '-c',
  'ruby': '-e',
  'javascript': '-e',
  'typescript': '--eval'
}

const MAX_RUN_DURATION = 10000; // 10s

export class DockerManager {
  constructor() {
    this.docker = new Docker();
    this.image = 'spot-editor:latest';
  }

  createContainer() {
    return this.docker.createContainer({
      Image: this.image,
      Tty: true,
      OpenStdin: true,
      StdinOnce: false
    });
  }

  startContainer(container) {
    return container.start();
  }

  async killContainer(container) {
    await container.kill();

    // Free up memory
    await container.remove();
  }

  async createPtyProcess(container, language) {
    const exec = await container.exec({
      Cmd: [LANGUAGE_RUNTIMES[language]],
      Tty: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true
    });
    return exec.start({
      hijack: true,
      stdin: true,
      Tty: true
    });
  }

  killPtyProcess(stream) {
    stream.destroy();
  }

  async oneOffExecuteCode(padSession, code) {
    const container = padSession.container;
    const language = padSession.language;

    // Keep track of chunk sequence for formatting purposes
    let firstChunk = true;
    const onReceipt = (data) => {
      if (firstChunk) {
        data = '\n\n' + data;
      } 
      padSession.storeAndSendOutput(data);
      firstChunk = false;
    };

    // Keep track of how stream was ended
    // If true, stream naturally ended after code finished executing
    // If false, stream was destroyed elsewhere
    let ended = false;

    const exec = await container.exec({
      Cmd: [LANGUAGE_RUNTIMES[language], LANGUAGE_FLAGS[language], code],
      Tty: false,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true
    });
    const stream = await exec.start({
      Detach: false
    });
    padSession.runStream = stream;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        onReceipt('\nExecution timed out!');
        stream.destroy();
        padSession.runStream = null;
        resolve();
      }, MAX_RUN_DURATION);

      stream.on('data', (chunk) => {
        // Strip out the 8-byte header
        const output = chunk.slice(8).toString();

        // Broadcast
        onReceipt(output);
      });

      stream.on('end', () => {
        ended = true;
        padSession.sendRunFinished();
      });

      stream.on('close', () => {
        // If we have separately closed the stream (i.e. user pressed the "Stop" button)
        if (!ended) {
          onReceipt('\nCode execution stopped!');
        }
        clearTimeout(timeout);
        resolve();
      });

      stream.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}