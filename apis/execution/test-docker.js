"use strict";

/*
Simple tests for docker.js
*/

import { DockerManager } from "./docker.js";

(async () => {
  const dockerManager = new DockerManager();

  console.log('Creating container...');
  const container = await dockerManager.createContainer();
  console.log('Container created:', container.id);

  console.log('Starting container...');
  await dockerManager.startContainer(container);
  console.log('Container started!');

  console.log('Creating PTY process...');
  const stream = await dockerManager.createPtyProcess(container, 'python');
  console.log('Stream created: ', stream);

  stream.on('data', chunk => {
    console.log('Output received: ', String(chunk));
  });

  // Produce output
  stream.write("print(1 + 1)\n");
  stream.write("print('Hello')\n");

  setTimeout(async () => {
    console.log('Killing PTY...');
    dockerManager.killPtyProcess(stream);
    console.log('Killed PTY');
    console.log('Killing container...');
    await dockerManager.killContainer(container);
    console.log('Done')
  }, 5000);
})();