"use strict";

/*
Simple tests for docker.js

To run:
node --env-file=.env test-docker.js
*/

import { DockerManager } from "./docker.js";

function pass() { return '\x1b[32mpassed\x1b[0m'; }
function fail() { return '\x1b[31mfailed\x1b[0m'; }
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Reads a Docker multiplexed (Tty: false) stream and returns the decoded text output.
// oneOffExecuteCode now returns a raw stream; output parsing is the caller's responsibility.
function readDockerStream(stream) {
  return new Promise((resolve, reject) => {
    let output = '';
    let buffer = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const frameSize = buffer.readUInt32BE(4);
        if (buffer.length < 8 + frameSize) break;
        output += buffer.subarray(8, 8 + frameSize).toString();
        buffer = buffer.subarray(8 + frameSize);
      }
    });
    stream.on('close', () => resolve(output));
    stream.on('error', reject);
  });
}

(async () => {
  const dockerManager = new DockerManager();

  // --- Test 1: container creation, PTY setup, and basic I/O ---
  console.log('\n--- Test 1: PTY smoke test ---');
  const container = await dockerManager.createAndStartContainer();
  console.log('Container created:', container.id);

  const stream = await dockerManager.createPtyProcess(container, 'python');
  console.log('PTY stream created');

  let ptyOutput = '';
  stream.on('data', chunk => { ptyOutput += String(chunk); });

  stream.write("print(1 + 1)\n");
  await delay(1000);
  console.log('PTY produces output: ', ptyOutput.includes('2') ? pass() : fail());

  dockerManager.killPtyProcess(stream);

  // --- Test 2: oneOffExecuteCode runs code and returns output ---
  // oneOffExecuteCode now returns a raw stream; output parsing and timeout are PadSession's job.
  console.log('\n--- Test 2: oneOffExecuteCode ---');
  const execStream = await dockerManager.oneOffExecuteCode(container, 'python', 'print("hello from one-off")');
  const execOutput = await readDockerStream(execStream);
  console.log('oneOffExecuteCode produces correct output: ', execOutput.includes('hello from one-off') ? pass() : fail());

  // --- Test 3: killContainer is resilient if container is already stopped ---
  console.log('\n--- Test 3: killContainer on already-stopped container ---');
  // Stop the container manually first, then killContainer should not throw
  await container.stop().catch(() => {}); // stop without remove
  let killError = null;
  try {
    await dockerManager.killContainer(container);
  } catch (err) {
    killError = err;
  }
  console.log('killContainer does not throw on already-stopped container: ', killError === null ? pass() : fail());

  // --- Test 4: createAndStartContainer retries on failure ---
  // Use a DockerManager with a nonexistent image so every attempt fails immediately.
  // With maxRetries=3 and delays of 500/1000/1500ms, total wait >= 3000ms.
  // If retries happen, the elapsed time will be well above 1000ms.
  // If no retries, it would fail in under 200ms.
  console.log('\n--- Test 4: createAndStartContainer retries (timing-based) ---');
  const badManager = new DockerManager();
  badManager.image = 'nonexistent-image-xyz:latest';
  const retryStart = Date.now();
  let retryError = null;
  try {
    await badManager.createAndStartContainer();
  } catch (err) {
    retryError = err;
  }
  const retryElapsed = Date.now() - retryStart;
  console.log('createAndStartContainer fails after retries: ', retryError !== null ? pass() : fail());
  console.log(`createAndStartContainer retried (elapsed ${retryElapsed}ms, expected >2500ms): `, retryElapsed > 2500 ? pass() : fail());

  // --- Test 5: createPtyProcess fails on a dead container ---
  console.log('\n--- Test 5: createPtyProcess on dead container ---');
  const deadContainer = await dockerManager.createAndStartContainer();
  await dockerManager.killContainer(deadContainer);
  let ptyError = null;
  try {
    await dockerManager.createPtyProcess(deadContainer, 'python');
  } catch (err) {
    ptyError = err;
  }
  console.log('createPtyProcess throws after retries on dead container: ', ptyError !== null ? pass() : fail());

  // --- Test 6: oneOffExecuteCode fails on a dead container ---
  console.log('\n--- Test 6: oneOffExecuteCode on dead container ---');
  const deadContainer2 = await dockerManager.createAndStartContainer();
  await dockerManager.killContainer(deadContainer2);
  let execError = null;
  try {
    await dockerManager.oneOffExecuteCode(deadContainer2, 'python', 'print("hi")');
  } catch (err) {
    execError = err;
  }
  console.log('oneOffExecuteCode throws after retries on dead container: ', execError !== null ? pass() : fail());

  console.log('\nAll tests complete.');
})();