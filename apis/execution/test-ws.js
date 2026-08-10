"use strict";

/*
Simple tests for WebSocket connection

To run:
node --env-file=.env test-ws.js
*/

import { ReplServer } from "./websocket.js";
import WebSocket from "ws";

// ***** TESTING HELPERS *****
function pass() {
  return '\x1b[32mpassed\x1b[0m ';
}
function fail() {
  return '\x1b[31mfailed\x1b[0m ';
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Testing start
const server = new ReplServer();

// Test: two clients connect to the same padId simultaneously — race condition fix
// Both should get 'ready', and only a single PadSession (not a Promise) should be in the map
console.log('Concurrent connections: starting...');
const [wsConcurrent1, wsConcurrent2] = [
  new WebSocket('ws://localhost:8000?padId=concurrent-test&language=python'),
  new WebSocket('ws://localhost:8000?padId=concurrent-test&language=python'),
];
const bothConnected = await Promise.all([wsConcurrent1, wsConcurrent2].map(w =>
  new Promise((resolve, reject) => {
    w.on('message', (data) => {
      if (JSON.parse(data).type === 'ready') resolve();
    });
    w.on('error', (err) => reject(err));
    setTimeout(() => reject(new Error('Timed out waiting for ready')), 10000);
  })
)).then(() => true).catch(() => false);

console.log('Concurrent connections: both clients received ready: ', bothConnected ? pass() : fail());
const concurrentSession = server.sessions.get('concurrent-test');
// If the race condition fix is working, both clients share the same PadSession → userCount === 2.
// Without the fix, each client gets its own session and the map only holds the last one → userCount === 1.
console.log('Concurrent connections: both users are in the same session: ', bothConnected && concurrentSession && concurrentSession.userCount === 2 ? pass() : fail());
wsConcurrent1.close();
wsConcurrent2.close();
await delay(1000); // let disconnection handlers finish

// Connect to the server
const ws = new WebSocket('ws://localhost:8000?padId=123&language=python');

// Logic for errors and close
ws.on('error', (err) => {
  console.error('Connection error:', err);
});
ws.on('close', () => {
  setTimeout(() => {
    console.log('Disconnected');
    console.log('Session after disconnect: ', server.sessions.has('123') === false ? pass() : fail());
    server.wss.close(); // Close the WebSocket connection, for testing only
  }, 1000);
});

ws.on('message', async (data) => {
  try {
    const message = JSON.parse(data);

    if (message.type === 'ready') {
      console.log('Session is ready!');

      // Check that there is a valid PadSession for the padId
      console.log('Checking pad session info...');
      console.log('Session after connect: ', server.sessions.has('123') === true ? pass() : fail());

      const padSession = server.sessions.get('123');
      await delay(500);

      // Successful language switch
      console.log('Output has Python startup: ', padSession.output.includes('Python 3.') === true ? pass() : fail());
      ws.send(JSON.stringify({ 'type': 'languageChange', 'language': 'javascript' }));
      await delay(500);
      console.log('Output does not have Python startup: ', padSession.output.includes('Python 3.') === false ? pass() : fail());
      console.log('Output has JavaScript startup: ', padSession.output.includes('Node.js v') === true ? pass() : fail());
      await delay(500);

      // User types into terminal and presses Enter. Code should run
      ws.send(JSON.stringify({ 'type': 'input', 'data': 'c' }));
      ws.send(JSON.stringify({ 'type': 'input', 'data': 'o' }));
      ws.send(JSON.stringify({ 'type': 'input', 'data': 'nsole.log("hello");' }));
      ws.send(JSON.stringify({ 'type': 'input', 'data': '\n' }));
      // This should trigger an 'output' message, so we'll create another event listener
      let outputReceived = new Promise((resolve) => {
        const handler = (json) => {
          const { type, data } = JSON.parse(json);
          if (type === 'output' && data.includes('> ')) {
            ws.off('message', handler);
            resolve();
          }
        }
        ws.on('message', handler);
      });
      await outputReceived;
      let fullOutput = padSession.output;
      console.log('Output contains full input and output: ', fullOutput.includes('console.log("hello");\r\r\nhello\r\n') ? pass() : fail());

      // User passes code from "editor" to run
      ws.send(JSON.stringify({ 'type': 'run', 'code': 'console.log("2");\n\nconsole.log("3");' }));
      await delay(2000);
      console.log('Output contains 2:', padSession.output.includes('2') ? pass() : fail());
      console.log('Output contains 3:', padSession.output.includes('3') ? pass() : fail());

      // Test code taking too long
      ws.send(JSON.stringify({ 'type': 'run', 'code': 'while(true) {}' }));
      await delay(16000);
      console.log('Output times out (run code): ', padSession.output.includes('Execution timed out!') ? pass() : fail());

      // Test user reset
      ws.send(JSON.stringify({ 'type': 'reset' }));
      await delay(2000);
      console.log(
        'Output was reset: ', 
        (
          padSession.output.startsWith("Welcome to Node.js v") && 
          padSession.output.endsWith("\r\nType \".help\" for more information.\r\n\u001b[1G\u001b[0J> \u001b[3G")
        ) ? pass() : fail()
      );

      // Test stopping editor code from running
      ws.send(JSON.stringify({ 'type': 'input', 'data': 'console.log(1);\n' }));
      await delay(500);
      ws.send(JSON.stringify({ 'type': 'run', 'code': 'while(true) {}' }));
      await delay(2000);
      ws.send(JSON.stringify({ 'type': 'stop' }));
      await delay(2000);
      console.log('Output shows code execution stopped: ', padSession.output.includes('Code execution stopped!') ? pass() : fail());

      // Test sending non JSON message — server should stay alive and session should still work
      ws.send('this is not json');
      await delay(500);
      // If the server crashed, this next run would fail. Verify the session is still alive
      ws.send(JSON.stringify({ 'type': 'run', 'code': 'console.log("still alive");' }));
      await delay(2000);
      console.log('Output contains "still alive":', padSession.output.includes('still alive') ? pass() : fail());

      // Test: switch to an unsupported language — server should send back an error message
      let errorFromBadLanguage = new Promise((resolve) => {
        const handler = (json) => {
          const { type, data } = JSON.parse(json);
          if (type === 'error') {
            ws.off('message', handler);
            resolve(data);
          }
        };
        ws.on('message', handler);
        setTimeout(() => resolve(null), 5000); // timeout if no error arrives
      });
      ws.send(JSON.stringify({ 'type': 'languageChange', 'language': 'badlang' }));
      const errorMsg = await errorFromBadLanguage;
      console.log('Invalid language change sends error to client: ', errorMsg.includes('Language change failed, please try again') ? pass() : fail());

      // Unwind everything
      ws.close();
    }
  } catch (error) {
    console.error(error);
    // Unwind everything
    ws.close();
  }
  
});
