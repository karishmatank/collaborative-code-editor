const outputEmpty = document.getElementById('output-empty');
const outputPopulated = document.getElementById('output-populated');
const outputContent = document.getElementById('output-content');
const iframe = document.getElementById('html-preview');
const resetBtn = document.getElementById('reset-btn');

function switchToPopulatedPane() {
  outputEmpty.hidden = true;
  outputPopulated.hidden = false;
}

function switchToEmptyPane() {
  outputEmpty.hidden = false;
  outputPopulated.hidden = true;
}

export function setOutputContent(content) {
  if (!content) {
    // switchToEmptyPane();
    outputContent.textContent = '';
  } else {
    // switchToPopulatedPane();
    outputContent.textContent += content;
  }
}

export function initializeOutput() {
  // Observe textContent changes in outputContent 
  // to figure out if we switch to the empty or populated panes
  // Can't set a traditional event listener on textContent though
  const outputContentObserver = new MutationObserver(changes => {
    changes.forEach((change) => {
      if (change.type !== 'childList' && change.type !== 'characterData') return;
      if (outputContent.textContent === '') {
        switchToEmptyPane();
      } else {
        switchToPopulatedPane();
      }
    });
  });

  outputContentObserver.observe(outputContent, {
    childList: true, // Additions and removals of child nodes, such as text nodes
    characterData: true // Monitors changes in text content inside nodes
  });

  // Set an event listener on the window to listen for 'message' events
  // This is relevant when we are in HTML mode and may have our iframe intercept 
  // console.log statements so that we can display in our output as well
  window.addEventListener('message', event => {
    // Added for security
    if (event.source !== iframe.contentWindow) return;

    if (event.data.type === 'console') {
      const argsString = event.data.args.join(' ');

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
    const serialize = (arg) => {
      if (arg instanceof Element) {
        return arg.outerHTML;
      }
      if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg); 
        }
      }
      return String(arg);  
    };

    const _log = console.log;
    console.log = (...args) => {
      window.parent.postMessage({ type: 'console', level: 'log', args: args.map(serialize) }, '*');
      _log(...args);  
    };

    const _error = console.error;
    console.error = (...args) => {
      window.parent.postMessage({ type: 'console', level: 'error', args: args.map(serialize) }, '*');
      _error(...args);
    };

    const _warn = console.warn;
    console.warn = (...args) => {
      window.parent.postMessage({ type: 'console', level: 'warn', args: args.map(serialize) }, '*');
      _warn(...args);  
    };

    window.addEventListener('error', (event) => {
      window.parent.postMessage({
        type: 'console',
        level: 'error',
        args: [event.message]
      }, '*');
    });
  <\/script>`;

  const injected = content.replace('<head>', '<head>' + interceptScript);
  iframe.srcdoc = injected;

  // Clear output content before next render
  outputContent.textContent = '';
}