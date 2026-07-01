const outputEmpty = document.getElementById('output-empty');
const outputPopulated = document.getElementById('output-populated');
const outputContent = document.getElementById('output-content');
const iframe = document.getElementById('html-preview');
const resetBtn = document.getElementById('reset-btn');

function switchToPopulatedPane() {
  outputEmpty.hidden = true;
  outputContent.textContent = '';
  outputPopulated.hidden = false;
}

function switchToEmptyPane() {
  outputEmpty.hidden = false;
  outputContent.textContent = '';
  outputPopulated.hidden = true;
}

function initializeResetBtn() {
  resetBtn.addEventListener('click', switchToEmptyPane);
}

export function initializeOutput() {
  initializeResetBtn();

  // If language is changed to HTML, then change our populated output to be viewed all the time
  document.getElementById('language-select').addEventListener('change', event => {
    if (event.target.value === 'html') {
      switchToPopulatedPane();
      resetBtn.hidden = true;
    } else {
      switchToEmptyPane();
      resetBtn.hidden = false;
    }
  });

  // Set an event listener on the window to listen for 'message' events
  // This is relevant when we are in HTML mode and may have our iframe intercept 
  // console.log statements so that we can display in our output as well
  window.addEventListener('message', event => {
    // Added for security
    if (event.source !== iframe.contentWindow) return;

    if (event.data.type === 'console') {
      const argsString = event.data.args.map(arg => {
        if (typeof arg === 'object') {
          return JSON.stringify(arg);
        }
        return String(arg);
      }).join(' ');

      const line = document.createElement('span');
      line.classList.add(`console-${event.data.level}`);
      line.textContent = argsString + '\n';
      outputContent.appendChild(line);
    }
  });
}

export function renderIFrame(content) {
  // HTML only
  // Intercept script intercepts any code that would appear in the browser console
  // so that it is sent to our parent app as well to be displayed in the output
  const interceptScript = `<script>
    const _log = console.log;
    console.log = (...args) => {
      window.parent.postMessage({ type: 'console', level: 'log', args }, '*');
      _log(...args);  
    };

    const _error = console.error;
    console.error = (...args) => {
      window.parent.postMessage({ type: 'console', level: 'error', args }, '*');
      _error(...args);
    };

    const _warn = console.warn;
    console.warn = (...args) => {
      window.parent.postMessage({ type: 'console', level: 'warn', args }, '*');
      _warn(...args);  
    };

    window.addEventListener('error', (event) => {
      window.parent.postMessage({
        type: 'console',
        level: 'error',
        args: [event.message + ' (line ' + event.lineno + ')']
      }, '*');
    });
  <\/script>`;

  const injected = content.replace('<head>', '<head>' + interceptScript);
  iframe.srcdoc = injected;

  // Clear output content before next render
  outputContent.textContent = '';
}