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
  console.log('\n--- Test 2: oneOffExecuteCode ---');

  // Minimal padSession stub — only the fields oneOffExecuteCode uses
  let capturedOutput = '';
  const padSession = {
    container,
    language: 'python',
    runStream: null,
    storeAndSendOutput: (output) => { capturedOutput += output; },
  };

  await dockerManager.oneOffExecuteCode(padSession, 'print("hello from one-off")');
  console.log('oneOffExecuteCode produces correct output: ', capturedOutput.includes('hello from one-off') ? pass() : fail());
  console.log('runStream is null after completion: ', padSession.runStream === null ? pass() : fail());

  // --- Test 3: oneOffExecuteCode times out for infinite loop ---
  console.log('\n--- Test 3: oneOffExecuteCode timeout ---');
  capturedOutput = '';
  await dockerManager.oneOffExecuteCode(padSession, 'while True: pass');
  console.log('Execution timed out: ', capturedOutput.includes('Execution timed out!') ? pass() : fail());

  // --- Test 4: killContainer is resilient if container is already stopped ---
  console.log('\n--- Test 4: killContainer on already-stopped container ---');
  // Stop the container manually first, then killContainer should not throw
  await container.stop().catch(() => {}); // stop without remove
  let killError = null;
  try {
    await dockerManager.killContainer(container);
  } catch (err) {
    killError = err;
  }
  console.log('killContainer does not throw on already-stopped container: ', killError === null ? pass() : fail());

  // --- Test 5: createAndStartContainer retries on failure ---
  // Use a DockerManager with a nonexistent image so every attempt fails immediately.
  // With maxRetries=3 and delays of 500/1000/1500ms, total wait >= 3000ms.
  // If retries happen, the elapsed time will be well above 1000ms.
  // If no retries, it would fail in under 200ms.
  console.log('\n--- Test 5: createAndStartContainer retries (timing-based) ---');
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

  // --- Test 6: createPtyProcess fails on a dead container ---
  console.log('\n--- Test 6: createPtyProcess on dead container ---');
  const deadContainer = await dockerManager.createAndStartContainer();
  await dockerManager.killContainer(deadContainer);
  let ptyError = null;
  try {
    await dockerManager.createPtyProcess(deadContainer, 'python');
  } catch (err) {
    ptyError = err;
  }
  console.log('createPtyProcess throws after retries on dead container: ', ptyError !== null ? pass() : fail());

  // --- Test 7: oneOffExecuteCode fails on a dead container ---
  console.log('\n--- Test 7: oneOffExecuteCode on dead container ---');
  const deadContainer2 = await dockerManager.createAndStartContainer();
  await dockerManager.killContainer(deadContainer2);
  let execError = null;
  const deadPadSession = {
    container: deadContainer2,
    language: 'python',
    runStream: null,
    storeAndSendOutput: () => {},
  };
  try {
    await dockerManager.oneOffExecuteCode(deadPadSession, 'print("hi")');
  } catch (err) {
    execError = err;
  }
  console.log('oneOffExecuteCode throws after retries on dead container: ', execError !== null ? pass() : fail());

  console.log('\nAll tests complete.');
})();